-- =============================================================================
-- JimoCex — 020_fill_settlement
--
-- Atomic application of an external execution FILL to an internal order and the
-- ledger (spec §19; docs/settlement-spec.md; Slice 6B).
--
-- Migration numbering: 019 is reserved for the reviewed table-privileges draft
-- (supabase/drafts/019_table_privileges.sql, the "019 profile"). This is the
-- next real migration after 018, so it takes 020.
--
-- PROVIDER-NEUTRAL. This function records and settles a fill reported by
-- whatever execution venue is connected. It names no provider and assumes no
-- provider API. No venue is connected in this repository, so nothing calls
-- apply_fill yet: it is the settlement primitive the ExecutionService
-- (src/lib/execution) will call once a concrete LP adapter exists, and it is
-- deliberately NOT wired into the Order Engine in this slice.
--
-- ATOMIC: one transaction or nothing. Insert the trade, post the ledger entries
-- and update the order together; any failure rolls the whole call back, so a
-- fill is never partially applied.
--
-- Reuses the money core, does not reinvent it:
--   * every balance move goes through ledger_post() — the one writer — so the
--     per-wallet lock, the overdraft / NaN / scale refusal and the dedup_key
--     guard all apply unchanged;
--   * trades.provider_trade_id (UNIQUE) is the AUTHORITATIVE fill-idempotency
--     key: a replayed fill inserts no second trade and posts no second ledger
--     entry;
--   * the order's reservation (the HOLD from place_limit_order) is drawn down,
--     never exceeded, and any residual is RELEASEd when the order completes
--     (BUY price improvement / fee over-reservation).
--
-- FEE SOURCE POLICY REMAINS DEFERRED until the concrete execution venue
-- semantics are available (docs/settlement-spec.md §7.4). apply_fill does NOT
-- compute a fee and does NOT call the FeeEngine. The fee is a SERVER-TRUSTED
-- EXECUTION INPUT: validated (non-negative, finite, denominated in the quote
-- asset, covered by the reservation) and recorded — nothing more. It can never
-- come from a browser: apply_fill is service_role-only.
--
-- KNOWN LIMITATION (settlement-spec gap G2): the reservation model holds the BUY
-- fee in the quote asset and takes the SELL fee from the quote proceeds, so the
-- fee must be denominated in the pair's QUOTE asset. A fee in the base asset or
-- a third asset is REFUSED rather than mis-settled.
--
-- SCOPE: a LIMIT order that rests OPEN with its funds held (migration 018) is
-- settled here against actual, provider-reported fills. No MARKET execution, no
-- matching engine, no fabricated fill.
-- =============================================================================

create or replace function public.apply_fill(
  p_order_id          uuid,
  p_provider_trade_id text,
  p_base_amount       numeric,
  p_quote_amount      numeric,
  p_execution_price   numeric,
  p_fee_amount        numeric,
  p_fee_asset_id      uuid,
  p_executed_at       timestamptz default now()
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order       public.trading_orders;
  v_pair        public.trading_pairs;
  v_existing    uuid;
  v_trade_id    uuid;
  v_base_asset  uuid;
  v_quote_asset uuid;
  v_consumed    numeric;   -- drawn from the order's locked reserve this fill
  v_new_locked  numeric;   -- the order's remaining reserve after this fill
  v_new_filled  numeric;
  v_new_status  public.order_status;
  v_vwap        numeric;
  v_completes   boolean;
begin
  -- 1. Lock the order so two different fills on the same order serialize here;
  -- the second re-reads the committed filled_amount and validates against it.
  select * into v_order from public.trading_orders where id = p_order_id for update;
  if v_order.id is null then
    raise exception 'apply_fill: unknown order %', p_order_id using errcode = 'foreign_key_violation';
  end if;

  -- 2. Idempotency FIRST, before any amount validation: a fill already applied
  -- returns its existing trade and changes nothing. Checking the cumulative
  -- amount before this point would wrongly reject a legitimate replay.
  if p_provider_trade_id is null or length(p_provider_trade_id) = 0 then
    raise exception 'apply_fill: provider_trade_id is required' using errcode = 'check_violation';
  end if;
  select id into v_existing from public.trades where provider_trade_id = p_provider_trade_id;
  if v_existing is not null then
    return v_existing;
  end if;

  -- 3. The order must be live. A terminal order rejects a NEW fill (a duplicate
  -- would have returned in step 2).
  if v_order.status in ('FILLED', 'CANCELLED', 'REJECTED', 'EXPIRED') then
    raise exception 'apply_fill: order % is % and cannot take a new fill', p_order_id, v_order.status
      using errcode = 'restrict_violation';
  end if;

  -- 4. Validate the fill figures. NaN is checked explicitly: in PostgreSQL
  -- numeric, NaN sorts GREATER than every number, so `<= 0` would not catch it
  -- and it would slip past ledger_post and the wallet >= 0 CHECKs. (Infinity is
  -- rejected by the numeric(38,18) columns on insert.)
  if p_base_amount is null or p_base_amount = 'NaN'::numeric or p_base_amount <= 0 then
    raise exception 'apply_fill: base amount must be a positive number, got %', p_base_amount using errcode = 'check_violation';
  end if;
  if p_quote_amount is null or p_quote_amount = 'NaN'::numeric or p_quote_amount <= 0 then
    raise exception 'apply_fill: quote amount must be a positive number, got %', p_quote_amount using errcode = 'check_violation';
  end if;
  if p_execution_price is null or p_execution_price = 'NaN'::numeric or p_execution_price <= 0 then
    raise exception 'apply_fill: execution price must be a positive number, got %', p_execution_price using errcode = 'check_violation';
  end if;
  if p_fee_amount is null or p_fee_amount = 'NaN'::numeric or p_fee_amount < 0 then
    raise exception 'apply_fill: fee must be a non-negative number, got %', p_fee_amount using errcode = 'check_violation';
  end if;

  -- 5. No over-fill.
  if v_order.filled_amount + p_base_amount > v_order.amount then
    raise exception 'apply_fill: fill of % exceeds order % remaining (% of %)',
      p_base_amount, p_order_id, v_order.amount - v_order.filled_amount, v_order.amount
      using errcode = 'check_violation';
  end if;

  -- 6. Resolve the pair's assets and enforce the fee-asset limitation (G2).
  select * into v_pair from public.trading_pairs where id = v_order.pair_id;
  v_base_asset  := v_pair.base_asset_id;
  v_quote_asset := v_pair.quote_asset_id;
  if p_fee_amount > 0 and (p_fee_asset_id is null or p_fee_asset_id <> v_quote_asset) then
    raise exception 'apply_fill: the fee must be denominated in the pair quote asset %', v_quote_asset
      using errcode = 'check_violation',
            hint = 'The reservation model only covers a quote-denominated fee (settlement-spec gap G2).';
  end if;

  -- 7. Coarse price/quote sanity check (NOT a recompute): reject a grossly
  -- inconsistent report, e.g. price and quote transposed. base and quote are
  -- venue-authoritative and used as-is; execution_price is recorded for display.
  if abs(p_execution_price * p_base_amount - p_quote_amount)
       > greatest(p_execution_price * p_base_amount, p_quote_amount) * 0.01 then
    raise exception 'apply_fill: quote % is inconsistent with price % x base %',
      p_quote_amount, p_execution_price, p_base_amount
      using errcode = 'check_violation';
  end if;

  v_new_filled := v_order.filled_amount + p_base_amount;
  v_completes  := v_new_filled = v_order.amount;

  -- 8. Insert the trade, settled in this same transaction. ON CONFLICT guards a
  -- concurrent duplicate (same provider_trade_id arriving twice at once): the
  -- loser inserts nothing, posts nothing, and returns the winner's trade.
  insert into public.trades (
    pair_id, buy_order_id, sell_order_id, price, amount, quote_amount,
    fee, fee_asset_id, provider_trade_id, settled_at
  )
  values (
    v_order.pair_id,
    case when v_order.side = 'BUY'  then p_order_id end,
    case when v_order.side = 'SELL' then p_order_id end,
    p_execution_price, p_base_amount, p_quote_amount,
    p_fee_amount, p_fee_asset_id, p_provider_trade_id, now()
  )
  on conflict (provider_trade_id) do nothing
  returning id into v_trade_id;

  if v_trade_id is null then
    select id into v_trade_id from public.trades where provider_trade_id = p_provider_trade_id;
    return v_trade_id;
  end if;

  -- 9. Post the ledger entries and draw down the reserve, by side. Dedup keys
  -- are deterministic and distinct per posting, derived from the authoritative
  -- provider_trade_id, so a retry cannot duplicate a money movement.
  if v_order.side = 'BUY' then
    -- Reserved QUOTE = notional + fee; both the cost and the fee leave the hold.
    v_consumed := p_quote_amount + p_fee_amount;
    if v_consumed > v_order.locked_amount then
      raise exception 'apply_fill: BUY fill consumes % quote but only % is reserved',
        v_consumed, v_order.locked_amount using errcode = 'check_violation';
    end if;
    perform public.ledger_post(v_order.user_id, v_quote_asset, 'TRADE', p_quote_amount,
      0, -p_quote_amount, 'trade', v_trade_id, 'trade:fill:' || p_provider_trade_id || ':quote',
      jsonb_build_object('order', p_order_id::text, 'base', p_base_amount::text, 'price', p_execution_price::text));
    if p_fee_amount > 0 then
      perform public.ledger_post(v_order.user_id, v_quote_asset, 'TRADE_FEE', p_fee_amount,
        0, -p_fee_amount, 'trade', v_trade_id, 'trade:fill:' || p_provider_trade_id || ':fee', '{}'::jsonb);
    end if;
    perform public.ledger_post(v_order.user_id, v_base_asset, 'TRADE', p_base_amount,
      p_base_amount, 0, 'trade', v_trade_id, 'trade:fill:' || p_provider_trade_id || ':base', '{}'::jsonb);
    v_new_locked := v_order.locked_amount - v_consumed;
  else -- SELL
    -- Reserved BASE = amount; the base delivered leaves the hold, the quote
    -- proceeds arrive, and the fee is taken from those proceeds.
    v_consumed := p_base_amount;
    if v_consumed > v_order.locked_amount then
      raise exception 'apply_fill: SELL fill delivers % base but only % is reserved',
        v_consumed, v_order.locked_amount using errcode = 'check_violation';
    end if;
    if p_fee_amount > p_quote_amount then
      raise exception 'apply_fill: SELL fee % exceeds the quote proceeds %', p_fee_amount, p_quote_amount
        using errcode = 'check_violation';
    end if;
    perform public.ledger_post(v_order.user_id, v_base_asset, 'TRADE', p_base_amount,
      0, -p_base_amount, 'trade', v_trade_id, 'trade:fill:' || p_provider_trade_id || ':base',
      jsonb_build_object('order', p_order_id::text, 'quote', p_quote_amount::text, 'price', p_execution_price::text));
    perform public.ledger_post(v_order.user_id, v_quote_asset, 'TRADE', p_quote_amount,
      p_quote_amount, 0, 'trade', v_trade_id, 'trade:fill:' || p_provider_trade_id || ':quote', '{}'::jsonb);
    if p_fee_amount > 0 then
      perform public.ledger_post(v_order.user_id, v_quote_asset, 'TRADE_FEE', p_fee_amount,
        -p_fee_amount, 0, 'trade', v_trade_id, 'trade:fill:' || p_provider_trade_id || ':fee', '{}'::jsonb);
    end if;
    v_new_locked := v_order.locked_amount - v_consumed;
  end if;

  -- 10. On completion, release any residual reservation. For a BUY this is the
  -- price-improvement refund plus any over-reserved fee; for a SELL it is
  -- normally zero. The order's locked_amount ends at exactly 0.
  if v_completes and v_new_locked > 0 then
    perform public.ledger_post(v_order.user_id, v_order.locked_asset_id, 'RELEASE', v_new_locked,
      v_new_locked, -v_new_locked, 'trade', v_trade_id, 'trade:fill:' || p_provider_trade_id || ':release', '{}'::jsonb);
    v_new_locked := 0;
  end if;

  -- 11. Volume-weighted average fill price across the order's fills
  -- (informational), rounded to the money scale. Money movements above use the
  -- venue-authoritative base/quote directly, never this derived figure.
  select round(sum(t.quote_amount) / sum(t.amount), 18) into v_vwap
  from public.trades t
  where t.buy_order_id = p_order_id or t.sell_order_id = p_order_id;

  v_new_status := case when v_completes then 'FILLED' else 'PARTIALLY_FILLED' end;

  -- 12. Update the order. guard_order_status_transition (005) enforces the
  -- one-way lifecycle and FILLED == filled_amount; this update respects both.
  update public.trading_orders
  set filled_amount = v_new_filled,
      locked_amount = v_new_locked,
      average_price = v_vwap,
      status        = v_new_status,
      updated_at    = now()
  where id = p_order_id;

  -- 13. Audit. Amounts are text — never a bare number inside jsonb (spec §21).
  insert into public.audit_logs (action, actor_type, actor_id, entity_type, entity_id, metadata)
  values ('order.fill', 'PROVIDER', null, 'trading_order', p_order_id,
    jsonb_build_object(
      'provider_trade_id', p_provider_trade_id,
      'trade', v_trade_id::text,
      'side', v_order.side,
      'base', p_base_amount::text,
      'quote', p_quote_amount::text,
      'price', p_execution_price::text,
      'fee', p_fee_amount::text,
      'fee_asset', p_fee_asset_id::text,
      'filled_amount', v_new_filled::text,
      'status', v_new_status::text,
      'executed_at', p_executed_at::text));

  return v_trade_id;
end;
$$;

-- Moves money, so like every other money mover it is service_role-only: the
-- internal settlement service calls it with the service-role client after the
-- execution adapter has reported the fill. No client role may call it. 017
-- withdrew the schema's default EXECUTE grant to the client roles, so a function
-- created after it is executable by its owner only until granted explicitly.
revoke all on function public.apply_fill(uuid, text, numeric, numeric, numeric, numeric, uuid, timestamptz) from public, anon, authenticated;
grant execute on function public.apply_fill(uuid, text, numeric, numeric, numeric, numeric, uuid, timestamptz) to service_role;

-- =============================================================================
-- JimoCex — 022_submitted_lifecycle
--
-- Venue-safe order lifecycle (Slice 14B): the database foundation a future
-- execution provider needs. NO provider is connected and nothing in the
-- application calls the new functions yet; until a venue exists, an order is
-- placed OPEN, rests OPEN and is cancelled by its owner exactly as before.
--
--     OPEN ──► SUBMITTED ──► PARTIALLY_FILLED ──► FILLED
--      │           │                │
--      └──────────►┴───────────────►┴──────────► CANCELLED
--
--   1. order_status gains SUBMITTED: the order has been handed to a venue (or a
--      hand-over is in flight). From here on the venue may execute against the
--      reservation, so the customer's request alone can no longer release it.
--   2. guard_order_status_transition enforces the table above — it used to
--      freeze terminal states only — and makes provider_order_id set-once,
--      written only onto a SUBMITTED order.
--   3. claim_order_for_submission: the atomic OPEN → SUBMITTED claim. Of any
--      number of concurrent callers exactly one gets the order back; the others
--      get NULL and must not call a venue.
--   4. record_provider_order_id: compare-and-set of the venue's order id.
--   5. cancel_order releases on the customer's request only an OPEN order.
--   6. finalize_venue_cancellation: the only release for a submitted order —
--      once the venue says it ended AND everything it executed is settled. It
--      releases what is still locked; there is no amount to pass in.
--   7. apply_fill refuses an order never submitted to a venue. Its accounting
--      is unchanged, statement for statement (020).
--
-- PROVIDER-NEUTRAL: no venue, status vocabulary or API is assumed.
--
-- TRANSACTION NOTE. ALTER TYPE ... ADD VALUE runs inside the migration's
-- transaction (PostgreSQL 12+), but the new value may not be USED until that
-- transaction commits. Nothing below uses it when the migration runs: it occurs
-- only inside PL/pgSQL bodies, which are not evaluated when they are created,
-- and no statement here reads or writes trading_orders.
--
-- REPLAY. Every statement is idempotent — ADD VALUE IF NOT EXISTS, CREATE OR
-- REPLACE FUNCTION, DROP TRIGGER IF EXISTS + CREATE TRIGGER, REVOKE/GRANT — so
-- a second run changes no definition and no privilege.
-- =============================================================================

alter type public.order_status add value if not exists 'SUBMITTED' after 'OPEN';

-- -----------------------------------------------------------------------------
-- Lifecycle guard
--
-- Fires on any UPDATE that sets status or provider_order_id. Refuses — never
-- repairs — a move outside the table, a change to a terminal order, and a
-- second or misplaced venue order id. FILLED must still agree with the numbers.
-- -----------------------------------------------------------------------------
create or replace function public.guard_order_status_transition()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- The venue's order id is how a venue report finds its order: written once,
  -- onto a SUBMITTED order, and never replaced or cleared.
  if new.provider_order_id is distinct from old.provider_order_id then
    if old.provider_order_id is not null then
      raise exception 'order %: provider_order_id is already set and cannot change', old.id
        using errcode = 'restrict_violation';
    end if;
    if new.status <> 'SUBMITTED' then
      raise exception 'order %: a venue order id may be recorded only on a SUBMITTED order, not %', old.id, new.status
        using errcode = 'restrict_violation';
    end if;
  end if;

  -- Not a transition: e.g. a further partial fill keeps PARTIALLY_FILLED.
  if old.status = new.status then
    return new;
  end if;

  if old.status in ('FILLED', 'CANCELLED', 'REJECTED', 'EXPIRED') then
    raise exception
      'order %: status % is terminal and cannot change to %',
      old.id, old.status, new.status
      using errcode = 'restrict_violation';
  end if;

  if not (
       (old.status = 'OPEN'             and new.status in ('SUBMITTED', 'CANCELLED'))
    or (old.status = 'SUBMITTED'        and new.status in ('PARTIALLY_FILLED', 'FILLED', 'CANCELLED'))
    or (old.status = 'PARTIALLY_FILLED' and new.status in ('FILLED', 'CANCELLED'))
  ) then
    raise exception 'order %: % -> % is not a legal order transition', old.id, old.status, new.status
      using errcode = 'restrict_violation';
  end if;

  -- FILLED must agree with the numbers: a fully filled order whose fills do not
  -- add up to its size means a settlement bug upstream, not a status to accept.
  if new.status = 'FILLED' and new.filled_amount <> new.amount then
    raise exception
      'order %: cannot be FILLED while filled_amount (%) <> amount (%)',
      old.id, new.filled_amount, new.amount
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

drop trigger if exists trading_orders_status_guard on public.trading_orders;
create trigger trading_orders_status_guard
  before update of status, provider_order_id on public.trading_orders
  for each row execute function public.guard_order_status_transition();

-- -----------------------------------------------------------------------------
-- claim_order_for_submission
--
-- Moves one of the user's OPEN LIMIT orders to SUBMITTED and returns its id, or
-- returns NULL and changes nothing. Called by the server immediately before it
-- hands the order to a venue; a NULL means another submission or the owner's
-- cancel got there first, and the venue must not be called.
--
-- One UPDATE does the check and the move, so it is atomic: concurrent callers
-- queue on the row lock, and each re-checks the WHERE clause against the row the
-- previous one committed — which is no longer OPEN.
-- -----------------------------------------------------------------------------
create or replace function public.claim_order_for_submission(
  p_user_id  uuid,
  p_order_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  update public.trading_orders
  set status = 'SUBMITTED', updated_at = now()
  where id = p_order_id
    and user_id = p_user_id
    and status = 'OPEN'
    and type = 'LIMIT'
    and provider_order_id is null
    and filled_amount = 0
    and locked_amount > 0
  returning id into v_id;

  if v_id is null then
    return null;   -- not this user's, not OPEN, not a reserved LIMIT order: refused, nothing changed
  end if;

  insert into public.audit_logs (action, actor_type, actor_id, entity_type, entity_id, metadata)
  values ('order.submit', 'SYSTEM', null, 'trading_order', v_id,
    jsonb_build_object('user', p_user_id::text));

  return v_id;
end;
$$;

-- -----------------------------------------------------------------------------
-- record_provider_order_id
--
-- Compare-and-set of the venue's order id on a SUBMITTED order of this user:
--   RECORDED          it was empty and is now this id;
--   ALREADY_RECORDED  it already is this id (a replay) — nothing changed;
--   CONFLICT          anything else: another id is there, the order is not this
--                     user's or not SUBMITTED, or another order holds this id.
-- The guard trigger enforces set-once independently of this function.
-- -----------------------------------------------------------------------------
create or replace function public.record_provider_order_id(
  p_user_id           uuid,
  p_order_id          uuid,
  p_provider_order_id text
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order public.trading_orders;
begin
  if p_provider_order_id is null or length(btrim(p_provider_order_id)) = 0 then
    raise exception 'record_provider_order_id: a venue order id is required' using errcode = 'check_violation';
  end if;

  select * into v_order
  from public.trading_orders
  where id = p_order_id and user_id = p_user_id
  for update;

  if v_order.id is null then
    return 'CONFLICT';
  end if;
  if v_order.provider_order_id is not null then
    return case when v_order.provider_order_id = p_provider_order_id then 'ALREADY_RECORDED' else 'CONFLICT' end;
  end if;
  if v_order.status <> 'SUBMITTED' then
    return 'CONFLICT';
  end if;
  if exists (select 1 from public.trading_orders where provider_order_id = p_provider_order_id) then
    return 'CONFLICT';
  end if;

  begin
    update public.trading_orders
    set provider_order_id = p_provider_order_id, updated_at = now()
    where id = v_order.id;
  exception when unique_violation then
    return 'CONFLICT';   -- another order took this venue id concurrently
  end;

  insert into public.audit_logs (action, actor_type, actor_id, entity_type, entity_id, metadata)
  values ('order.venue_id', 'SYSTEM', null, 'trading_order', v_order.id,
    jsonb_build_object('provider_order_id', p_provider_order_id));

  return 'RECORDED';
end;
$$;

-- -----------------------------------------------------------------------------
-- cancel_order (replaces 018)
--
-- The customer's cancel. It releases only an order that never left JimoCex:
-- OPEN, with no venue order id. Once SUBMITTED or PARTIALLY_FILLED the venue may
-- still execute against the reservation, so this returns false and releases
-- nothing — such an order ends through finalize_venue_cancellation, after the
-- venue confirms. False also covers a terminal, unknown or foreign order, as
-- before, without saying which.
-- -----------------------------------------------------------------------------
create or replace function public.cancel_order(
  p_user_id  uuid,
  p_order_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order public.trading_orders;
begin
  -- Lock the row so a concurrent cancel, claim or settlement serializes behind us.
  select * into v_order
  from public.trading_orders
  where id = p_order_id and user_id = p_user_id
  for update;

  if v_order.id is null then
    return false;                               -- not found, or not this user's
  end if;
  if v_order.status <> 'OPEN' or v_order.provider_order_id is not null then
    return false;                               -- terminal, or at a venue: not the customer's to release
  end if;

  if v_order.locked_amount > 0 and v_order.locked_asset_id is not null then
    perform public.ledger_post(
      p_user_id         => v_order.user_id,
      p_asset_id        => v_order.locked_asset_id,
      p_entry_type      => 'RELEASE',
      p_amount          => v_order.locked_amount,
      p_available_delta => v_order.locked_amount,
      p_locked_delta    => -v_order.locked_amount,
      p_reference_type  => 'order',
      p_reference_id    => v_order.id,
      p_dedup_key       => 'order:release:' || v_order.id::text
    );
  end if;

  update public.trading_orders
  set status = 'CANCELLED', locked_amount = 0, updated_at = now()
  where id = v_order.id;

  insert into public.audit_logs (action, actor_type, actor_id, entity_type, entity_id, metadata)
  values (
    'order.cancel', 'USER', p_user_id, 'trading_order', v_order.id,
    jsonb_build_object('released_amount', v_order.locked_amount::text)
  );

  return true;
end;
$$;

-- -----------------------------------------------------------------------------
-- finalize_venue_cancellation
--
-- Ends a submitted order the venue says has ended (CANCELLED, REJECTED or
-- EXPIRED) and releases what the order still holds. Server-only; the venue's
-- word reaches it through the execution adapter, never from a browser.
--
-- It releases only when everything the venue executed is settled here:
--   * the order is SUBMITTED or PARTIALLY_FILLED;
--   * the confirmation is about THIS order's venue order (p_provider_order_id
--     equals provider_order_id; both NULL only when no venue ever acknowledged
--     one — then nothing can have executed, so both amounts must be zero);
--   * the venue's FINAL cumulative filled base equals filled_amount, and
--     filled_amount equals the sum of the order's settled trades.
-- The amount released is locked_amount — what apply_fill left after drawing the
-- reservation down for every settled fill — never the original hold, and never
-- a caller's figure: there is no amount parameter.
--
-- Returns FINALIZED, or — changing nothing — ALREADY_FINALIZED (a repeat),
-- TERMINAL, NOT_SUBMITTED, VENUE_ORDER_MISMATCH or FILLED_MISMATCH.
-- -----------------------------------------------------------------------------
create or replace function public.finalize_venue_cancellation(
  p_order_id            uuid,
  p_provider_order_id   text,
  p_venue_status        text,
  p_venue_filled_amount numeric
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order   public.trading_orders;
  v_settled numeric;
  v_release numeric;
begin
  if p_venue_status is null or p_venue_status not in ('CANCELLED', 'REJECTED', 'EXPIRED') then
    raise exception 'finalize_venue_cancellation: % is not a final venue status', coalesce(p_venue_status, 'NULL')
      using errcode = 'check_violation';
  end if;
  -- NaN sorts above every number in numeric, so it is checked explicitly.
  if p_venue_filled_amount is null or p_venue_filled_amount = 'NaN'::numeric or p_venue_filled_amount < 0 then
    raise exception 'finalize_venue_cancellation: the venue filled amount must be a non-negative number, got %', p_venue_filled_amount
      using errcode = 'check_violation';
  end if;

  select * into v_order from public.trading_orders where id = p_order_id for update;
  if v_order.id is null then
    raise exception 'finalize_venue_cancellation: unknown order %', p_order_id using errcode = 'foreign_key_violation';
  end if;

  -- Idempotent: a finalized order is reported, never released twice.
  if v_order.status = 'CANCELLED' then
    return 'ALREADY_FINALIZED';
  end if;
  if v_order.status in ('FILLED', 'REJECTED', 'EXPIRED') then
    return 'TERMINAL';
  end if;
  if v_order.status not in ('SUBMITTED', 'PARTIALLY_FILLED') then
    return 'NOT_SUBMITTED';
  end if;

  if v_order.provider_order_id is distinct from p_provider_order_id then
    return 'VENUE_ORDER_MISMATCH';
  end if;
  if v_order.provider_order_id is null and (p_venue_filled_amount <> 0 or v_order.filled_amount <> 0) then
    return 'FILLED_MISMATCH';
  end if;

  -- Every venue fill must already be settled.
  if v_order.filled_amount <> p_venue_filled_amount then
    return 'FILLED_MISMATCH';
  end if;
  select coalesce(sum(t.amount), 0) into v_settled
  from public.trades t
  where t.buy_order_id = v_order.id or t.sell_order_id = v_order.id;
  if v_settled <> v_order.filled_amount then
    return 'FILLED_MISMATCH';
  end if;

  v_release := v_order.locked_amount;
  if v_release > 0 and v_order.locked_asset_id is not null then
    perform public.ledger_post(
      p_user_id         => v_order.user_id,
      p_asset_id        => v_order.locked_asset_id,
      p_entry_type      => 'RELEASE',
      p_amount          => v_release,
      p_available_delta => v_release,
      p_locked_delta    => -v_release,
      p_reference_type  => 'order',
      p_reference_id    => v_order.id,
      p_dedup_key       => 'order:release:' || v_order.id::text
    );
  end if;

  update public.trading_orders
  set status = 'CANCELLED', locked_amount = 0, updated_at = now()
  where id = v_order.id;

  -- Amounts are text — never a bare number inside jsonb (spec §21).
  insert into public.audit_logs (action, actor_type, actor_id, entity_type, entity_id, metadata)
  values ('order.venue_cancel', 'PROVIDER', null, 'trading_order', v_order.id,
    jsonb_build_object(
      'provider_order_id', p_provider_order_id,
      'venue_status', p_venue_status,
      'venue_filled_amount', p_venue_filled_amount::text,
      'filled_amount', v_order.filled_amount::text,
      'released_amount', v_release::text));

  return 'FINALIZED';
end;
$$;

-- -----------------------------------------------------------------------------
-- apply_fill (replaces 020)
--
-- Identical to 020 except step 3b: a fill is applied only to an order submitted
-- to a venue — SUBMITTED or PARTIALLY_FILLED, with a venue order id. An OPEN
-- order was never sent anywhere; a SUBMITTED order without a venue id has no
-- venue order a fill could belong to. Every other statement, and with them the
-- accounting, is 020's.
-- -----------------------------------------------------------------------------
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

  -- 3b. (022) Only an order submitted to a venue can take a fill.
  if v_order.status not in ('SUBMITTED', 'PARTIALLY_FILLED') or v_order.provider_order_id is null then
    raise exception 'apply_fill: order % was never submitted to a venue (status %)', p_order_id, v_order.status
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

  -- 12. Update the order. guard_order_status_transition (022) enforces the
  -- lifecycle and FILLED == filled_amount; this update respects both.
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

-- -----------------------------------------------------------------------------
-- Privileges. The three new functions move or gate money and are called by the
-- server only, like every money mover: service_role, nobody else. 017 withdrew
-- the schema's default EXECUTE grant to the client roles, so they are granted
-- explicitly. CREATE OR REPLACE keeps the existing grants of cancel_order,
-- apply_fill and the trigger function.
-- -----------------------------------------------------------------------------
revoke all on function public.claim_order_for_submission(uuid, uuid) from public, anon, authenticated;
revoke all on function public.record_provider_order_id(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.finalize_venue_cancellation(uuid, text, text, numeric) from public, anon, authenticated;
grant execute on function public.claim_order_for_submission(uuid, uuid) to service_role;
grant execute on function public.record_provider_order_id(uuid, uuid, text) to service_role;
grant execute on function public.finalize_venue_cancellation(uuid, text, text, numeric) to service_role;

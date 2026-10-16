-- =============================================================================
-- JimoCex — 018_order_placement
--
-- Atomic LIMIT-order placement and cancellation (spec §19).
--
-- Why a function and not two PostgREST calls: creating the order row and
-- reserving its funds must be one transaction. Inserting the order and then
-- posting the HOLD as two REST calls would leave an OPEN order with no hold if
-- the second call failed. These functions do both under one transaction, the
-- same shape as consume_quote (006) and release_withdrawal_hold (007).
--
-- SCOPE: LIMIT only. A MARKET order needs a price from a feed and a venue to
-- fill against; neither is connected, and the application refuses MARKET before
-- it ever reaches here (src/lib/engines/order-rules.ts). A placed LIMIT order
-- rests as OPEN with its funds held; it does NOT fill, because no execution
-- provider is connected. Filling and settlement are a later migration, built
-- against the real provider's execution reports.
--
-- Money safety reused, not reinvented:
--   * the HOLD/RELEASE go through ledger_post() — the only writer of wallets
--     and ledger_entries — so overdraft protection, the per-wallet row lock,
--     the NaN/precision checks and dedup all apply unchanged;
--   * a HOLD that would overdraw the available balance makes ledger_post raise,
--     which aborts the whole function: no order row is left behind;
--   * the HOLD's dedup_key is derived from the order id, so a replay cannot
--     double-reserve;
--   * client_order_id makes placement idempotent: a retry returns the original
--     order id and posts no second hold.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- place_limit_order
--
-- Inserts an OPEN LIMIT order and reserves its funds in one transaction.
-- Returns the order id — the caller re-reads the row through the normal,
-- money-cast select. Returning a scalar keeps the money catalog simple: the
-- function has money INPUTS only, no money result columns.
--
-- The caller (a server action) is responsible for the decisions that need the
-- user's session and market data: authorization, account status, tier limits,
-- the fee, and which asset/'amount to lock. This function re-checks only what
-- the database can own — the pair is tradable, the amounts are positive, the
-- lock is consistent — and performs the atomic write. A client value is never
-- trusted upstream; this is the backstop, not the only check.
-- -----------------------------------------------------------------------------
create or replace function public.place_limit_order(
  p_user_id        uuid,
  p_pair_id        uuid,
  p_side           public.order_side,
  p_price          numeric,
  p_amount         numeric,
  p_lock_asset_id  uuid,
  p_lock_amount    numeric,
  p_client_order_id text default null,
  p_fee            numeric default 0,
  p_metadata       jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_pair    public.trading_pairs;
  v_order   public.trading_orders;
  v_existing uuid;
begin
  -- Idempotency (spec §20): a retried placement returns the original order and
  -- reserves nothing new. Checked before any write.
  if p_client_order_id is not null then
    select id into v_existing
    from public.trading_orders
    where user_id = p_user_id and client_order_id = p_client_order_id;
    if v_existing is not null then
      return v_existing;
    end if;
  end if;

  -- The pair must exist and permit trading. The application checks this too;
  -- the database owns the final say.
  select * into v_pair from public.trading_pairs where id = p_pair_id;
  if v_pair.id is null then
    raise exception 'place_limit_order: unknown pair %', p_pair_id
      using errcode = 'foreign_key_violation';
  end if;
  if not v_pair.trading_enabled then
    raise exception 'place_limit_order: trading is disabled for pair %', v_pair.symbol
      using errcode = 'check_violation';
  end if;

  if p_price is null or p_price <= 0 then
    raise exception 'place_limit_order: a LIMIT order needs a positive price'
      using errcode = 'check_violation';
  end if;
  if p_lock_amount is null or p_lock_amount <= 0 then
    raise exception 'place_limit_order: the reserved amount must be positive'
      using errcode = 'check_violation';
  end if;

  -- Insert the order first, as OPEN with its funds marked reserved. The row's
  -- own CHECKs (amount > 0, price matches type, locked >= 0) apply here, and
  -- the (user_id, client_order_id) unique constraint turns a racing duplicate
  -- placement into an error rather than a second hold.
  insert into public.trading_orders (
    user_id, pair_id, side, type, price, amount,
    status, client_order_id, locked_asset_id, locked_amount
  )
  values (
    p_user_id, p_pair_id, p_side, 'LIMIT', p_price, p_amount,
    'OPEN', p_client_order_id, p_lock_asset_id, p_lock_amount
  )
  returning * into v_order;

  -- Reserve the funds: move lock_amount from available to locked. ledger_post
  -- refuses to take available below zero, so an underfunded order aborts the
  -- whole transaction here and the order row above is rolled back with it.
  perform public.ledger_post(
    p_user_id         => p_user_id,
    p_asset_id        => p_lock_asset_id,
    p_entry_type      => 'HOLD',
    p_amount          => p_lock_amount,
    p_available_delta => -p_lock_amount,
    p_locked_delta    => p_lock_amount,
    p_reference_type  => 'order',
    p_reference_id    => v_order.id,
    p_dedup_key       => 'order:hold:' || v_order.id::text,
    p_metadata        => coalesce(p_metadata, '{}'::jsonb)
  );

  insert into public.audit_logs (action, actor_type, actor_id, entity_type, entity_id, metadata)
  values (
    'order.place', 'USER', p_user_id, 'trading_order', v_order.id,
    jsonb_build_object(
      'pair', v_pair.symbol, 'side', p_side, 'type', 'LIMIT',
      'fee', p_fee::text, 'locked_amount', p_lock_amount::text
    )
  );

  return v_order.id;
end;
$$;

-- -----------------------------------------------------------------------------
-- cancel_order
--
-- Cancels a non-terminal order the user owns and releases whatever it still
-- holds, in one transaction. Returns true if it cancelled, false if there was
-- nothing to cancel (already terminal, or not the user's) — so a retry is a
-- no-op, not an error.
--
-- The released amount is the order's current locked_amount. While no execution
-- provider is connected an order never partially fills, so that is always the
-- full reserve; once fills exist, settlement will have reduced locked_amount as
-- it consumed the hold, and this still releases exactly the remainder.
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
  -- Lock the row so a concurrent cancel or settlement serializes behind us.
  select * into v_order
  from public.trading_orders
  where id = p_order_id and user_id = p_user_id
  for update;

  if v_order.id is null then
    return false;                               -- not found, or not this user's
  end if;
  if v_order.status in ('FILLED', 'CANCELLED', 'REJECTED', 'EXPIRED') then
    return false;                               -- already terminal: nothing to do
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

-- Both functions move money, so like every other money mover they are
-- service_role-only: the application calls them with the service-role client
-- after it has authorized the user. No client role may call them directly.
revoke all on function public.place_limit_order(uuid, uuid, public.order_side, numeric, numeric, uuid, numeric, text, numeric, jsonb) from public, anon, authenticated;
revoke all on function public.cancel_order(uuid, uuid) from public, anon, authenticated;

-- 017 withdrew the schema's default EXECUTE grant to the client roles, so a
-- function created after it (this one) is executable by its owner only until
-- granted. Grant service_role explicitly — the same executor every other money
-- mover has — so the application's service-role client can call it.
grant execute on function public.place_limit_order(uuid, uuid, public.order_side, numeric, numeric, uuid, numeric, text, numeric, jsonb) to service_role;
grant execute on function public.cancel_order(uuid, uuid) to service_role;

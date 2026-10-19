-- =============================================================================
-- JimoCex — upgrade a database at 021 to 022 (package upgrade_021_022)
--
-- Target: a database built from supabase/migrations 001–021 by the Preview
--   runbook's gate (docs/preview-environment.md, step 3), such as the Preview's
--   test project; PostgreSQL 16 or 17; role postgres. Nothing else.
-- Source: supabase/migrations/022_submitted_lifecycle.sql, sha256
--   61d68773d53eb12798707f86b057c07715d55c730fb229e9db57e15bf71be0bb.
--   Its text appears once below (without its final newline), together with the
--   text of checks.sql (without its final ";"). Both are executed from those
--   constants; their md5 is checked first.
--
-- THE WHOLE FILE IS ONE SQL STATEMENT (a DO block), as package v4 is. PostgreSQL
-- runs a single statement atomically: if anything fails, nothing is applied,
-- however the client sends it. There is no BEGIN/COMMIT to honour.
--
-- HOW TO RUN: only as docs/preview-environment.md (step 3b) describes. That
--   block checks this file's sha256, runs checks.sql read-only first, then
--     psql -X -q -v ON_ERROR_STOP=1 -d "<connection>" -f apply.sql
--   and checks.sql again. Success prints nothing (psql -q); any error means
--   nothing has changed: keep the error text, do not edit or re-run.
--
-- Inside the statement, in order:
--   0. LIMITS     lock_timeout 5s for the rest of the statement.
--   1. TEXTS      the embedded 022 and checks.sql are the reviewed texts.
--   2. LOCK       every table in public, SHARE ROW EXCLUSIVE: writers wait until
--                 this statement ends, readers do not. A second run waits here,
--                 then finds 022 applied and refuses.
--   3. PREFLIGHT  checks.sql, phase pre: exactly the 021 state (role, server,
--                 no foreign migration history, 022 absent, 021's flags, the
--                 public schema of a clean 001–021 build, the replaced functions
--                 as 005/018/020 left them, no order 022 would strand, no venue
--                 order id, and consistent money: each order's lock against its
--                 ledger rows, fills against trades, wallets against the ledger).
--   4. SNAPSHOT   checks.sql, phase data: each table's row count and the md5 of
--                 all its rows.
--   5. APPLY      EXECUTE 022.
--   6. POSTFLIGHT checks.sql, phase post: what 022 defines (SUBMITTED after
--                 OPEN, the schema of a clean 001–022 build, the six functions
--                 with exactly their privileges, the guard trigger, RLS on every
--                 table) and the same money checks.
--   7. UNCHANGED  phase data again: every row of every table is as in 4. 022 is
--                 schema only; a changed row means something else happened.
-- It writes no migration history: the gate wrote none either (step 3).
-- =============================================================================

do $upgrade$
declare
  v022 constant text := $mig022$-- =============================================================================
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
grant execute on function public.finalize_venue_cancellation(uuid, text, text, numeric) to service_role;$mig022$;
  v_checks constant text := $checks$-- =============================================================================
-- JimoCex — upgrade 021 → 022: read-only checks (package upgrade_021_022)
--
-- ONE read-only SELECT. It changes nothing, and runs where a read-only
-- transaction is enforced:
--
--   psql -X -q -At -1 -v ON_ERROR_STOP=1 -d "<connection>" \
--        -c 'set transaction read only' -f checks.sql
--
-- Each row is  phase | id | check | ok | detail :
--   pre   the database is exactly the 021 state this package upgrades;
--   post  the database is what 022 defines, and its money is consistent;
--   data  one row per table in public: its row count and the md5 of all its
--         rows. Informational; apply.sql compares them before and after 022.
-- The verdicts are rows P99 and Q99. Before the upgrade the result must hold
--   pre|P99|VERDICT|t|READY        (and post|Q99 is f: 022 is not there yet);
-- after it
--   post|Q99|VERDICT|t|PASS        (and pre|P99 is f: 022 is there now).
--
-- apply.sql embeds this text (without the final ";") and runs the same checks
-- inside its own statement, so there is one definition of "021" and "022".
--
-- The fingerprint is the item query of package v4 (supabase/drafts/v4) without
-- the categories a hosted platform or the data decide: default privileges
-- (defacl), the schema's own ACL (nspacl) and tier_limits rows (tier). Its
-- expected values come from clean local builds of 001–021 and 001–022 on
-- PostgreSQL 16.15 and 17.10, which agree except for table privileges, where
-- PostgreSQL 17 adds MAINTAIN; those are pinned per major version.
--
-- No 'SUBMITTED' enum literal appears below: inside apply.sql's statement the
-- value is new and may not be used before it commits, so statuses are compared
-- as text.
-- =============================================================================
with
items as (
    select x from (
      select 'col ' || c.relname || '.' || a.attname || ' ' || format_type(a.atttypid, a.atttypmod)
           || ' nn=' || a.attnotnull::text || ' gen=' || a.attgenerated::text
           || ' def=' || coalesce(pg_get_expr(d.adbin, d.adrelid), '') as x
    from pg_attribute a join pg_class c on c.oid = a.attrelid
    left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
    where c.relnamespace = 'public'::regnamespace and c.relkind in ('r','p','v','m','f') and a.attnum > 0 and not a.attisdropped
    union all
    select 'rel ' || c.relname || ' kind=' || c.relkind::text || ' owner=' || pg_get_userbyid(c.relowner)
           || ' rls=' || c.relrowsecurity::text || ' force=' || c.relforcerowsecurity::text
    from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind in ('r','p','v','m','f','S')
    union all
    select 'con ' || c.relname || '.' || con.conname || ' ' || pg_get_constraintdef(con.oid)
    from pg_constraint con join pg_class c on c.oid = con.conrelid where c.relnamespace = 'public'::regnamespace
    union all
    select 'idx ' || ci.relname || ' ' || pg_get_indexdef(i.indexrelid)
    from pg_index i join pg_class c on c.oid = i.indrelid join pg_class ci on ci.oid = i.indexrelid
    where c.relnamespace = 'public'::regnamespace
    union all
    select 'trg ' || c.relname || '.' || t.tgname || ' ' || pg_get_triggerdef(t.oid) || ' en=' || t.tgenabled::text
    from pg_trigger t join pg_class c on c.oid = t.tgrelid where c.relnamespace = 'public'::regnamespace and not t.tgisinternal
    union all
    select 'pol ' || pol.tablename || '.' || pol.policyname || ' ' || pol.permissive || ' ' || pol.cmd || ' '
           || array_to_string(pol.roles, ',') || ' u=' || coalesce(pol.qual, '') || ' c=' || coalesce(pol.with_check, '')
    from pg_policies pol where pol.schemaname = 'public'
    union all
    select 'fn ' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ') -> ' || pg_get_function_result(p.oid)
           || ' kind=' || p.prokind::text || ' lang=' || l.lanname || ' secdef=' || p.prosecdef::text
           || ' strict=' || p.proisstrict::text || ' vol=' || p.provolatile::text || ' owner=' || pg_get_userbyid(p.proowner)
           || ' cfg=' || coalesce(array_to_string(p.proconfig, ','), '') || ' src=' || md5(p.prosrc)
           || ' comment=' || md5(coalesce(obj_description(p.oid, 'pg_proc'), ''))
    from pg_proc p join pg_language l on l.oid = p.prolang where p.pronamespace = 'public'::regnamespace
    union all
    select 'fnacl ' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ') '
           || case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end || ' ' || a.privilege_type
    from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
    where p.pronamespace = 'public'::regnamespace
      and (a.grantee = 0 or a.grantee in (select oid from pg_roles where rolname in ('anon','authenticated','service_role')))
    union all
    select 'relacl ' || c.relname || ' ' || case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end
           || ' ' || a.privilege_type
    from pg_class c, aclexplode(coalesce(c.relacl, acldefault(case when c.relkind = 'S' then 's'::"char" else 'r'::"char" end, c.relowner))) a
    where c.relnamespace = 'public'::regnamespace and c.relkind in ('r','p','v','m','f','S')
      and (a.grantee = 0 or a.grantee in (select oid from pg_roles where rolname in ('anon','authenticated','service_role')))
    union all
    select 'colacl ' || c.relname || '.' || at.attname || ' ' || case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end
           || ' ' || a.privilege_type
    from pg_class c join pg_attribute at on at.attrelid = c.oid and at.attnum > 0 and not at.attisdropped and at.attacl is not null,
         aclexplode(at.attacl) a
    where c.relnamespace = 'public'::regnamespace
    union all
    select 'enum ' || t.typname || ' ' || string_agg(e.enumlabel, ',' order by e.enumsortorder)
    from pg_type t join pg_enum e on e.enumtypid = t.oid where t.typnamespace = 'public'::regnamespace group by t.typname
    union all
    select 'typ ' || t.typname || ' ' || t.typtype::text || ' owner=' || pg_get_userbyid(t.typowner)
           || case when t.typtype = 'd' then ' base=' || format_type(t.typbasetype, t.typtypmod) else '' end
    from pg_type t
    where t.typnamespace = 'public'::regnamespace and t.typtype in ('d','r','m','p')
       or (t.typnamespace = 'public'::regnamespace and t.typtype = 'c'
           and (select relkind from pg_class where oid = t.typrelid) = 'c')
    union all
    select 'cmt ' || c.relname || coalesce('.' || a.attname, '') || ' ' || md5(d.description)
    from pg_description d join pg_class c on d.classoid = 'pg_class'::regclass and d.objoid = c.oid
    left join pg_attribute a on a.attrelid = c.oid and a.attnum = d.objsubid and d.objsubid > 0
    where c.relnamespace = 'public'::regnamespace
    ) f
),
cats as (
  select split_part(x, ' ', 1) as cat, count(*)::int as n, md5(string_agg(x, E'\n' order by x collate "C")) as h
  from items group by 1
),
major as (
  select current_setting('server_version_num')::int / 10000 as v
),
expected(phase, major, cat, n, h) as (values
    ('pre', 0, 'cmt', 21, '8b3adbd1a160f961e42043d00e484147'),
    ('pre', 0, 'col', 277, '22f8b1407dba0cf8a6b99a55439c0448'),
    ('pre', 0, 'con', 175, '7b29e7ded5c1e91b4730e8ebc8533066'),
    ('pre', 0, 'enum', 23, '7e8df1e2362fbcb93654cd34fc7a2f5c'),
    ('pre', 0, 'fn', 22, 'c3221040d70f29d32be53c503ee0cfb7'),
    ('pre', 0, 'fnacl', 14, '8a4c1a2b1e874252b41cc199f4b5c808'),
    ('pre', 0, 'idx', 89, '17ba2c1343ecd4e4623257b5d4e88411'),
    ('pre', 0, 'pol', 21, 'c67636e4695253bbe6248788bca8272b'),
    ('pre', 0, 'rel', 23, 'e2a9bdb7a79a3e1607739e8f17478753'),
    ('pre', 0, 'trg', 26, '1f9c141438b9c84603617c67f0ee1b57'),
    ('pre', 16, 'relacl', 335, 'f503a5a53d66089fff6fa4b42d366f76'),
    ('pre', 17, 'relacl', 404, 'c17e9933ba74f96504f14ca4e3522ce1'),
    ('post', 0, 'cmt', 21, '8b3adbd1a160f961e42043d00e484147'),
    ('post', 0, 'col', 277, '22f8b1407dba0cf8a6b99a55439c0448'),
    ('post', 0, 'con', 175, '7b29e7ded5c1e91b4730e8ebc8533066'),
    ('post', 0, 'enum', 23, 'd8b4a0674a13b6bd8d941483cce60b13'),
    ('post', 0, 'fn', 25, '47a6400add27cd70d900025a708b7b77'),
    ('post', 0, 'fnacl', 17, 'd735dfc24950a89c7386efe483d0a6af'),
    ('post', 0, 'idx', 89, '17ba2c1343ecd4e4623257b5d4e88411'),
    ('post', 0, 'pol', 21, 'c67636e4695253bbe6248788bca8272b'),
    ('post', 0, 'rel', 23, 'e2a9bdb7a79a3e1607739e8f17478753'),
    ('post', 0, 'trg', 26, '1f699ac84420a1c1292153d24efe8b72'),
    ('post', 16, 'relacl', 335, 'f503a5a53d66089fff6fa4b42d366f76'),
    ('post', 17, 'relacl', 404, 'c17e9933ba74f96504f14ca4e3522ce1')
),
fingerprint as (
  select ph.phase,
         (select string_agg(k, ', ' order by k) from (
            select coalesce(e.cat, c.cat) as k
            from (select x.cat, x.n, x.h from expected x, major m
                   where x.phase = ph.phase and x.major in (0, m.v)) e
            full join cats c on c.cat = e.cat
            where e.cat is null or c.cat is null or e.n <> c.n or e.h <> c.h) d) as differing
  from (values ('pre'), ('post')) ph(phase)
),
-- The six functions 022 creates or replaces: body md5, privileges, security, settings, owner.
fn as (
  select p.proname || ' ' || md5(p.prosrc) || ' ' || coalesce(p.proacl::text, '-') || ' secdef=' || p.prosecdef::text
         || ' cfg=' || coalesce(array_to_string(p.proconfig, ','), '-') || ' owner=' || pg_get_userbyid(p.proowner) as x
  from pg_proc p
  where p.pronamespace = 'public'::regnamespace
    and p.proname in ('apply_fill', 'cancel_order', 'claim_order_for_submission', 'finalize_venue_cancellation',
                      'guard_order_status_transition', 'record_provider_order_id')
),
fn_pre(x) as (values
  ('apply_fill 022b50cd255044276345cb7cfce22440 {postgres=X/postgres,service_role=X/postgres} secdef=true cfg=search_path="" owner=postgres'),
  ('cancel_order 5c4b860927a9cf53ed0dc23d3d17a64b {postgres=X/postgres,service_role=X/postgres} secdef=true cfg=search_path="" owner=postgres'),
  ('guard_order_status_transition fb5b7bbd098e845a9ceb3c386ef23263 {postgres=X/postgres} secdef=false cfg=search_path="" owner=postgres')
),
fn_post(x) as (values
  ('apply_fill dd3db24b426fe00f686f5b42b1ddd092 {postgres=X/postgres,service_role=X/postgres} secdef=true cfg=search_path="" owner=postgres'),
  ('cancel_order 01a61a2b4c7bec26a25a193ecd2a7b2f {postgres=X/postgres,service_role=X/postgres} secdef=true cfg=search_path="" owner=postgres'),
  ('claim_order_for_submission 9b1b718ada7b269c294fc57a9c01db74 {postgres=X/postgres,service_role=X/postgres} secdef=true cfg=search_path="" owner=postgres'),
  ('finalize_venue_cancellation fe297e37936f3f62ec74006edd56fb85 {postgres=X/postgres,service_role=X/postgres} secdef=true cfg=search_path="" owner=postgres'),
  ('guard_order_status_transition 80cd7c63168758d16a2c3468609e6f08 {postgres=X/postgres} secdef=false cfg=search_path="" owner=postgres'),
  ('record_provider_order_id ef9eaa4b415b536f8b2d856474b3f8ec {postgres=X/postgres,service_role=X/postgres} secdef=true cfg=search_path="" owner=postgres')
),
labels as (
  select string_agg(e.enumlabel, ',' order by e.enumsortorder) as l
  from pg_enum e where e.enumtypid = 'public.order_status'::regtype
),
guard_trigger as (
  select string_agg(pg_get_triggerdef(t.oid), ' | ') as d
  from pg_trigger t where t.tgrelid = 'public.trading_orders'::regclass and t.tgname = 'trading_orders_status_guard'
),
statuses as (
  select coalesce(string_agg(s.st || '=' || s.n, ' ' order by s.st), 'none') as d,
         coalesce(sum(s.n) filter (where s.st in ('PENDING', 'PARTIALLY_FILLED', 'SUBMITTED')), 0) as stranded
  from (select o.status::text as st, count(*) as n from public.trading_orders o group by 1) s
),
history as (
  select to_regclass('supabase_migrations.schema_migrations') is not null as present,
         case when to_regclass('supabase_migrations.schema_migrations') is null then 0
              else (xpath('/row/n/text()', query_to_xml(
                     'select count(*) as n from supabase_migrations.schema_migrations', false, true, '')))[1]::text::int
         end as n
),
-- Per order: what its HOLD/RELEASE rows and its trades' rows moved in and out of
-- the lock must be exactly what it still holds.
order_locks as (
  select o.id, o.status::text as st, o.locked_amount, o.locked_asset_id, o.filled_amount,
         coalesce((select sum(l.locked_delta) from public.ledger_entries l
                    where (l.reference_type = 'order' and l.reference_id = o.id)
                       or (l.reference_type = 'trade' and l.reference_id in
                             (select t.id from public.trades t where t.buy_order_id = o.id or t.sell_order_id = o.id))), 0) as ledger_locked,
         coalesce((select sum(t.amount) from public.trades t where t.buy_order_id = o.id or t.sell_order_id = o.id), 0) as traded
  from public.trading_orders o
),
money as (
  select
    (select count(*) from order_locks where locked_amount <> ledger_locked) as lock_vs_ledger,
    (select count(*) from order_locks where filled_amount <> traded) as filled_vs_trades,
    (select count(*) from order_locks
      where locked_amount > 0 and (st not in ('OPEN', 'SUBMITTED', 'PARTIALLY_FILLED') or locked_asset_id is null)) as stray_locks,
    (select count(*) from order_locks where st = 'OPEN' and filled_amount <> 0) as open_with_fills,
    (select count(*) from public.ledger_entries l
      where l.reference_type = 'order' and not exists (select 1 from public.trading_orders o where o.id = l.reference_id)) as orphan_order_rows,
    (select count(*) from public.reconcile_wallets()) as wallet_drift
),
checks(phase, id, name, ok, detail) as (
  -- ---------------------------------------------------------------- pre: exactly 021
  select 'pre', 'P01', 'role owns the functions 022 replaces',
         current_user = 'postgres'
           and (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace
                 and p.proname in ('apply_fill', 'cancel_order', 'guard_order_status_transition')
                 and p.proowner = (select oid from pg_roles where rolname = current_user)) = 3,
         'current_user ' || current_user
  union all
  select 'pre', 'P02', 'server and session',
         (select v from major) in (16, 17) and current_setting('transaction_isolation') = 'read committed',
         'PostgreSQL ' || current_setting('server_version') || ', ' || current_setting('transaction_isolation')
  union all
  select 'pre', 'P03', 'no migration history from another mechanism',
         (select n from history) = 0,
         case when (select present from history) then 'schema_migrations has ' || (select n from history) || ' rows'
              else 'no schema_migrations table' end
  union all
  select 'pre', 'P04', '022 not applied: order_status has no SUBMITTED',
         (select l from labels) = 'PENDING,OPEN,PARTIALLY_FILLED,FILLED,CANCELLED,REJECTED,EXPIRED',
         (select l from labels)
  union all
  select 'pre', 'P05', '022 not applied: none of its three new functions exists',
         not exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace
                      and p.proname in ('claim_order_for_submission', 'record_provider_order_id', 'finalize_venue_cancellation')),
         (select coalesce(string_agg(p.oid::regprocedure::text, ', '), 'none') from pg_proc p
           where p.pronamespace = 'public'::regnamespace
             and p.proname in ('claim_order_for_submission', 'record_provider_order_id', 'finalize_venue_cancellation'))
  union all
  select 'pre', 'P06', '021 applied: BTC-USDT, ETH-USDT and SOL-USDT trade',
         (select count(*) from public.trading_pairs where symbol in ('BTC-USDT', 'ETH-USDT', 'SOL-USDT') and trading_enabled) = 3,
         'enabled: ' || coalesce((select string_agg(symbol, ' ' order by symbol) from public.trading_pairs where trading_enabled), 'none')
  union all
  select 'pre', 'P07', 'public schema is a clean 001-021 build',
         (select differing from fingerprint where phase = 'pre') is null,
         coalesce('differing: ' || (select differing from fingerprint where phase = 'pre'), 'all categories match')
  union all
  select 'pre', 'P08', 'the functions 022 replaces are 005/018/020''s, with their privileges',
         (select string_agg(x, E'\n' order by x) from fn) = (select string_agg(x, E'\n' order by x) from fn_pre),
         (select string_agg(split_part(x, ' ', 1) || ' ' || left(split_part(x, ' ', 2), 8), ', ' order by x) from fn)
  union all
  select 'pre', 'P09', 'no order 022 would strand (PENDING, PARTIALLY_FILLED)',
         (select stranded from statuses) = 0,
         (select d from statuses)
  union all
  select 'pre', 'P10', 'no venue order id is recorded',
         not exists (select 1 from public.trading_orders where provider_order_id is not null),
         (select count(provider_order_id) || ' set, ' || count(distinct provider_order_id) || ' distinct' from public.trading_orders)
  -- ---------------------------------------------------------------- post: what 022 defines
  union all
  select 'post', 'Q01', 'order_status is 021''s with SUBMITTED after OPEN',
         (select l from labels) = 'PENDING,OPEN,SUBMITTED,PARTIALLY_FILLED,FILLED,CANCELLED,REJECTED,EXPIRED',
         (select l from labels)
  union all
  select 'post', 'Q02', 'public schema is a clean 001-022 build',
         (select differing from fingerprint where phase = 'post') is null,
         coalesce('differing: ' || (select differing from fingerprint where phase = 'post'), 'all categories match')
  union all
  select 'post', 'Q03', 'the six functions are 022''s, with exactly its privileges',
         (select string_agg(x, E'\n' order by x) from fn) = (select string_agg(x, E'\n' order by x) from fn_post),
         (select string_agg(split_part(x, ' ', 1) || ' ' || left(split_part(x, ' ', 2), 8), ', ' order by x) from fn)
  union all
  select 'post', 'Q04', 'the status guard fires on status and provider_order_id',
         (select d from guard_trigger) = 'CREATE TRIGGER trading_orders_status_guard BEFORE UPDATE OF status, provider_order_id ON public.trading_orders FOR EACH ROW EXECUTE FUNCTION guard_order_status_transition()',
         coalesce((select d from guard_trigger), 'missing')
  union all
  select 'post', 'Q05', 'row-level security on every table, 21 policies',
         not exists (select 1 from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' and not c.relrowsecurity)
           and (select count(*) from pg_policies where schemaname = 'public') = 21,
         (select count(*) from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' and c.relrowsecurity)
           || ' tables with RLS, ' || (select count(*) from pg_policies where schemaname = 'public') || ' policies'
  union all
  select 'post', 'Q06', 'no migration history written',
         (select n from history) = 0,
         case when (select present from history) then 'schema_migrations has ' || (select n from history) || ' rows'
              else 'no schema_migrations table' end
  -- ---------------------------------------------------------------- both: the money is consistent
  union all
  select ph.phase, ph.prefix || '1', 'every order''s lock equals its ledger rows',
         (select lock_vs_ledger from money) = 0, (select lock_vs_ledger from money) || ' orders differ'
  from (values ('pre', 'M'), ('post', 'N')) ph(phase, prefix)
  union all
  select ph.phase, ph.prefix || '2', 'every filled amount equals its trades',
         (select filled_vs_trades from money) = 0, (select filled_vs_trades from money) || ' orders differ'
  from (values ('pre', 'M'), ('post', 'N')) ph(phase, prefix)
  union all
  select ph.phase, ph.prefix || '3', 'funds are locked only by live orders, never by an OPEN order with fills',
         (select stray_locks + open_with_fills from money) = 0,
         (select stray_locks from money) || ' stray locks, ' || (select open_with_fills from money) || ' OPEN orders with fills'
  from (values ('pre', 'M'), ('post', 'N')) ph(phase, prefix)
  union all
  select ph.phase, ph.prefix || '4', 'no order ledger row without its order',
         (select orphan_order_rows from money) = 0, (select orphan_order_rows from money) || ' rows'
  from (values ('pre', 'M'), ('post', 'N')) ph(phase, prefix)
  union all
  select ph.phase, ph.prefix || '5', 'every wallet equals its ledger (reconcile_wallets)',
         (select wallet_drift from money) = 0, (select wallet_drift from money) || ' wallets differ'
  from (values ('pre', 'M'), ('post', 'N')) ph(phase, prefix)
)
select c.phase, c.id, c.name, c.ok, c.detail from checks c
union all
select v.phase, v.id, 'VERDICT', coalesce(bool_and(c.ok), false),
       case when coalesce(bool_and(c.ok), false) then v.yes else v.no end
from (values ('pre', 'P99', 'READY', 'BLOCKED'), ('post', 'Q99', 'PASS', 'FAIL')) v(phase, id, yes, no)
left join checks c on c.phase = v.phase
group by v.phase, v.id, v.yes, v.no
union all
select 'data', c.relname, 'rows', true,
       (xpath('/row/n/text()', query_to_xml(format('select count(*) as n from public.%I', c.relname), false, true, '')))[1]::text
       || ' md5=' || (xpath('/row/h/text()', query_to_xml(format(
            'select md5(coalesce(string_agg(t::text, %L order by t::text), %L)) as h from public.%I t', E'\n', '', c.relname),
            false, true, '')))[1]::text
from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'
order by 1 desc, 2
$checks$;
  v_fail   text;
  v_before text;
  v_after  text;
begin
  -- ----------------------------------------------------------------- 0. limits
  perform set_config('lock_timeout', '5s', true);

  -- ------------------------------------------------------------------ 1. texts
  if md5(v022) <> '632fb1e868bf047954155b7b393baa73' or md5(v_checks) <> '70630ce9f65d527ab8ccb5c6297b0dd5' then
    raise exception 'upgrade 021->022: the embedded texts are not the reviewed ones; nothing was changed';
  end if;

  -- ------------------------------------------------------------------- 2. lock
  execute (select 'lock table ' || string_agg(format('public.%I', c.relname), ', ' order by c.relname)
                  || ' in share row exclusive mode'
             from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'r');

  -- -------------------------------------------------------------- 3. preflight
  execute 'select string_agg(c.id || '' '' || c.name || '': '' || coalesce(c.detail, ''-''), E''\n'' order by c.id) from ('
          || v_checks || ') c where c.phase = ''pre'' and not c.ok' into v_fail;
  if v_fail is not null then
    raise exception 'upgrade 021->022: preflight refused; nothing was changed' using detail = v_fail;
  end if;

  -- --------------------------------------------------------------- 4. snapshot
  execute 'select string_agg(c.id || '' '' || c.detail, E''\n'' order by c.id) from ('
          || v_checks || ') c where c.phase = ''data''' into v_before;

  -- ------------------------------------------------------------------ 5. apply
  execute v022;

  -- ------------------------------------------------------------- 6. postflight
  execute 'select string_agg(c.id || '' '' || c.name || '': '' || coalesce(c.detail, ''-''), E''\n'' order by c.id) from ('
          || v_checks || ') c where c.phase = ''post'' and not c.ok' into v_fail;
  if v_fail is not null then
    raise exception 'upgrade 021->022: postflight refused; nothing was changed' using detail = v_fail;
  end if;

  -- -------------------------------------------------------------- 7. unchanged
  execute 'select string_agg(c.id || '' '' || c.detail, E''\n'' order by c.id) from ('
          || v_checks || ') c where c.phase = ''data''' into v_after;
  if v_after is distinct from v_before then
    raise exception 'upgrade 021->022: rows changed while 022 ran; nothing was changed'
      using detail = 'before:' || E'\n' || coalesce(v_before, '-') || E'\nafter:\n' || coalesce(v_after, '-');
  end if;
end
$upgrade$;

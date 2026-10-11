-- =============================================================================
-- JimoCex — 017_money_integrity
--
-- Closes the database half of the money boundary. 016 made the two
-- numeric-returning functions return text; this migration covers what an audit
-- of the whole chain found beyond that:
--
--   PostgreSQL numeric(38,18) -> PostgREST -> string -> Money (BigInt)
--     -> business logic -> Money -> decimal string -> numeric(38,18)
--
-- 1. NaN. PostgreSQL's numeric accepts 'NaN', orders it ABOVE every number and
--    treats NaN = NaN as true. So `check (available_balance >= 0)` passes for
--    NaN, and one NaN posted through ledger_post would turn a wallet's overdraft
--    guard off for good: every later debit passes the CHECK, the ledger sum
--    becomes NaN, and reconcile_wallets compares NaN = NaN and reports nothing.
--    Every writable money column now refuses it.
--
-- 2. ledger_post. It read a NULL delta as zero, so a JavaScript NaN or Infinity
--    — which JSON.stringify writes as `null` — posted a one-sided entry that
--    created funds and that reconciliation could not see. Its parameters are
--    unconstrained numeric, so a delta with a 19th decimal was rounded
--    separately into the ledger row and into the wallet, and the two drifted
--    apart. It now refuses missing, NaN, infinite and over-precise figures
--    instead of coercing them.
--
-- 3. reconcile_wallets started from wallets with a LEFT JOIN, so a wallet row
--    that disappeared took its ledger with it out of the report. It now joins
--    from both sides.
--
-- 4. consume_quote returned a whole swap_quotes row, so the rate, fee and
--    output amount the swap must use reached JavaScript as JSON numbers. It now
--    returns them as text, like every other money-returning function.
--
-- 5. limit_usage_total replaces the aggregate 016 removed. Summing rows in the
--    application read only the first page PostgREST returns (Supabase caps a
--    response at 1000 rows by default), so a busy window was under-counted and
--    a limit could be exceeded. The sum is exact in numeric and leaves the
--    database as text. It also filters by quote currency, which the old
--    aggregate did not.
--
-- 6. service_role could write wallets and ledger_entries directly, although
--    004 states that only ledger_post may change a balance. Those writes are
--    revoked; ledger_post and release_withdrawal_hold are SECURITY DEFINER and
--    keep working. TRUNCATE — granted to every client role by Supabase's
--    defaults, and not covered by the row-level append-only triggers — is
--    revoked on every money table, and refused outright on the two append-only
--    ones.
--
-- 7. Least privilege on functions. Every callable function was already limited
--    to service_role, but the seven trigger functions kept EXECUTE for PUBLIC,
--    anon, authenticated and service_role, and the schema's default privileges
--    granted EXECUTE on every NEW function to all three client roles — so a
--    migration that forgot its REVOKE would publish a function at
--    /rest/v1/rpc. Trigger functions now grant EXECUTE to nobody (a trigger
--    does not need it to fire), new functions start with no client grant, and
--    src/lib/db/money-columns.ts states exactly who may execute each function;
--    scripts/test-db.sh fails on any difference.
--
-- DEPLOYMENT ORDER. Apply 016 and this migration to the hosted project BEFORE
-- deploying an application build that contains the matching LimitEngine: the
-- engine reads window usage through limit_usage_total() and, if the function
-- is missing, answers UNAVAILABLE for every operation with a DAILY or MONTHLY
-- limit. That fails closed — nothing is approved wrongly — but it stops those
-- operations until the database catches up.
--
-- Arithmetic convention for every function from here on: SQL stores, adds,
-- subtracts, sums and compares money. It does not multiply, divide or round
-- it — PostgreSQL's numeric division picks its own result scale and its
-- assignment rounding is half-away-from-zero, neither of which matches the
-- rounding mode a given quantity needs. Derived amounts are computed in
-- TypeScript with an explicit rounding mode (src/lib/money.ts) and arrive here
-- as decimal strings. No float type appears anywhere; scripts/test-db.sh
-- fails if one does.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. No money column accepts NaN.
--
-- Generated columns (trading_orders.remaining_amount, withdrawals.net_amount)
-- are derived from columns constrained here, so they cannot become NaN either.
-- scripts/test-db.sh checks that every money column in the registry carries one
-- of these constraints.
-- -----------------------------------------------------------------------------

alter table public.wallets
  add constraint wallets_available_balance_not_nan check (available_balance <> 'NaN'::numeric),
  add constraint wallets_locked_balance_not_nan    check (locked_balance <> 'NaN'::numeric);

alter table public.ledger_entries
  add constraint ledger_entries_amount_not_nan          check (amount <> 'NaN'::numeric),
  add constraint ledger_entries_available_delta_not_nan check (available_delta <> 'NaN'::numeric),
  add constraint ledger_entries_locked_delta_not_nan    check (locked_delta <> 'NaN'::numeric);

alter table public.trading_orders
  add constraint trading_orders_price_not_nan         check (price <> 'NaN'::numeric),
  add constraint trading_orders_amount_not_nan        check (amount <> 'NaN'::numeric),
  add constraint trading_orders_filled_amount_not_nan check (filled_amount <> 'NaN'::numeric),
  add constraint trading_orders_average_price_not_nan check (average_price <> 'NaN'::numeric),
  add constraint trading_orders_locked_amount_not_nan check (locked_amount <> 'NaN'::numeric);

alter table public.trades
  add constraint trades_price_not_nan        check (price <> 'NaN'::numeric),
  add constraint trades_amount_not_nan       check (amount <> 'NaN'::numeric),
  add constraint trades_quote_amount_not_nan check (quote_amount <> 'NaN'::numeric),
  add constraint trades_fee_not_nan          check (fee <> 'NaN'::numeric);

alter table public.swap_quotes
  add constraint swap_quotes_from_amount_not_nan   check (from_amount <> 'NaN'::numeric),
  add constraint swap_quotes_rate_not_nan          check (rate <> 'NaN'::numeric),
  add constraint swap_quotes_fee_not_nan           check (fee <> 'NaN'::numeric),
  add constraint swap_quotes_output_amount_not_nan check (output_amount <> 'NaN'::numeric);

alter table public.swap_orders
  add constraint swap_orders_from_amount_not_nan check (from_amount <> 'NaN'::numeric),
  add constraint swap_orders_to_amount_not_nan   check (to_amount <> 'NaN'::numeric),
  add constraint swap_orders_rate_not_nan        check (rate <> 'NaN'::numeric),
  add constraint swap_orders_fee_not_nan         check (fee <> 'NaN'::numeric);

alter table public.deposits
  add constraint deposits_amount_not_nan check (amount <> 'NaN'::numeric);

alter table public.withdrawals
  add constraint withdrawals_amount_not_nan check (amount <> 'NaN'::numeric),
  add constraint withdrawals_fee_not_nan    check (fee <> 'NaN'::numeric);

alter table public.tier_limits
  add constraint tier_limits_max_amount_not_nan check (max_amount <> 'NaN'::numeric),
  add constraint tier_limits_min_amount_not_nan check (min_amount <> 'NaN'::numeric);

alter table public.fee_rules
  add constraint fee_rules_percentage_not_nan check (percentage <> 'NaN'::numeric),
  add constraint fee_rules_fixed_fee_not_nan  check (fixed_fee <> 'NaN'::numeric),
  add constraint fee_rules_min_fee_not_nan    check (min_fee <> 'NaN'::numeric),
  add constraint fee_rules_max_fee_not_nan    check (max_fee <> 'NaN'::numeric);

alter table public.trading_pairs
  add constraint trading_pairs_min_order_size_not_nan check (min_order_size <> 'NaN'::numeric),
  add constraint trading_pairs_max_order_size_not_nan check (max_order_size <> 'NaN'::numeric);

alter table public.limit_usage
  add constraint limit_usage_usd_equivalent_not_nan check (usd_equivalent <> 'NaN'::numeric);

-- -----------------------------------------------------------------------------
-- 2. ledger_post refuses what it used to coerce.
--
-- Same signature, so the REVOKE from 004 and the callers in 007 are unaffected.
-- Every refusal happens before the wallet lock is taken and before anything is
-- written.
-- -----------------------------------------------------------------------------

create or replace function public.ledger_post(
  p_user_id         uuid,
  p_asset_id        uuid,
  p_entry_type      public.ledger_entry_type,
  p_amount          numeric,
  p_available_delta numeric,
  p_locked_delta    numeric,
  p_reference_type  text    default null,
  p_reference_id    uuid    default null,
  p_dedup_key       text    default null,
  p_metadata        jsonb   default '{}'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_entry_id uuid;
begin
  -- A missing figure is not zero. JSON.stringify writes a JavaScript NaN or
  -- Infinity as null, so reading null as 0 is how a broken calculation upstream
  -- becomes a one-sided posting. Callers pass '0' explicitly.
  if p_amount is null or p_available_delta is null or p_locked_delta is null then
    raise exception 'ledger_post: amount and both deltas are required (got %, %, %)',
      p_amount, p_available_delta, p_locked_delta
      using errcode = 'not_null_violation';
  end if;

  -- NaN compares greater than every number, so it would pass every CHECK below
  -- and disable them for the wallet permanently. Infinity cannot be stored in
  -- numeric(38,18) anyway; refusing it here gives the same message as NaN.
  -- More than 18 fractional digits would be rounded once into the ledger row
  -- and again, differently, into the wallet sum — so it is refused rather than
  -- rounded. The application never sends one: src/lib/money.ts renders at most
  -- 18 digits.
  if exists (
    select 1
    from unnest(array[p_amount, p_available_delta, p_locked_delta]) as v(x)
    where x = 'NaN'::numeric
       or x in ('Infinity'::numeric, '-Infinity'::numeric)
       or x <> round(x, 18)
  ) then
    raise exception 'ledger_post: amounts must be finite decimals with at most 18 fractional digits (got %, %, %)',
      p_amount, p_available_delta, p_locked_delta
      using errcode = 'invalid_parameter_value';
  end if;

  if p_amount < 0 then
    raise exception 'ledger_post: amount must be non-negative, got %', p_amount
      using errcode = 'check_violation';
  end if;

  -- Take the wallet row's lock before touching balances. Two concurrent
  -- withdrawals on one wallet must serialize here, or both could read a
  -- sufficient balance and together overdraw it.
  insert into public.wallets (user_id, asset_id)
  values (p_user_id, p_asset_id)
  on conflict (user_id, asset_id) do nothing;

  perform 1
  from public.wallets
  where user_id = p_user_id and asset_id = p_asset_id
  for update;

  -- The insert comes first so that a duplicate dedup_key aborts the whole
  -- transaction before any balance moves.
  insert into public.ledger_entries (
    user_id, asset_id, entry_type, amount,
    available_delta, locked_delta,
    reference_type, reference_id, dedup_key, metadata
  )
  values (
    p_user_id, p_asset_id, p_entry_type, p_amount,
    p_available_delta, p_locked_delta,
    p_reference_type, p_reference_id, p_dedup_key, coalesce(p_metadata, '{}'::jsonb)
  )
  returning id into v_entry_id;

  -- The CHECK constraints on wallets are the overdraft guard: if this update
  -- would drive either bucket below zero, PostgreSQL raises and the ledger
  -- insert above is rolled back with it.
  update public.wallets
  set available_balance = available_balance + p_available_delta,
      locked_balance    = locked_balance + p_locked_delta
  where user_id = p_user_id and asset_id = p_asset_id;

  return v_entry_id;
end;
$$;

comment on function public.ledger_post is
  'The single entry point for moving money. Writes the immutable ledger entry and
   the wallet projection in one transaction, serialized per wallet. Refuses a
   missing, NaN, infinite or over-precise figure rather than coercing it.
   Executable by service_role only (spec §19.12, §80.9).';

-- -----------------------------------------------------------------------------
-- 3. Reconciliation sees both sides.
--
-- The return type is the one 016 introduced, so this replaces it in place. A
-- ledger whose wallet row is missing is reported with wallet_* NULL.
-- -----------------------------------------------------------------------------

create or replace function public.reconcile_wallets()
returns table (
  user_id            uuid,
  asset_id           uuid,
  wallet_available   text,
  ledger_available   text,
  wallet_locked      text,
  ledger_locked      text
)
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(w.user_id, l.user_id),
         coalesce(w.asset_id, l.asset_id),
         w.available_balance::text,
         coalesce(l.available_sum, 0)::text,
         w.locked_balance::text,
         coalesce(l.locked_sum, 0)::text
  from public.wallets w
  full join (
    select e.user_id,
           e.asset_id,
           sum(e.available_delta) as available_sum,
           sum(e.locked_delta)    as locked_sum
    from public.ledger_entries e
    group by e.user_id, e.asset_id
  ) l on l.user_id = w.user_id and l.asset_id = w.asset_id
  -- Compared in exact numeric. `is distinct from` also reports the missing
  -- wallet; the NaN tests are defence in depth now that section 1 forbids it,
  -- because NaN = NaN is true and would otherwise read as "no drift".
  where w.user_id is null
     or w.available_balance is distinct from coalesce(l.available_sum, 0)
     or w.locked_balance    is distinct from coalesce(l.locked_sum, 0)
     or w.available_balance = 'NaN'::numeric
     or w.locked_balance    = 'NaN'::numeric;
$$;

comment on function public.reconcile_wallets is
  'Wallets whose projection has drifted from their ledger, including a ledger
   with no wallet row (spec §19.10). Compares in exact numeric and returns text,
   so a sub-rounding-step drift cannot be hidden by JSON number serialisation.';

revoke all on function public.reconcile_wallets() from public, anon, authenticated;
grant execute on function public.reconcile_wallets() to service_role;

-- -----------------------------------------------------------------------------
-- 4. consume_quote returns its money as text.
--
-- PostgreSQL cannot change a function's return type in place, hence the DROP.
-- The body is unchanged apart from the projection: same single-winner UPDATE,
-- same single refusal message for every reason a quote is unusable.
-- -----------------------------------------------------------------------------

drop function if exists public.consume_quote(uuid, uuid, text);

create function public.consume_quote(
  p_quote_id   uuid,
  p_user_id    uuid default null,
  p_session_id text default null
)
returns table (
  id              uuid,
  user_id         uuid,
  session_id      text,
  from_asset_id   uuid,
  to_asset_id     uuid,
  from_amount     text,
  rate            text,
  fee             text,
  fee_asset_id    uuid,
  output_amount   text,
  rate_mode       public.rate_mode,
  rate_source     text,
  status          public.quote_status,
  created_at      timestamptz,
  expires_at      timestamptz,
  used_at         timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_quote public.swap_quotes;
begin
  update public.swap_quotes q
  set status  = 'USED',
      used_at = now()
  where q.id = p_quote_id
    and q.status = 'ACTIVE'
    and q.expires_at > now()
    and (
      (p_user_id is not null and q.user_id = p_user_id)
      or (p_session_id is not null and q.session_id = p_session_id)
    )
  returning q.* into v_quote;

  if v_quote.id is null then
    -- Deliberately one message for "expired", "already used", "cancelled" and
    -- "not yours": distinguishing them would tell a caller about quotes that
    -- are not theirs. The caller gets a single, honest refusal.
    raise exception 'quote % is not usable', p_quote_id
      using errcode = 'restrict_violation',
            hint = 'The quote has expired, was already used, or does not belong to this caller.';
  end if;

  return query
  select v_quote.id,
         v_quote.user_id,
         v_quote.session_id,
         v_quote.from_asset_id,
         v_quote.to_asset_id,
         v_quote.from_amount::text,
         v_quote.rate::text,
         v_quote.fee::text,
         v_quote.fee_asset_id,
         v_quote.output_amount::text,
         v_quote.rate_mode,
         v_quote.rate_source,
         v_quote.status,
         v_quote.created_at,
         v_quote.expires_at,
         v_quote.used_at;
end;
$$;

comment on function public.consume_quote is
  'Atomically validates and claims a quote (spec §9). Returns the stored quote —
   money columns as exact text — so the caller uses the server''s own rate and
   fee, and raises if the quote is expired, spent or foreign.';

revoke all on function public.consume_quote(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.consume_quote(uuid, uuid, text) to service_role;

-- -----------------------------------------------------------------------------
-- 5. Window usage, summed where it is exact.
--
-- A new name rather than the one 016 dropped, so an old caller fails loudly
-- instead of receiving text where it expected a number.
-- -----------------------------------------------------------------------------

create function public.limit_usage_total(
  p_user_id        uuid,
  p_operation      public.limit_operation,
  p_quote_currency text,
  p_since          timestamptz
)
returns text
language sql
stable
-- A NULL argument returns NULL — which the engine reads as "usage unknown" and
-- refuses on — instead of matching no rows and reporting zero consumed.
strict
set search_path = ''
as $$
  select coalesce(sum(u.usd_equivalent), 0)::text
  from public.limit_usage u
  where u.user_id = p_user_id
    and u.operation = p_operation
    and u.quote_currency = p_quote_currency
    and u.occurred_at >= p_since;
$$;

comment on function public.limit_usage_total is
  'What a limit window has consumed, in one quote currency, as exact text. The
   LimitEngine calls it per DAILY/MONTHLY rule (spec §25).';

revoke all on function public.limit_usage_total(uuid, public.limit_operation, text, timestamptz)
  from public, anon, authenticated;
grant execute on function public.limit_usage_total(uuid, public.limit_operation, text, timestamptz)
  to service_role;

-- -----------------------------------------------------------------------------
-- 6. Balances move through the ledger, for every role.
-- -----------------------------------------------------------------------------

revoke insert, update, delete on public.wallets from service_role;
revoke insert, update, delete on public.ledger_entries from service_role;

-- TRUNCATE skips row-level triggers, so forbid_mutation never sees it. PostgREST
-- exposes no TRUNCATE, but the privilege should not exist for a client role.
revoke truncate on
  public.wallets, public.ledger_entries, public.trading_orders, public.trades,
  public.swap_quotes, public.swap_orders, public.deposits, public.withdrawals,
  public.tier_limits, public.fee_rules, public.trading_pairs, public.limit_usage
  from anon, authenticated, service_role;

-- And for the append-only ones, not even the owner by accident.
create trigger ledger_entries_no_truncate
  before truncate on public.ledger_entries
  for each statement execute function public.forbid_mutation();

create trigger limit_usage_no_truncate
  before truncate on public.limit_usage
  for each statement execute function public.forbid_mutation();

-- -----------------------------------------------------------------------------
-- 7. Least privilege on functions.
--
-- A trigger function runs because a trigger fires, not because a role calls
-- it; PostgreSQL checks EXECUTE only when the trigger is created. No role
-- needs to be able to call one, and PUBLIC — every role, present and future —
-- certainly does not.
-- -----------------------------------------------------------------------------

revoke all on function
  public.forbid_mutation(),
  public.guard_notification_columns(),
  public.guard_order_status_transition(),
  public.guard_profile_privileged_columns(),
  public.guard_swap_status_transition(),
  public.guard_withdrawal_status_transition(),
  public.touch_updated_at(),
  public.handle_new_user()
  from public, anon, authenticated, service_role;

-- A function created in public from now on starts with no grant for any client
-- role; each migration grants exactly what the function needs. (Per schema:
-- the default for other schemas, and the PUBLIC default that each function's
-- own REVOKE removes, are left as they are.)
alter default privileges for role postgres in schema public
  revoke execute on functions from anon, authenticated, service_role;

-- =============================================================================
-- JimoCex — apply migrations 016 and 017 to the hosted project (package v4)
--
-- Target: Supabase project sykhghtlkcrzwaoehlhf, PostgreSQL 17, role postgres.
-- Source: supabase/migrations at b0ea211 on feature/jimocex-mvp, with 017 as in
--   the working tree under review. The files are identified by content:
--     016_money_functions_return_text.sql  sha256 73d599bbcc9484e369c073e8a4134504fd8e17d8b4df9ead11e984d2385111cf
--     017_money_integrity.sql              sha256 efbc5be4286992df8f490928a8915a83c125e4d1929f3dd00c708e4bbe6b431f
--   Each file's text appears once below (without its final newline): it is
--   executed from that constant and written to the history from it.
--
-- THE WHOLE FILE IS ONE SQL STATEMENT (a DO block). PostgreSQL runs a single
-- statement atomically: if anything fails, nothing is applied and nothing is
-- recorded, however the client sends it and whether or not it wraps it in a
-- transaction. There is no BEGIN/COMMIT to honour and no session state to keep.
--
-- HOW TO RUN (either):
--   psql (preferred, behaviour fully known):
--     psql "<connection string of the project's direct or session-pooler
--     connection>" -X -v ON_ERROR_STOP=1 -f apply_016_017.sql
--   Supabase SQL Editor: paste the WHOLE file, select nothing, run as postgres,
--     confirm the destructive-operation prompt.
-- Success prints DO (psql) or "Success. No rows returned" (editor). On any
-- error nothing has changed: keep the error text, do not edit or re-run.
--
-- Inside the statement, in order:
--   0. LIMITS     lock_timeout 5s for the rest of the statement (017 takes
--                 ACCESS EXCLUSIVE locks on money tables); a pg_temp helper
--                 that renders the schema fingerprint, dropped at the end.
--   1. PREFLIGHT  refuses unless the database is exactly the 015 state this
--                 file was built against: role, server version, the full
--                 migration history (versions, names, statement text), the
--                 exact shape of every function 016/017 replace, no data the
--                 new constraints would refuse, the md5 of the embedded 016
--                 and 017 text, and a fingerprint of the whole public schema
--                 (87f076b63039e2816cd0cec03594683d, 1240 items).
--   2. APPLY      EXECUTE 016, then EXECUTE 017.
--   3. POSTFLIGHT refuses unless the result is what 016/017 intend,
--                 explicitly (functions, constraints, privileges, defaults,
--                 TRUNCATE guards) and as a whole (fingerprint of a clean
--                 001–017 build: f48db42ea4cdfa14599f3f05197e2353, 1191 items).
--   4. HISTORY    two rows in supabase_migrations.schema_migrations, in the
--                 format of the existing rows (version = UTC timestamp of this
--                 run, name, statements = the text executed in 2). created_by
--                 is left NULL: this file cannot know who runs it.
--   5. CHECK      the history now holds exactly 001–017 with the right text.
-- =============================================================================

do $apply$
declare
  v016 constant text := $mig016$-- =============================================================================
-- JimoCex — 016_money_functions_return_text
--
-- Two places where an exact `numeric` could become a JavaScript double. (A
-- third, consume_quote's row-typed result, was missed here; 017 closes it,
-- together with the rest of the database half of the money boundary.)
--
-- PostgREST serialises `numeric` as a bare JSON number, and `JSON.parse` turns
-- that into an IEEE-754 double — about 16 significant digits against the 38 a
-- numeric(38,18) carries. Measured on this database:
--
--     stored     1234567890123456.123456789012345678
--     received   1234567890123456
--
-- Table columns are protected at the call site: every select casts them with
-- `::text` through src/lib/db/money-columns.ts, and a test fails the build if
-- one is read raw. A function's return type cannot be cast that way, so the two
-- functions that hand money back are changed here instead.
--
-- The arithmetic inside them is unchanged and still exact. `sum()` over numeric
-- is computed in numeric and the comparison in reconcile_wallets stays in
-- numeric; only the rendered result becomes text.
--
-- -----------------------------------------------------------------------------
-- Applying it to the hosted project
-- -----------------------------------------------------------------------------
--
-- PostgreSQL will not change a function's return type in place, so this
-- migration needs DROP FUNCTION. The Supabase MCP tool used to apply 001–015
-- holds any destructive statement for the user's confirmation; in a session
-- that cannot show that prompt the call simply times out. The statement never
-- reaches the database (the hosted Postgres log records the CREATE OR REPLACE
-- probes but no DROP) — it was first misread as a hang. 016 and 017 are applied
-- to the hosted project from the SQL editor, or through the MCP tool with the
-- confirmation granted.
--
-- scripts/test-db.sh applies this file to a fresh cluster on every run, so the
-- SQL below is exercised regardless.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Remove the usage aggregate.
--
-- It returned numeric, which reaches JavaScript as a rounded JSON number. Its
-- replacement is limit_usage_total() in 017, which sums the same rows in exact
-- numeric and returns text. (Summing the rows in the application instead, as
-- first planned, under-counts: PostgREST caps a response at 1000 rows.)
-- -----------------------------------------------------------------------------

drop function if exists public.limit_usage_in_window(uuid, public.limit_operation, timestamptz);

-- -----------------------------------------------------------------------------
-- 2. Reconciliation returns text.
--
-- This one matters more than it looks. The entire purpose of
-- reconcile_wallets() is to detect a wallet whose balance has drifted from its
-- ledger. If both sides were rounded to a double on the way out, a drift
-- smaller than the rounding step would become invisible — the check would
-- report "no drift" precisely when the drift is subtle enough to be dangerous.
-- -----------------------------------------------------------------------------

drop function if exists public.reconcile_wallets();

create function public.reconcile_wallets()
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
  select w.user_id,
         w.asset_id,
         w.available_balance::text,
         coalesce(l.available_sum, 0)::text,
         w.locked_balance::text,
         coalesce(l.locked_sum, 0)::text
  from public.wallets w
  left join (
    select e.user_id,
           e.asset_id,
           sum(e.available_delta) as available_sum,
           sum(e.locked_delta)    as locked_sum
    from public.ledger_entries e
    group by e.user_id, e.asset_id
  ) l on l.user_id = w.user_id and l.asset_id = w.asset_id
  -- The comparison stays in exact numeric, so a drift of any size is caught;
  -- only the reported values are rendered as text.
  where w.available_balance <> coalesce(l.available_sum, 0)
     or w.locked_balance    <> coalesce(l.locked_sum, 0);
$$;

comment on function public.reconcile_wallets is
  'Wallets whose projection has drifted from their ledger (spec §19.10). Compares
   in exact numeric and returns text, so a sub-rounding-step drift cannot be
   hidden by JSON number serialisation.';

revoke all on function public.reconcile_wallets() from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- 3. Remove the diagnostic probe.
--
-- Created while diagnosing why DROP FUNCTION did not complete through the MCP
-- path (see the header: the statement was waiting for a confirmation, not on the
-- database). Removed here.
-- -----------------------------------------------------------------------------

drop function if exists public._jimocex_ddl_probe();$mig016$;
  v017 constant text := $mig017$-- =============================================================================
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
--    ones. The table comment on wallets is restated to say so: the hosted
--    project carries the wording 004 was applied with, which named only the
--    client roles.
--
-- 7. Least privilege on functions. Every callable function was already limited
--    to service_role, but the seven trigger functions kept EXECUTE for PUBLIC,
--    anon, authenticated and service_role, and every NEW function received
--    EXECUTE twice over: from the schema's default privileges (anon,
--    authenticated, service_role) and from PostgreSQL's built-in default
--    (PUBLIC, which every role inherits) — so a migration that forgot its
--    REVOKE would publish a function at /rest/v1/rpc. Trigger functions now
--    grant EXECUTE to nobody (a trigger does not need it to fire), a new
--    function is executable by its owner only until a migration grants more,
--    and src/lib/db/money-columns.ts states exactly who may execute each
--    function; scripts/test-db.sh fails on any difference.
--
-- 8. Two sign invariants the schema implied but did not state, and the last
--    client write grants on money tables:
--      * trading_orders.average_price is the volume-weighted average of the
--        order's trades.price, which trades_price_positive keeps above zero.
--        It is NULL until the first fill and positive after it; zero is not a
--        state any order can be in.
--      * ledger_entries.amount is the entry's unsigned magnitude (004); the
--        direction is carried by the two signed deltas. Every posting scheme
--        in 004 moves a non-zero X, ledger_entry_moves_something already
--        requires a non-zero delta, and the one posting in the schema today
--        (release_withdrawal_hold) passes withdrawals.amount, which is > 0. A
--        zero amount with a non-zero delta is a posting that misreports what
--        it moved; ledger_post refuses it before writing anything, and the
--        table refuses it for any other writer.
--      * tier_limits and trading_pairs still granted INSERT/UPDATE/DELETE to
--        anon and authenticated from Supabase's default grants. The
--        application only reads them; RLS has no write policy for either, so
--        the grants were unusable — they go, and the read policies stay.
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

  -- The amount is what the entry moves; an entry that moves nothing is refused
  -- by ledger_entry_moves_something, and one that claims to move nothing while
  -- its deltas move funds is refused here.
  if p_amount <= 0 then
    raise exception 'ledger_post: amount must be positive, got %', p_amount
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

comment on table public.wallets is
  'Derived projection of ledger_entries, not an independent source of truth
   (spec §18). Only public.ledger_post() may change a balance: INSERT, UPDATE,
   DELETE and TRUNCATE are revoked from anon, authenticated and service_role.';

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

-- A function postgres creates from now on is executable by its owner only;
-- each migration grants exactly what the function needs. PostgreSQL keeps two
-- layers of default privileges and both granted EXECUTE: the per-schema one,
-- where Supabase grants it to anon, authenticated and service_role in public,
-- and the global one, whose built-in value grants it to PUBLIC. A per-schema
-- rule can only add to the global default, never take from it, so PUBLIC's
-- grant can only be revoked globally — which also covers functions postgres
-- creates in other schemas, as intended. Functions that already exist keep the
-- privileges they have; Supabase's own functions are created by other roles
-- and are not affected.
alter default privileges for role postgres in schema public
  revoke execute on functions from anon, authenticated, service_role;
alter default privileges for role postgres
  revoke execute on functions from public;

-- -----------------------------------------------------------------------------
-- 8. Sign invariants, and no client write privilege on a money table.
-- -----------------------------------------------------------------------------

-- NULL until the first fill; after it, an average of trades.price, which is
-- positive (trades_price_positive).
alter table public.trading_orders
  add constraint trading_orders_average_price_positive
  check (average_price is null or average_price > 0);

-- The magnitude of a movement that ledger_entry_moves_something already requires
-- to be non-zero. Supersedes 004's ledger_amount_non_negative (amount >= 0),
-- which is left in place: it is implied, and dropping it buys nothing.
alter table public.ledger_entries
  add constraint ledger_entries_amount_positive check (amount > 0);

-- RLS already refuses these writes (no write policy exists); the grants go too,
-- so the refusal does not rest on RLS alone. SELECT and the *_public_read
-- policies are unchanged.
revoke insert, update, delete on public.tier_limits, public.trading_pairs from anon, authenticated;$mig017$;
  v_actual   text;
  v_expected text;
begin
  -- ---------------------------------------------------------------- 0. limits
  perform set_config('lock_timeout', '5s', true);

  create function pg_temp.jimocex_schema_items()
  returns setof text
  language sql
  stable
  set search_path = pg_catalog, public
  as $fp$
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
  select 'defacl ' || case when d.defaclnamespace = 0 then 'global' else 'public' end || ' ' || d.defaclobjtype::text || ' '
         || case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end || ' ' || a.privilege_type
  from pg_default_acl d, aclexplode(d.defaclacl) a
  where d.defaclnamespace in (0, 'public'::regnamespace) and pg_get_userbyid(d.defaclrole) = 'postgres'
  union all
  select 'nspacl ' || case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end || ' ' || a.privilege_type
  from pg_namespace n, aclexplode(n.nspacl) a
  where n.nspname = 'public'
    and (a.grantee = 0 or a.grantee in (select oid from pg_roles where rolname in ('anon','authenticated','service_role')))
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
  union all
  select 'tier ' || tl.tier_code || ' ' || tl.operation::text || ' ' || tl.window_kind::text || ' '
         || coalesce(tl.max_amount::text, 'null') || ' ' || coalesce(tl.min_amount::text, 'null') || ' '
         || tl.quote_currency || ' ' || tl.is_active::text
  from public.tier_limits tl
  ) f
  $fp$;

  -- ------------------------------------------------------------- 1. preflight
  if md5(v016) <> '5f7d9d01cee5c693baf55626e487e3cb' or md5(v017) <> 'e83898e978d513ffac57f77e4def931f' then
    raise exception 'preflight: the embedded 016/017 text is not the text this file was built from';
  end if;
  if current_user <> 'postgres' then
    raise exception 'preflight: run as postgres, not %', current_user;
  end if;
  if current_setting('server_version_num')::integer / 10000 <> 17 then
    raise exception 'preflight: expected PostgreSQL 17, found %', current_setting('server_version');
  end if;

  -- The history is exactly 001–015, as recorded on this project.
  select string_agg(version || ' ' || coalesce(name, '-') || ' ' || coalesce(array_length(statements, 1), 0)::text
                    || ' ' || coalesce(md5(statements[1]), '-'), E'\n' order by version)
    into v_actual
  from supabase_migrations.schema_migrations;
  v_expected := $x$20261010162334 001_initial_schema 1 8455d51de02e38615af632dc29857909
20261010163011 002_account_tiers 1 35b25a34fdbe67b554444f324bde310f
20261010163304 003_assets_pairs 1 13bd8855fe9634835be856fe927debf4
20261010163345 004_wallets_ledger 1 2265b618e6e105224d3492d7484dffa6
20261010163453 005_orders_trades 1 c4e61c777a41857d7168d35c91ab0c01
20261010163557 006_swaps 1 4269dc5860711d41bbd602ed7f177428
20261010163845 007_deposits_withdrawals 1 a2e8b31c89c82bba072bad3482c44920
20261010163928 008_fees_kyc_risk 1 b09175242cc3e2938b7379a6dfe552f1
20261010164021 009_audit_idempotency_events 1 0e7d9e9d1325828c2882a2c1f9385f4b
20261010164158 010_rls 1 fdb6b8beef2ae7cc683e121a5deb253a
20261010164332 011_seed_reference_data 1 e7752de23a2b2029bf2dcf7066c3664f
20261010170148 012_harden_functions 1 8204ac70615c4dc1de333145a85461c7
20261010172408 013_account_status_restricted 1 5bc684f495369e647c97fe99978acd2f
20261010172555 014_limit_usage 1 d7d5983a4811c8c422bc4e05b0005eb1
20261010175618 015_tier0_exchange_trade_limits 1 a16b15d009dc9a77acf2c05cc5e3442a$x$;
  if v_actual is distinct from v_expected then
    raise exception 'preflight: the migration history is not exactly 001-015 as recorded on this project'
      using detail = 'found:' || E'\n' || coalesce(v_actual, '(no rows)');
  end if;

  -- Every function 016/017 drop or replace has exactly its 015 shape:
  -- signature, result, language, security, volatility, owner, settings, body.
  select string_agg(x, E'\n' order by x collate "C") into v_actual
  from pg_temp.jimocex_schema_items() x
  where x ~ '^fn (consume_quote|ledger_post|limit_usage_in_window|limit_usage_total|reconcile_wallets|_jimocex_ddl_probe)\(';
  v_expected := $x$fn _jimocex_ddl_probe() -> text kind=f lang=sql secdef=false strict=false vol=i owner=postgres cfg= src=0e630c3633ca132ac1d9562db73b1a99 comment=9561693f010f08119929d4e0d27e676d
fn consume_quote(p_quote_id uuid, p_user_id uuid, p_session_id text) -> swap_quotes kind=f lang=plpgsql secdef=true strict=false vol=v owner=postgres cfg=search_path="" src=15c409d0ed886a00741bc18a642f9ea4 comment=67528be84ceea31191a05fa5ad2f5188
fn ledger_post(p_user_id uuid, p_asset_id uuid, p_entry_type ledger_entry_type, p_amount numeric, p_available_delta numeric, p_locked_delta numeric, p_reference_type text, p_reference_id uuid, p_dedup_key text, p_metadata jsonb) -> uuid kind=f lang=plpgsql secdef=true strict=false vol=v owner=postgres cfg=search_path="" src=d929ea3d709a8b533ec39a8db61bddeb comment=b3ef1217d6b5eff0eb70ed8c5da6b381
fn limit_usage_in_window(p_user_id uuid, p_operation limit_operation, p_since timestamp with time zone) -> numeric kind=f lang=sql secdef=true strict=false vol=s owner=postgres cfg=search_path="" src=7b6d878a8baaf7c2ed97c5e26781e214 comment=d41d8cd98f00b204e9800998ecf8427e
fn reconcile_wallets() -> TABLE(user_id uuid, asset_id uuid, wallet_available numeric, ledger_available numeric, wallet_locked numeric, ledger_locked numeric) kind=f lang=sql secdef=true strict=false vol=s owner=postgres cfg=search_path="" src=5c3e3e42aca74439ab6634abf4af2f72 comment=d41d8cd98f00b204e9800998ecf8427e$x$;
  if v_actual is distinct from v_expected then
    raise exception 'preflight: the functions 016/017 replace are not in their 015 shape'
      using detail = 'found:' || E'\n' || coalesce(v_actual, '(none)');
  end if;

  -- No stored value that 017's new constraints would refuse.
  if exists (select 1 from public.wallets where available_balance = 'NaN' or locked_balance = 'NaN')
     or exists (select 1 from public.ledger_entries where amount = 'NaN' or available_delta = 'NaN' or locked_delta = 'NaN')
     or exists (select 1 from public.trading_orders where price = 'NaN' or amount = 'NaN' or filled_amount = 'NaN' or average_price = 'NaN' or locked_amount = 'NaN')
     or exists (select 1 from public.trades where price = 'NaN' or amount = 'NaN' or quote_amount = 'NaN' or fee = 'NaN')
     or exists (select 1 from public.swap_quotes where from_amount = 'NaN' or rate = 'NaN' or fee = 'NaN' or output_amount = 'NaN')
     or exists (select 1 from public.swap_orders where from_amount = 'NaN' or to_amount = 'NaN' or rate = 'NaN' or fee = 'NaN')
     or exists (select 1 from public.deposits where amount = 'NaN')
     or exists (select 1 from public.withdrawals where amount = 'NaN' or fee = 'NaN')
     or exists (select 1 from public.tier_limits where max_amount = 'NaN' or min_amount = 'NaN')
     or exists (select 1 from public.fee_rules where percentage = 'NaN' or fixed_fee = 'NaN' or min_fee = 'NaN' or max_fee = 'NaN')
     or exists (select 1 from public.trading_pairs where min_order_size = 'NaN' or max_order_size = 'NaN')
     or exists (select 1 from public.limit_usage where usd_equivalent = 'NaN') then
    raise exception 'preflight: a money column holds NaN';
  end if;
  if exists (select 1 from public.ledger_entries where amount <= 0) then
    raise exception 'preflight: a ledger entry has a non-positive amount';
  end if;
  if exists (select 1 from public.trading_orders where average_price <= 0) then
    raise exception 'preflight: an order has a non-positive average price';
  end if;

  -- The whole public schema is the state this file was built against.
  select md5(string_agg(x, E'\n' order by x collate "C")) || ' ' || count(*) into v_actual
  from pg_temp.jimocex_schema_items() x;
  if v_actual is distinct from '87f076b63039e2816cd0cec03594683d 1240' then
    select string_agg(distinct split_part(l, ' ', 1), ', ') into v_expected from (
      select l from unnest(string_to_array($x$cmt 21 299b4c3342a586557d76885f1cc7130e
col 277 22f8b1407dba0cf8a6b99a55439c0448
con 139 ebffdfd2ecd4a92170e738290e83cfd2
defacl 48 e43554fdee1b7f0420fed47158c09ea9
enum 23 7e8df1e2362fbcb93654cd34fc7a2f5c
fn 20 9c53e3c3641e882254fe940c888d5e23
fnacl 41 88ba19694641dbf5feb65cf7e4e44ec9
idx 89 17ba2c1343ecd4e4623257b5d4e88411
nspacl 4 2234b7ac1ecfffba12e7a1ae3ebab139
pol 21 c67636e4695253bbe6248788bca8272b
rel 23 e2a9bdb7a79a3e1607739e8f17478753
relacl 458 8b664c353fa8cd676f85b20ba78cb569
tier 52 1febf6eb1ac505fe2bda119f148424e4
trg 24 a73f83643885bcf823cf59f123e209be$x$, E'\n')) l
      except
      select split_part(x, ' ', 1) || ' ' || count(*) || ' ' || md5(string_agg(x, E'\n' order by x collate "C"))
      from pg_temp.jimocex_schema_items() x group by split_part(x, ' ', 1)
    ) d;
    raise exception 'preflight: the public schema differs from the state this file was built against'
      using detail = 'fingerprint ' || v_actual || '; differing categories: ' || coalesce(v_expected, '(new categories only)');
  end if;

  -- ----------------------------------------------------------------- 2. apply
  execute v016;
  execute v017;

  -- ------------------------------------------------------------ 3. postflight
  -- The functions, exactly as a clean 001–017 build has them; the dropped ones gone in any signature.
  select string_agg(x, E'\n' order by x collate "C") into v_actual
  from pg_temp.jimocex_schema_items() x
  where x ~ '^fn (consume_quote|ledger_post|limit_usage_in_window|limit_usage_total|reconcile_wallets|_jimocex_ddl_probe)\(';
  v_expected := $x$fn consume_quote(p_quote_id uuid, p_user_id uuid, p_session_id text) -> TABLE(id uuid, user_id uuid, session_id text, from_asset_id uuid, to_asset_id uuid, from_amount text, rate text, fee text, fee_asset_id uuid, output_amount text, rate_mode rate_mode, rate_source text, status quote_status, created_at timestamp with time zone, expires_at timestamp with time zone, used_at timestamp with time zone) kind=f lang=plpgsql secdef=true strict=false vol=v owner=postgres cfg=search_path="" src=0588bab8b568ff2dcbf0fa8e5d2dd15d comment=ed5d13367e266c649a0531b374e2b4d0
fn ledger_post(p_user_id uuid, p_asset_id uuid, p_entry_type ledger_entry_type, p_amount numeric, p_available_delta numeric, p_locked_delta numeric, p_reference_type text, p_reference_id uuid, p_dedup_key text, p_metadata jsonb) -> uuid kind=f lang=plpgsql secdef=true strict=false vol=v owner=postgres cfg=search_path="" src=871c4dbf1ebbcecd5ce149abfe8cc35e comment=7680300c98098e7470eeed217e7d1a8d
fn limit_usage_total(p_user_id uuid, p_operation limit_operation, p_quote_currency text, p_since timestamp with time zone) -> text kind=f lang=sql secdef=false strict=true vol=s owner=postgres cfg=search_path="" src=ecc4316548444ed40ab305db2df72d90 comment=e9e6d58919c621286d87504ed3d7186b
fn reconcile_wallets() -> TABLE(user_id uuid, asset_id uuid, wallet_available text, ledger_available text, wallet_locked text, ledger_locked text) kind=f lang=sql secdef=true strict=false vol=s owner=postgres cfg=search_path="" src=929fe75b537daab39ce520349a29073e comment=13bc3fb4d743b7bac74bf2416e351326$x$;
  if v_actual is distinct from v_expected then
    raise exception 'postflight: the functions are not what 016/017 define'
      using detail = 'found:' || E'\n' || coalesce(v_actual, '(none)');
  end if;
  if exists (select 1 from pg_proc where pronamespace = 'public'::regnamespace
              and proname in ('_jimocex_ddl_probe', 'limit_usage_in_window')) then
    raise exception 'postflight: a function 016 removes still exists';
  end if;

  -- Money columns refuse NaN; the two sign invariants are in place.
  select string_agg(c, ', ') into v_actual
  from unnest(array['wallets_available_balance_not_nan', 'wallets_locked_balance_not_nan', 'ledger_entries_amount_not_nan', 'ledger_entries_available_delta_not_nan', 'ledger_entries_locked_delta_not_nan', 'trading_orders_price_not_nan', 'trading_orders_amount_not_nan', 'trading_orders_filled_amount_not_nan', 'trading_orders_average_price_not_nan', 'trading_orders_locked_amount_not_nan', 'trades_price_not_nan', 'trades_amount_not_nan', 'trades_quote_amount_not_nan', 'trades_fee_not_nan', 'swap_quotes_from_amount_not_nan', 'swap_quotes_rate_not_nan', 'swap_quotes_fee_not_nan', 'swap_quotes_output_amount_not_nan', 'swap_orders_from_amount_not_nan', 'swap_orders_to_amount_not_nan', 'swap_orders_rate_not_nan', 'swap_orders_fee_not_nan', 'deposits_amount_not_nan', 'withdrawals_amount_not_nan', 'withdrawals_fee_not_nan', 'tier_limits_max_amount_not_nan', 'tier_limits_min_amount_not_nan', 'fee_rules_percentage_not_nan', 'fee_rules_fixed_fee_not_nan', 'fee_rules_min_fee_not_nan', 'fee_rules_max_fee_not_nan', 'trading_pairs_min_order_size_not_nan', 'trading_pairs_max_order_size_not_nan', 'limit_usage_usd_equivalent_not_nan']) as c
  where not exists (select 1 from pg_constraint where conname = c and connamespace = 'public'::regnamespace);
  if v_actual is not null then
    raise exception 'postflight: missing NaN constraints: %', v_actual;
  end if;
  if (select count(*) from pg_constraint
       where connamespace = 'public'::regnamespace and conname like '%\_not\_nan') <> 34 then
    raise exception 'postflight: expected exactly 34 NaN constraints';
  end if;
  if (select count(*) from pg_constraint where connamespace = 'public'::regnamespace
       and conname in ('trading_orders_average_price_positive', 'ledger_entries_amount_positive')) <> 2 then
    raise exception 'postflight: the sign constraints are missing';
  end if;

  -- No function in public is executable by anon or authenticated; every callable one
  -- by service_role; no trigger function by any client role.
  select string_agg(p.oid::regprocedure::text, ', ') into v_actual
  from pg_proc p
  where p.pronamespace = 'public'::regnamespace
    and (has_function_privilege('anon', p.oid, 'execute')
      or has_function_privilege('authenticated', p.oid, 'execute')
      or (p.prorettype = 'trigger'::regtype and has_function_privilege('service_role', p.oid, 'execute'))
      or (p.prorettype <> 'trigger'::regtype and not has_function_privilege('service_role', p.oid, 'execute')));
  if v_actual is not null then
    raise exception 'postflight: unexpected EXECUTE privileges on: %', v_actual;
  end if;

  -- A function postgres creates next is executable by no client role: neither through the
  -- global default (the built-in one grants PUBLIC when there is no global row) nor the
  -- per-schema one.
  select string_agg(distinct case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end, ', ')
    into v_actual
  from (
    select coalesce((select d.defaclacl from pg_default_acl d
                      where d.defaclrole = 'postgres'::regrole and d.defaclnamespace = 0 and d.defaclobjtype = 'f'),
                    acldefault('f', 'postgres'::regrole)) as acl
    union all
    select d.defaclacl from pg_default_acl d
    where d.defaclrole = 'postgres'::regrole and d.defaclnamespace = 'public'::regnamespace and d.defaclobjtype = 'f'
  ) l, aclexplode(l.acl) a
  where a.privilege_type = 'EXECUTE'
    and (a.grantee = 0 or a.grantee in (select oid from pg_roles where rolname in ('anon', 'authenticated', 'service_role')));
  if v_actual is not null then
    raise exception 'postflight: a new function would be executable by default by: %', v_actual;
  end if;

  -- Money tables: anon and authenticated write nothing; nobody but the owner truncates;
  -- service_role writes neither wallets nor ledger_entries.
  select string_agg(r.role || ' ' || p.priv || ' ' || t.tbl, ', ') into v_actual
  from (values ('anon'), ('authenticated'), ('service_role')) r(role),
       unnest(array['public.wallets', 'public.ledger_entries', 'public.trading_orders', 'public.trades', 'public.swap_quotes', 'public.swap_orders', 'public.deposits', 'public.withdrawals', 'public.tier_limits', 'public.fee_rules', 'public.trading_pairs', 'public.limit_usage']) t(tbl),
       (values ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE')) p(priv)
  where has_table_privilege(r.role, t.tbl, p.priv)
    and (r.role <> 'service_role' or p.priv = 'TRUNCATE' or t.tbl in ('public.wallets', 'public.ledger_entries'));
  if v_actual is not null then
    raise exception 'postflight: unexpected write privileges on money tables: %', v_actual;
  end if;
  if (select count(*) from pg_trigger
       where tgname in ('ledger_entries_no_truncate', 'limit_usage_no_truncate') and not tgisinternal) <> 2 then
    raise exception 'postflight: TRUNCATE guards are missing';
  end if;

  -- And as a whole: the public schema equals a clean build of 001–017.
  select md5(string_agg(x, E'\n' order by x collate "C")) || ' ' || count(*) into v_actual
  from pg_temp.jimocex_schema_items() x;
  if v_actual is distinct from 'f48db42ea4cdfa14599f3f05197e2353 1191' then
    select string_agg(distinct split_part(l, ' ', 1), ', ') into v_expected from (
      select l from unnest(string_to_array($x$cmt 21 8b3adbd1a160f961e42043d00e484147
col 277 22f8b1407dba0cf8a6b99a55439c0448
con 175 7b29e7ded5c1e91b4730e8ebc8533066
defacl 46 2543fb20a8bcd734a41a23e79b518d62
enum 23 7e8df1e2362fbcb93654cd34fc7a2f5c
fn 19 7adb4138afe08b94597b85226b731e98
fnacl 11 aace5d0aa59accf3b4bd48494f48598e
idx 89 17ba2c1343ecd4e4623257b5d4e88411
nspacl 4 2234b7ac1ecfffba12e7a1ae3ebab139
pol 21 c67636e4695253bbe6248788bca8272b
rel 23 e2a9bdb7a79a3e1607739e8f17478753
relacl 404 c17e9933ba74f96504f14ca4e3522ce1
tier 52 1febf6eb1ac505fe2bda119f148424e4
trg 26 1f9c141438b9c84603617c67f0ee1b57$x$, E'\n')) l
      except
      select split_part(x, ' ', 1) || ' ' || count(*) || ' ' || md5(string_agg(x, E'\n' order by x collate "C"))
      from pg_temp.jimocex_schema_items() x group by split_part(x, ' ', 1)
    ) d;
    raise exception 'postflight: the public schema differs from a clean 001-017 build'
      using detail = 'fingerprint ' || v_actual || '; differing categories: ' || coalesce(v_expected, '(new categories only)');
  end if;

  -- --------------------------------------------------------------- 4. history
  with t as (select now() at time zone 'utc' as at)
  insert into supabase_migrations.schema_migrations (version, name, statements)
  select to_char(t.at, 'YYYYMMDDHH24MISS'), '016_money_functions_return_text', array[v016]
  from t
  union all
  select to_char(t.at + interval '1 second', 'YYYYMMDDHH24MISS'), '017_money_integrity', array[v017]
  from t;

  -- ----------------------------------------------------------------- 5. check
  select string_agg(coalesce(name, '-') || ' ' || coalesce(array_length(statements, 1), 0)::text
                    || ' ' || coalesce(md5(statements[1]), '-'), E'\n' order by version)
    into v_actual
  from supabase_migrations.schema_migrations;
  if v_actual is distinct from $x$001_initial_schema 1 8455d51de02e38615af632dc29857909
002_account_tiers 1 35b25a34fdbe67b554444f324bde310f
003_assets_pairs 1 13bd8855fe9634835be856fe927debf4
004_wallets_ledger 1 2265b618e6e105224d3492d7484dffa6
005_orders_trades 1 c4e61c777a41857d7168d35c91ab0c01
006_swaps 1 4269dc5860711d41bbd602ed7f177428
007_deposits_withdrawals 1 a2e8b31c89c82bba072bad3482c44920
008_fees_kyc_risk 1 b09175242cc3e2938b7379a6dfe552f1
009_audit_idempotency_events 1 0e7d9e9d1325828c2882a2c1f9385f4b
010_rls 1 fdb6b8beef2ae7cc683e121a5deb253a
011_seed_reference_data 1 e7752de23a2b2029bf2dcf7066c3664f
012_harden_functions 1 8204ac70615c4dc1de333145a85461c7
013_account_status_restricted 1 5bc684f495369e647c97fe99978acd2f
014_limit_usage 1 d7d5983a4811c8c422bc4e05b0005eb1
015_tier0_exchange_trade_limits 1 a16b15d009dc9a77acf2c05cc5e3442a
016_money_functions_return_text 1 5f7d9d01cee5c693baf55626e487e3cb
017_money_integrity 1 e83898e978d513ffac57f77e4def931f$x$ then
    raise exception 'check: the migration history is not exactly 001-017'
      using detail = 'found:' || E'\n' || coalesce(v_actual, '(no rows)');
  end if;
  if (select count(*) from supabase_migrations.schema_migrations
       where version > '20261010175618' and version ~ '^[0-9]{14}$') <> 2 then
    raise exception 'check: the two new history rows do not follow 015 as timestamp versions';
  end if;

  drop function pg_temp.jimocex_schema_items();
end
$apply$;

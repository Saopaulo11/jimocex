-- =============================================================================
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

drop function if exists public._jimocex_ddl_probe();

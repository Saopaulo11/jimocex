-- =============================================================================
-- JimoCex — 014_limit_usage
--
-- The volume ledger the LimitEngine reads for its DAILY and MONTHLY windows
-- (spec §25).
--
-- This is not a second limit system — the limits themselves stay in
-- `tier_limits`. It is the missing input: a rule that says "USD 5,000 per day"
-- needs to know how much of today is already spent, and that number has to come
-- from somewhere exact.
--
-- Why a dedicated table rather than summing swap_orders, trading_orders,
-- withdrawals and deposits on demand:
--
--   * Those four tables value their amounts in four different assets. Summing
--     them would mean re-converting historical operations at today's rate,
--     which silently rewrites the past every time the market moves.
--   * The USD equivalent is fixed HERE, at the moment the operation is
--     authorised, using the rate the decision was actually made on. An audit a
--     year later reconstructs the same answer.
--   * One window query instead of a four-way UNION across tables with four
--     different status vocabularies.
--
-- Append-only, and unique per (operation, reference): an operation counted once
-- cannot be counted twice by a retry, which would otherwise consume a
-- customer's daily allowance without them doing anything.
-- =============================================================================

create table public.limit_usage (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users (id) on delete restrict,

  operation       public.limit_operation not null,

  -- Value of the operation in `quote_currency`, as converted at authorisation
  -- time. Never recomputed.
  usd_equivalent  numeric(38, 18) not null,
  quote_currency  text not null default 'USD'
                    references public.assets (symbol) on update cascade on delete restrict,

  -- The rate and source behind the conversion, so a past decision stays
  -- explainable after the market-data provider is swapped (spec §13).
  rate_source     text,

  -- What consumed the allowance: ('swap_order', <uuid>), ('withdrawal', <uuid>).
  reference_type  text not null,
  reference_id    uuid not null,

  occurred_at     timestamptz not null default now(),

  constraint limit_usage_amount_non_negative check (usd_equivalent >= 0),
  -- One operation consumes its allowance exactly once (spec §20).
  constraint limit_usage_unique_reference unique (operation, reference_type, reference_id)
);

comment on table public.limit_usage is
  'Per-operation volume in the limit currency, fixed at authorisation time, that
   the LimitEngine sums over its DAILY and MONTHLY windows (spec §25). The
   limits themselves live in tier_limits; this is only the usage side.';

-- The engine's one hot query: everything for this user and operation since a
-- window start.
create index limit_usage_window_idx
  on public.limit_usage (user_id, operation, occurred_at desc);

-- Usage is a record of what was decided, so it is not editable after the fact.
create trigger limit_usage_append_only
  before update or delete on public.limit_usage
  for each row execute function public.forbid_mutation();

alter table public.limit_usage enable row level security;

-- A user may see what they have consumed — that is their own spending — but
-- only the server may write it.
create policy limit_usage_own_read on public.limit_usage
  for select to authenticated using (user_id = auth.uid());

revoke insert, update, delete on public.limit_usage from anon, authenticated;

-- -----------------------------------------------------------------------------
-- Usage in a window
--
-- SECURITY DEFINER with a pinned search_path, service_role only: the engine
-- runs server-side and a client must not be able to probe another account's
-- consumption.
-- -----------------------------------------------------------------------------

create or replace function public.limit_usage_in_window(
  p_user_id   uuid,
  p_operation public.limit_operation,
  p_since     timestamptz
)
returns numeric
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(sum(u.usd_equivalent), 0)
  from public.limit_usage u
  where u.user_id = p_user_id
    and u.operation = p_operation
    and u.occurred_at >= p_since;
$$;

revoke all on function public.limit_usage_in_window(uuid, public.limit_operation, timestamptz)
  from public, anon, authenticated;

-- =============================================================================
-- JimoCex — 004_wallets_ledger
--
-- The financial core (spec §17, §18, §19). Everything else in the platform is
-- a feature; this is the part that must not be wrong.
--
-- Two records, one truth:
--   * `ledger_entries` is the append-only history. It cannot be updated or
--     deleted — not by a user, not by an admin, not by the service role.
--   * `wallets` is a derived projection kept in the same transaction, so a
--     balance read costs one row instead of aggregating all history.
--
-- Every entry carries TWO signed deltas rather than one amount, because money
-- inside an account moves between two buckets as well as in and out:
--
--     DEPOSIT     available +X   locked  0     (funds arrive)
--     HOLD        available -X   locked +X     (reserved for an open order)
--     RELEASE     available +X   locked -X     (reservation cancelled)
--     WITHDRAWAL  available  0   locked -X     (held funds have left)
--     TRADE       available ±X   locked  0     (settlement)
--
-- This makes the reconciliation invariant exact and checkable:
--     wallet.available_balance = sum(available_delta)
--     wallet.locked_balance    = sum(locked_delta)
-- `public.reconcile_wallets()` at the end of this file asserts precisely that
-- (spec §19.10).
-- =============================================================================

create type public.ledger_entry_type as enum (
  'DEPOSIT',
  'WITHDRAWAL',
  'TRADE',
  'TRADE_FEE',
  'SWAP',
  'SWAP_FEE',
  'FIAT_DEPOSIT',
  'FIAT_WITHDRAWAL',
  'HOLD',
  'RELEASE',
  'ADJUSTMENT'
);

-- -----------------------------------------------------------------------------
-- Wallets
-- -----------------------------------------------------------------------------

create table public.wallets (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references auth.users (id) on delete restrict,
  asset_id           uuid not null references public.assets (id) on delete restrict,

  available_balance  numeric(38, 18) not null default 0,
  locked_balance     numeric(38, 18) not null default 0,

  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),

  constraint wallets_user_asset_unique unique (user_id, asset_id),

  -- Spec §19.1 and §19.2, enforced by PostgreSQL. Application code can be
  -- wrong; a CHECK constraint cannot be talked out of it. Any transaction that
  -- would overdraw a wallet aborts here.
  constraint wallets_available_non_negative check (available_balance >= 0),
  constraint wallets_locked_non_negative check (locked_balance >= 0)
);

comment on table public.wallets is
  'Derived projection of ledger_entries, not an independent source of truth
   (spec §18). Only public.ledger_post() may change a balance; direct writes are
   revoked from every role below.';

create index wallets_user_idx on public.wallets (user_id);

create trigger wallets_touch
  before update on public.wallets
  for each row execute function public.touch_updated_at();

-- -----------------------------------------------------------------------------
-- Ledger
-- -----------------------------------------------------------------------------

create table public.ledger_entries (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references auth.users (id) on delete restrict,
  asset_id         uuid not null references public.assets (id) on delete restrict,

  entry_type       public.ledger_entry_type not null,

  -- Unsigned magnitude of the operation, for reporting and statements. The
  -- deltas below are what actually moves money.
  amount           numeric(38, 18) not null,

  available_delta  numeric(38, 18) not null default 0,
  locked_delta     numeric(38, 18) not null default 0,

  -- What this entry was caused by: ('deposit', <uuid>), ('trade', <uuid>), …
  reference_type   text,
  reference_id     uuid,

  -- Set by the caller for any operation that must happen at most once: crediting
  -- a deposit, debiting a withdrawal, settling a trade. The unique index below
  -- turns spec §19.4, §19.5 and §19.6 into a database guarantee rather than a
  -- code convention. NULL for entries that may legitimately repeat, such as the
  -- HOLD/RELEASE pair of a partially filled order.
  dedup_key        text,

  metadata         jsonb not null default '{}'::jsonb,
  created_at       timestamptz not null default now(),

  constraint ledger_amount_non_negative check (amount >= 0),
  -- An entry that moves nothing is a bug, not a record.
  constraint ledger_entry_moves_something check (
    available_delta <> 0 or locked_delta <> 0
  )
);

comment on table public.ledger_entries is
  'Immutable, append-only financial history (spec §18). The forbid_mutation
   trigger blocks UPDATE and DELETE for every role including service_role: a
   correction is a new ADJUSTMENT entry, never an edit.';

-- Same logical operation can never be posted twice.
create unique index ledger_dedup_key_unique
  on public.ledger_entries (dedup_key)
  where dedup_key is not null;

create index ledger_user_asset_idx on public.ledger_entries (user_id, asset_id, created_at desc);
create index ledger_reference_idx on public.ledger_entries (reference_type, reference_id);

-- Append-only, enforced. Not a policy — a trigger, so it holds for every role.
create trigger ledger_entries_append_only
  before update or delete on public.ledger_entries
  for each row execute function public.forbid_mutation();

-- -----------------------------------------------------------------------------
-- The only way a balance may change
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
  if p_amount is null or p_amount < 0 then
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
    coalesce(p_available_delta, 0), coalesce(p_locked_delta, 0),
    p_reference_type, p_reference_id, p_dedup_key, coalesce(p_metadata, '{}'::jsonb)
  )
  returning id into v_entry_id;

  -- The CHECK constraints on wallets are the overdraft guard: if this update
  -- would drive either bucket below zero, PostgreSQL raises and the ledger
  -- insert above is rolled back with it.
  update public.wallets
  set available_balance = available_balance + coalesce(p_available_delta, 0),
      locked_balance    = locked_balance + coalesce(p_locked_delta, 0)
  where user_id = p_user_id and asset_id = p_asset_id;

  return v_entry_id;
end;
$$;

comment on function public.ledger_post is
  'The single entry point for moving money. Writes the immutable ledger entry and
   the wallet projection in one transaction, serialized per wallet. Executable by
   service_role only — see the REVOKE below (spec §19.12, §80.9).';

-- -----------------------------------------------------------------------------
-- Reconciliation (spec §19.10)
--
-- Returns one row per wallet whose projection has drifted from its ledger. An
-- empty result is the invariant holding. Anything else is an incident.
-- -----------------------------------------------------------------------------

create or replace function public.reconcile_wallets()
returns table (
  user_id            uuid,
  asset_id           uuid,
  wallet_available   numeric(38, 18),
  ledger_available   numeric(38, 18),
  wallet_locked      numeric(38, 18),
  ledger_locked      numeric(38, 18)
)
language sql
stable
security definer
set search_path = ''
as $$
  select w.user_id,
         w.asset_id,
         w.available_balance,
         coalesce(l.available_sum, 0),
         w.locked_balance,
         coalesce(l.locked_sum, 0)
  from public.wallets w
  left join (
    select e.user_id,
           e.asset_id,
           sum(e.available_delta) as available_sum,
           sum(e.locked_delta)    as locked_sum
    from public.ledger_entries e
    group by e.user_id, e.asset_id
  ) l on l.user_id = w.user_id and l.asset_id = w.asset_id
  where w.available_balance <> coalesce(l.available_sum, 0)
     or w.locked_balance    <> coalesce(l.locked_sum, 0);
$$;

-- -----------------------------------------------------------------------------
-- Grants
--
-- No client role may write a balance or post an entry under any circumstances
-- (spec §19.12, §47, §80.12). Reads are governed by RLS in migration 009.
-- -----------------------------------------------------------------------------

revoke all on function public.ledger_post(
  uuid, uuid, public.ledger_entry_type, numeric, numeric, numeric, text, uuid, text, jsonb
) from public, anon, authenticated;

revoke all on function public.reconcile_wallets() from public, anon, authenticated;

revoke insert, update, delete on public.wallets from anon, authenticated;
revoke insert, update, delete on public.ledger_entries from anon, authenticated;

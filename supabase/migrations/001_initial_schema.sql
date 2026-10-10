-- =============================================================================
-- JimoCex — 001_initial_schema
--
-- Foundations every later migration builds on: enums, the money representation,
-- shared trigger helpers, the authorization helpers RLS policies call, and the
-- `profiles` table that mirrors `auth.users`.
--
-- Money is NEVER a float. Every amount, rate and fee in this schema is
-- `numeric(38,18)`: 18 fractional digits covers ETH's wei-level precision, and
-- 20 integer digits is more headroom than any real balance needs. PostgreSQL
-- `numeric` is exact decimal arithmetic — `double precision` is not, and a
-- rounding error in a ledger is an unrecoverable accounting bug.
-- =============================================================================

-- No extension is required. `gen_random_uuid()`, used as the default for every
-- primary key below, has been part of PostgreSQL core since 13 — it is in
-- pg_catalog, not in pgcrypto. Creating pgcrypto here would be worse than
-- redundant: on a cluster that does not already have it, it installs into
-- `public` and shadows the core function with 36 extension functions, which is
-- schema drift between a fresh install and the hosted project.

-- -----------------------------------------------------------------------------
-- Enums
-- -----------------------------------------------------------------------------

create type public.asset_type as enum ('CRYPTO', 'FIAT');

create type public.pair_type as enum ('CRYPTO', 'FX', 'CRYPTO_FIAT', 'FIAT_CRYPTO');

create type public.account_status as enum ('ACTIVE', 'SUSPENDED', 'FROZEN', 'CLOSED');

create type public.kyc_status as enum (
  'NOT_STARTED', 'PENDING', 'IN_REVIEW', 'VERIFIED', 'REJECTED', 'EXPIRED'
);

-- Who caused a state change. Written to audit_logs and status histories.
create type public.actor_type as enum ('SYSTEM', 'USER', 'ADMIN', 'PROVIDER');

create type public.admin_role as enum (
  'SUPER_ADMIN', 'COMPLIANCE', 'OPERATIONS', 'SUPPORT', 'VIEWER'
);

-- -----------------------------------------------------------------------------
-- Shared helpers
-- -----------------------------------------------------------------------------

-- Keeps `updated_at` honest: application code cannot forget to set it.
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- Attached to append-only tables (the ledger above all). Raises on any UPDATE
-- or DELETE, including from the service role: an immutable financial record is
-- not a permission question. Corrections are new ADJUSTMENT rows (spec §18).
create or replace function public.forbid_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception
    '%.% is append-only; % is not permitted. Write a compensating entry instead.',
    tg_table_schema, tg_table_name, tg_op
    using errcode = 'restrict_violation';
end;
$$;

-- -----------------------------------------------------------------------------
-- Authorization helpers used by RLS policies
--
-- Both are SECURITY DEFINER with a pinned empty search_path: a policy must not
-- be re-routable by a caller-controlled search_path, and the function has to
-- read tables the calling user cannot select from itself.
-- -----------------------------------------------------------------------------

create table public.admin_users (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null unique references auth.users (id) on delete cascade,
  email       text not null,
  role        public.admin_role not null default 'VIEWER',
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

comment on table public.admin_users is
  'Staff accounts. Admin authority is decided here, server-side only — never by a
   claim in a client-supplied token or payload (spec §43).';

create trigger admin_users_touch
  before update on public.admin_users
  for each row execute function public.touch_updated_at();

-- True when the current request belongs to an active staff account.
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.admin_users a
    where a.user_id = auth.uid()
      and a.is_active
  );
$$;

-- True when the current staff account holds one of `roles`.
create or replace function public.has_admin_role(roles public.admin_role[])
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.admin_users a
    where a.user_id = auth.uid()
      and a.is_active
      and a.role = any (roles)
  );
$$;

-- -----------------------------------------------------------------------------
-- Profiles
-- -----------------------------------------------------------------------------

create table public.profiles (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null unique references auth.users (id) on delete cascade,
  email          text not null,
  display_name   text,

  -- Tier, status and KYC state are platform decisions. A user may read them and
  -- may never write them: migration 009 installs both an RLS policy and a
  -- BEFORE UPDATE trigger, because a policy alone cannot express
  -- "these columns must not change" (spec §47, §80.21).
  tier_code      text not null default 'TIER_0',
  status         public.account_status not null default 'ACTIVE',
  kyc_status     public.kyc_status not null default 'NOT_STARTED',

  -- Jurisdiction drives compliance rules, so it is stored; nothing else about
  -- the person is (spec §34: no unnecessary sensitive information).
  country_code   char(2),

  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

comment on column public.profiles.tier_code is
  'FK to account_tiers.code, added in 002 once that table exists.';

create index profiles_tier_idx on public.profiles (tier_code);
create index profiles_status_idx on public.profiles (status);

create trigger profiles_touch
  before update on public.profiles
  for each row execute function public.touch_updated_at();

-- A profile exists for every authenticated user from the moment of sign-up, so
-- no request has to cope with a missing one. SECURITY DEFINER because it writes
-- a table the signing-up user has no direct grant on.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (user_id, email)
  values (new.id, new.email)
  on conflict (user_id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- =============================================================================
-- JimoCex — 002_account_tiers
--
-- Account tiers and the limit configuration the LimitEngine reads (spec §21,
-- §25). The point of this migration is that no limit is ever a literal in
-- application code: `if (amount > 5000)` scattered across routes is exactly the
-- failure mode this table exists to prevent.
--
-- Limits are expressed in a single quote currency (USD by default) so one rule
-- covers every asset; the engine converts the operation's amount to that
-- currency before comparing.
-- =============================================================================

create type public.limit_operation as enum (
  'SWAP',
  'TRADE',
  'CRYPTO_DEPOSIT',
  'CRYPTO_WITHDRAWAL',
  'FIAT_DEPOSIT',
  'FIAT_WITHDRAWAL'
);

create type public.limit_window as enum ('SINGLE', 'DAILY', 'MONTHLY');

-- -----------------------------------------------------------------------------
-- Tiers
-- -----------------------------------------------------------------------------

create table public.account_tiers (
  code              text primary key,
  name              text not null,
  description       text,
  -- Ordering for "is this tier at least X" comparisons.
  rank              smallint not null unique,
  -- Verification a user must hold to sit in this tier.
  requires_kyc      boolean not null default false,
  is_active         boolean not null default true,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  constraint account_tiers_code_format check (code ~ '^TIER_[0-9]+$')
);

comment on table public.account_tiers is
  'Configurable tiers (spec §21). A tier never grants an entitlement on its own:
   RiskEngine and ComplianceGate can still demand verification earlier, and
   their verdict wins (spec §22).';

create trigger account_tiers_touch
  before update on public.account_tiers
  for each row execute function public.touch_updated_at();

-- Now that the table exists, bind the profile column to it. ON UPDATE CASCADE so
-- renaming a tier code cannot orphan a profile; RESTRICT on delete so a tier in
-- use cannot vanish underneath live accounts.
alter table public.profiles
  add constraint profiles_tier_code_fkey
  foreign key (tier_code) references public.account_tiers (code)
  on update cascade on delete restrict;

-- -----------------------------------------------------------------------------
-- Limits
-- -----------------------------------------------------------------------------

create table public.tier_limits (
  id               uuid primary key default gen_random_uuid(),
  tier_code        text not null references public.account_tiers (code)
                     on update cascade on delete cascade,
  operation        public.limit_operation not null,
  window_kind      public.limit_window not null,

  -- Currency the threshold is denominated in, as an assets.symbol (checked in
  -- 003 once assets exists). One currency for all rules keeps the engine's
  -- comparison honest across a multi-asset platform.
  quote_currency   text not null default 'USD',

  -- NULL means "no ceiling from this rule". A rule that exists but allows
  -- everything is deliberately expressible: it documents the decision.
  max_amount       numeric(38, 18),

  -- Below this, the operation is not worth processing. NULL means no floor.
  min_amount       numeric(38, 18),

  is_active        boolean not null default true,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  -- One active rule per (tier, operation, window): overlapping rules would make
  -- the effective limit depend on row order.
  constraint tier_limits_unique unique (tier_code, operation, window_kind),
  constraint tier_limits_max_non_negative check (max_amount is null or max_amount >= 0),
  constraint tier_limits_min_non_negative check (min_amount is null or min_amount >= 0),
  constraint tier_limits_min_below_max check (
    max_amount is null or min_amount is null or min_amount <= max_amount
  )
);

comment on table public.tier_limits is
  'The LimitEngine''s entire configuration (spec §25). Server-side only: the
   frontend displays the engine''s verdict and never computes one.';

create index tier_limits_lookup_idx
  on public.tier_limits (tier_code, operation, window_kind)
  where is_active;

create trigger tier_limits_touch
  before update on public.tier_limits
  for each row execute function public.touch_updated_at();

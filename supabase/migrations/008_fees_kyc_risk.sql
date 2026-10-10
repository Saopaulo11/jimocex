-- =============================================================================
-- JimoCex — 008_fees_kyc_risk
--
-- Fee configuration (spec §26), KYC verification state (spec §23) and the risk
-- trail (spec §24).
--
-- As with limits, the whole point is that none of this is a literal in
-- application code. A fee is a row; the FeeEngine reads it and computes
-- server-side. A client-supplied fee is ignored, always (spec §19.11, §80.18).
-- =============================================================================

create type public.fee_operation as enum (
  'SWAP',
  'TRADE',
  'DEPOSIT',
  'WITHDRAWAL',
  'FIAT_DEPOSIT',
  'FIAT_WITHDRAWAL'
);

create type public.risk_decision as enum ('ALLOW', 'REQUIRE_KYC', 'REVIEW', 'BLOCK');

create type public.kyc_provider_kind as enum ('MANUAL', 'EXTERNAL');

-- -----------------------------------------------------------------------------
-- Fees
-- -----------------------------------------------------------------------------

create table public.fee_rules (
  id              uuid primary key default gen_random_uuid(),

  operation       public.fee_operation not null,

  -- NULL means "any asset": a single rule can cover a whole operation, with a
  -- per-asset row overriding it. The lookup prefers the most specific match.
  asset_id        uuid references public.assets (id) on delete cascade,

  -- NULL means "any tier", same override logic.
  tier_code       text references public.account_tiers (code)
                    on update cascade on delete cascade,

  -- Proportional component, in percent: 0.25 means 0.25%.
  percentage      numeric(10, 6) not null default 0,
  -- Flat component, denominated in the operation's asset.
  fixed_fee       numeric(38, 18) not null default 0,

  min_fee         numeric(38, 18),
  max_fee         numeric(38, 18),

  is_active       boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  -- One rule per (operation, asset, tier) combination, NULLs included, so the
  -- effective fee is never ambiguous.
  constraint fee_rules_unique unique nulls not distinct (operation, asset_id, tier_code),
  constraint fee_rules_percentage_sane check (percentage >= 0 and percentage <= 100),
  constraint fee_rules_fixed_non_negative check (fixed_fee >= 0),
  constraint fee_rules_min_non_negative check (min_fee is null or min_fee >= 0),
  constraint fee_rules_max_non_negative check (max_fee is null or max_fee >= 0),
  constraint fee_rules_min_below_max check (
    min_fee is null or max_fee is null or min_fee <= max_fee
  )
);

comment on table public.fee_rules is
  'The FeeEngine''s configuration (spec §26). Resolution order is most-specific
   first: (operation, asset, tier) beats (operation, asset) beats (operation).';

create index fee_rules_lookup_idx
  on public.fee_rules (operation, asset_id, tier_code)
  where is_active;

create trigger fee_rules_touch
  before update on public.fee_rules
  for each row execute function public.touch_updated_at();

-- -----------------------------------------------------------------------------
-- KYC
-- -----------------------------------------------------------------------------

create table public.kyc_verifications (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references auth.users (id) on delete cascade,

  status              public.kyc_status not null default 'NOT_STARTED',

  -- Which tier this verification is meant to unlock. A user can hold several
  -- rows over time: an expired TIER_1 check and a pending TIER_2 one.
  target_tier_code    text references public.account_tiers (code)
                        on update cascade on delete set null,

  provider_kind       public.kyc_provider_kind not null default 'MANUAL',
  -- Adapter name, e.g. 'sumsub'. Free text so a new provider needs no migration.
  provider_name       text,
  -- The provider's session/applicant id. NEVER a document, image or extracted
  -- personal field: those stay with the provider (spec §34, §60).
  provider_session_id text,

  rejection_reason    text,
  reviewed_by         uuid references public.admin_users (id) on delete set null,

  submitted_at        timestamptz,
  decided_at          timestamptz,
  expires_at          timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

comment on table public.kyc_verifications is
  'Verification state only — no identity documents and no extracted personal
   data (spec §34, §60). JimoCex stores the provider''s session id and the
   verdict; the provider keeps the evidence.';

create unique index kyc_provider_session_unique
  on public.kyc_verifications (provider_name, provider_session_id)
  where provider_session_id is not null;

-- A user may have at most one verification in flight at a time.
create unique index kyc_one_open_per_user
  on public.kyc_verifications (user_id)
  where status in ('PENDING', 'IN_REVIEW');

create index kyc_user_idx on public.kyc_verifications (user_id, created_at desc);
create index kyc_review_queue_idx
  on public.kyc_verifications (submitted_at)
  where status = 'IN_REVIEW';

create trigger kyc_verifications_touch
  before update on public.kyc_verifications
  for each row execute function public.touch_updated_at();

-- -----------------------------------------------------------------------------
-- Risk
-- -----------------------------------------------------------------------------

create table public.risk_events (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid references auth.users (id) on delete set null,

  -- What was being attempted: 'swap', 'withdrawal', 'trade', 'login', …
  subject_type    text not null,
  subject_id      uuid,

  decision        public.risk_decision not null,

  -- Which rule fired, so a decision can be explained to a reviewer and to the
  -- customer, and so a rule change can be measured against history.
  rule_code       text,
  score           numeric(10, 4),

  -- Structured context. Must not contain personal data in the clear (spec §60).
  details         jsonb not null default '{}'::jsonb,

  -- Set when a human overrode the automated verdict. The override lands on the
  -- verdict's own row so the trail reads as one decision with its challenge,
  -- and the action is separately written to audit_logs (spec §42).
  overridden_by   uuid references public.admin_users (id) on delete set null,
  override_reason text,

  created_at      timestamptz not null default now()
);

comment on table public.risk_events is
  'Append-only record of every RiskEngine / ComplianceGate verdict (spec §24).
   A verdict is never deleted: a later decision is a new row, so the sequence of
   what was decided and when stays reconstructible.';

create index risk_events_user_idx on public.risk_events (user_id, created_at desc);
create index risk_events_subject_idx on public.risk_events (subject_type, subject_id);
create index risk_events_decision_idx on public.risk_events (decision, created_at desc);

-- A verdict cannot be erased. UPDATE stays open only so an authorised override
-- can be recorded on the row; DELETE is refused outright, for every role.
create trigger risk_events_append_only
  before delete on public.risk_events
  for each row execute function public.forbid_mutation();

revoke insert, update, delete on public.fee_rules from anon, authenticated;
revoke insert, update, delete on public.kyc_verifications from anon, authenticated;
revoke insert, update, delete on public.risk_events from anon, authenticated;

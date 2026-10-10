-- =============================================================================
-- JimoCex — 007_deposits_withdrawals
--
-- Crypto and fiat movement in and out of the platform (spec §40, §41).
--
-- The invariants this migration makes structural:
--   §19.5  a deposit cannot be credited twice  — unique (asset, network, tx_hash)
--          plus claim_deposit_for_credit(), which only one caller can win.
--   §19.4  a withdrawal cannot be executed twice — unique idempotency_key plus
--          a unique provider_reference.
--   §19.7  a failed withdrawal releases its locked funds — release_withdrawal_hold()
--          posts the RELEASE entry and marks the row, once.
-- =============================================================================

create type public.deposit_status as enum (
  'DETECTED',
  'CONFIRMING',
  'CONFIRMED',
  'CREDITED',   -- terminal
  'REJECTED'    -- terminal
);

create type public.withdrawal_status as enum (
  'REQUESTED',
  'PENDING_REVIEW',
  'APPROVED',
  'PROCESSING',
  'COMPLETED',  -- terminal
  'FAILED',     -- terminal
  'REJECTED',   -- terminal
  'HELD'
);

-- -----------------------------------------------------------------------------
-- Deposits
-- -----------------------------------------------------------------------------

create table public.deposits (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references auth.users (id) on delete restrict,
  asset_id            uuid not null references public.assets (id) on delete restrict,

  -- NULL for a fiat deposit, which arrives through a payment provider rather
  -- than a chain.
  network             text,
  amount              numeric(38, 18) not null,

  -- Address the funds were sent to; NULL for fiat.
  address             text,
  tx_hash             text,

  -- The fiat or crypto provider's own identifier for this movement.
  provider_reference  text,

  status              public.deposit_status not null default 'DETECTED',
  confirmations       integer not null default 0,

  -- Set the moment the ledger entry is posted. The claim function below is what
  -- actually guards it; this column records the outcome.
  credited_at         timestamptz,

  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  confirmed_at        timestamptz,

  constraint deposits_amount_positive check (amount > 0),
  constraint deposits_confirmations_non_negative check (confirmations >= 0)
);

comment on table public.deposits is
  'Inbound funds (spec §40). A deposit is credited only through
   claim_deposit_for_credit(), so a webhook replayed ten times credits once
   (spec §19.5).';

-- The same on-chain transfer can only ever be recorded once. This is the
-- strongest form of the no-double-credit rule: it holds even if the webhook
-- handler, the chain poller and an admin all try at the same moment.
create unique index deposits_chain_tx_unique
  on public.deposits (asset_id, network, tx_hash)
  where tx_hash is not null;

create unique index deposits_provider_reference_unique
  on public.deposits (provider_reference)
  where provider_reference is not null;

create index deposits_user_idx on public.deposits (user_id, created_at desc);
create index deposits_status_idx on public.deposits (status, created_at);

create trigger deposits_touch
  before update on public.deposits
  for each row execute function public.touch_updated_at();

-- Claims a confirmed deposit for crediting. Returns true exactly once; every
-- later caller gets false and must do nothing.
create or replace function public.claim_deposit_for_credit(p_deposit_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_updated integer;
begin
  update public.deposits
  set status      = 'CREDITED',
      credited_at = now()
  where id = p_deposit_id
    and credited_at is null
    and status = 'CONFIRMED';

  get diagnostics v_updated = row_count;
  return v_updated = 1;
end;
$$;

comment on function public.claim_deposit_for_credit is
  'Single-winner claim on crediting a deposit (spec §19.5). Requires CONFIRMED
   status, so an unconfirmed deposit can never be credited by mistake.';

-- -----------------------------------------------------------------------------
-- Withdrawals
-- -----------------------------------------------------------------------------

create table public.withdrawals (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references auth.users (id) on delete restrict,
  asset_id            uuid not null references public.assets (id) on delete restrict,

  network             text,
  amount              numeric(38, 18) not null,
  fee                 numeric(38, 18) not null default 0,

  -- What actually leaves the platform: amount - fee. Generated so the two can
  -- never disagree.
  net_amount          numeric(38, 18) generated always as (amount - fee) stored,

  -- Crypto address or an opaque reference to the fiat payout detail held by the
  -- provider. Raw bank credentials are not stored here (spec §60).
  destination         text not null,
  destination_tag     text,

  status              public.withdrawal_status not null default 'REQUESTED',

  provider_reference  text unique,
  tx_hash             text,
  failure_reason      text,

  -- Required (spec §20): a retried request resolves to the original withdrawal
  -- rather than sending the money a second time.
  idempotency_key     text not null,

  -- Funds moved available -> locked when the request was accepted. Released
  -- exactly once on failure or rejection (spec §19.7).
  hold_released_at    timestamptz,

  reviewed_by         uuid references public.admin_users (id) on delete set null,
  reviewed_at         timestamptz,

  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  processed_at        timestamptz,

  constraint withdrawals_amount_positive check (amount > 0),
  constraint withdrawals_fee_non_negative check (fee >= 0),
  -- A withdrawal whose fee eats the whole amount delivers nothing.
  constraint withdrawals_fee_below_amount check (fee < amount),
  constraint withdrawals_idempotency_unique unique (user_id, idempotency_key)
);

comment on table public.withdrawals is
  'Outbound funds (spec §41). Every request is idempotency-keyed, every payout
   is reviewed against limits, risk and compliance before a provider is called,
   and a failure releases the hold through release_withdrawal_hold().';

create index withdrawals_user_idx on public.withdrawals (user_id, created_at desc);
create index withdrawals_status_idx on public.withdrawals (status, created_at);
-- The operations queue: what a human still has to look at.
create index withdrawals_review_queue_idx
  on public.withdrawals (created_at)
  where status in ('REQUESTED', 'PENDING_REVIEW', 'HELD');

create trigger withdrawals_touch
  before update on public.withdrawals
  for each row execute function public.touch_updated_at();

-- Terminal states are terminal here too: a COMPLETED withdrawal cannot be
-- re-opened, and a FAILED one cannot become COMPLETED without a new request.
create or replace function public.guard_withdrawal_status_transition()
returns trigger
language plpgsql
as $$
begin
  if old.status = new.status then
    return new;
  end if;

  if old.status in ('COMPLETED', 'FAILED', 'REJECTED') then
    raise exception
      'withdrawal %: status % is terminal and cannot change to %',
      old.id, old.status, new.status
      using errcode = 'restrict_violation';
  end if;

  return new;
end;
$$;

create trigger withdrawals_status_guard
  before update of status on public.withdrawals
  for each row execute function public.guard_withdrawal_status_transition();

-- Releases the hold behind a withdrawal that will not go out, moving the funds
-- back from locked to available. Single-winner, so a retry cannot refund twice
-- (spec §19.7).
create or replace function public.release_withdrawal_hold(p_withdrawal_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_withdrawal public.withdrawals;
begin
  update public.withdrawals
  set hold_released_at = now()
  where id = p_withdrawal_id
    and hold_released_at is null
    -- Only a withdrawal that is not going out may be released. Releasing a
    -- PROCESSING one would hand back funds that are still in flight.
    and status in ('FAILED', 'REJECTED', 'HELD')
  returning * into v_withdrawal;

  if v_withdrawal.id is null then
    return false;
  end if;

  perform public.ledger_post(
    p_user_id         => v_withdrawal.user_id,
    p_asset_id        => v_withdrawal.asset_id,
    p_entry_type      => 'RELEASE',
    p_amount          => v_withdrawal.amount,
    p_available_delta => v_withdrawal.amount,
    p_locked_delta    => -v_withdrawal.amount,
    p_reference_type  => 'withdrawal',
    p_reference_id    => v_withdrawal.id,
    p_dedup_key       => 'withdrawal:release:' || v_withdrawal.id::text,
    p_metadata        => jsonb_build_object('reason', v_withdrawal.status)
  );

  return true;
end;
$$;

comment on function public.release_withdrawal_hold is
  'Returns a failed withdrawal''s locked funds to available, exactly once
   (spec §19.7). The dedup_key makes the ledger refuse a second RELEASE even if
   this function is somehow called twice.';

revoke all on function public.claim_deposit_for_credit(uuid) from public, anon, authenticated;
revoke all on function public.release_withdrawal_hold(uuid) from public, anon, authenticated;

revoke insert, update, delete on public.deposits from anon, authenticated;
revoke insert, update, delete on public.withdrawals from anon, authenticated;

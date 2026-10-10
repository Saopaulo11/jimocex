-- =============================================================================
-- JimoCex — 009_audit_idempotency_events
--
-- The operational spine: audit logs (spec §42), idempotency keys (spec §20),
-- provider webhook events (spec §58) and notifications.
--
-- `provider_events` is what makes "one provider event cannot be processed
-- twice" true rather than intended: the unique (provider, event_id) index is
-- checked before any handler runs, so a replayed webhook — accidental or
-- malicious — is recognised and dropped.
-- =============================================================================

create type public.provider_event_status as enum (
  'RECEIVED',
  'PROCESSED',
  'FAILED',
  'IGNORED'
);

create type public.notification_channel as enum ('EMAIL', 'PUSH', 'IN_APP', 'SMS');

create type public.notification_status as enum ('PENDING', 'SENT', 'FAILED', 'READ');

-- -----------------------------------------------------------------------------
-- Audit log (spec §42)
-- -----------------------------------------------------------------------------

create table public.audit_logs (
  id            uuid primary key default gen_random_uuid(),

  action        text not null,

  actor_type    public.actor_type not null default 'SYSTEM',
  -- auth.users id for a USER or ADMIN actor; NULL for SYSTEM and PROVIDER.
  actor_id      uuid,
  admin_id      uuid references public.admin_users (id) on delete set null,

  entity_type   text,
  entity_id     uuid,

  -- Structured context. Never a password, token, key, document or full payment
  -- credential (spec §60).
  metadata      jsonb not null default '{}'::jsonb,

  -- SHA-256 of the client address, never the address itself: enough to
  -- correlate requests, not enough to be a stored identifier.
  ip_hash       text,
  user_agent    text,

  request_id    text,

  created_at    timestamptz not null default now()
);

comment on table public.audit_logs is
  'Append-only record of every privileged action (spec §42). RLS enabled with no
   client policy: deny-all by design. Read only server-side, as service_role,
   after an explicit staff-authority check.';

create index audit_logs_action_idx on public.audit_logs (action, created_at desc);
create index audit_logs_entity_idx on public.audit_logs (entity_type, entity_id);
create index audit_logs_admin_idx on public.audit_logs (admin_id, created_at desc);
create index audit_logs_request_idx on public.audit_logs (request_id);

create trigger audit_logs_append_only
  before update or delete on public.audit_logs
  for each row execute function public.forbid_mutation();

-- -----------------------------------------------------------------------------
-- Idempotency (spec §20)
--
-- A generic claim table for any operation that must happen at most once. The
-- caller claims a key before doing the work and stores the result against it;
-- a retry finds the stored response and replays it instead of acting again.
-- -----------------------------------------------------------------------------

create table public.idempotency_keys (
  id              uuid primary key default gen_random_uuid(),

  -- What the key is scoped to: 'withdrawal', 'swap', 'order', 'webhook', …
  scope           text not null,
  key             text not null,

  user_id         uuid references auth.users (id) on delete cascade,

  -- Hash of the request body. A retry with the same key but a different payload
  -- is a client bug or an attack, not a retry, and is refused.
  request_hash    text not null,

  -- The response to replay. NULL while the first attempt is still in flight.
  response        jsonb,
  status_code     integer,

  created_at      timestamptz not null default now(),
  completed_at    timestamptz,
  -- Keys are prunable: without an expiry this table grows without bound.
  expires_at      timestamptz not null default (now() + interval '7 days'),

  constraint idempotency_keys_unique unique (scope, key)
);

comment on table public.idempotency_keys is
  'Generic at-most-once claim (spec §20). RLS enabled with no client policy:
   deny-all by design — a readable key table would let a caller discover and
   replay another request''s claim.';

create index idempotency_keys_expiry_idx on public.idempotency_keys (expires_at);

-- -----------------------------------------------------------------------------
-- Provider events (spec §58)
-- -----------------------------------------------------------------------------

create table public.provider_events (
  id              uuid primary key default gen_random_uuid(),

  provider        text not null,
  -- The provider's own event id. Combined with `provider` this is the replay
  -- guard: the unique constraint below rejects a second delivery outright.
  event_id        text not null,
  event_type      text not null,

  -- SHA-256 of the raw body, computed before parsing. Lets us prove the stored
  -- payload is the one whose signature was verified.
  payload_hash    text not null,
  payload         jsonb not null,

  -- Whether the signature check passed. A failed event is still recorded —
  -- forged deliveries are exactly what an operator needs to see — but no
  -- handler runs for it.
  signature_valid boolean not null default false,

  status          public.provider_event_status not null default 'RECEIVED',
  error           text,

  received_at     timestamptz not null default now(),
  processed_at    timestamptz,

  constraint provider_events_unique unique (provider, event_id)
);

comment on table public.provider_events is
  'Every inbound webhook, recorded before it is acted on (spec §58). RLS enabled
   with no client policy: deny-all by design. Payloads carry provider data that
   no customer may read.';

create index provider_events_status_idx on public.provider_events (status, received_at);
create index provider_events_type_idx on public.provider_events (provider, event_type, received_at desc);

-- Claims an event for processing. Returns true only to the caller that may run
-- the handler; a replay returns false and the handler is skipped.
create or replace function public.claim_provider_event(p_event_row_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_updated integer;
begin
  update public.provider_events
  set status       = 'PROCESSED',
      processed_at = now()
  where id = p_event_row_id
    and status = 'RECEIVED'
    -- An event whose signature did not verify is never processed, whatever it
    -- claims to be (spec §58).
    and signature_valid;

  get diagnostics v_updated = row_count;
  return v_updated = 1;
end;
$$;

comment on function public.claim_provider_event is
  'Single-winner claim on handling a webhook (spec §20, §58). Refuses any event
   whose signature check failed.';

-- -----------------------------------------------------------------------------
-- Notifications
-- -----------------------------------------------------------------------------

create table public.notifications (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users (id) on delete cascade,

  channel       public.notification_channel not null default 'IN_APP',
  status        public.notification_status not null default 'PENDING',

  title         text not null,
  body          text not null,

  -- What the notification is about, so the UI can link to it.
  entity_type   text,
  entity_id     uuid,

  sent_at       timestamptz,
  read_at       timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index notifications_user_idx on public.notifications (user_id, created_at desc);
create index notifications_unread_idx
  on public.notifications (user_id)
  where read_at is null;

create trigger notifications_touch
  before update on public.notifications
  for each row execute function public.touch_updated_at();

revoke all on function public.claim_provider_event(uuid) from public, anon, authenticated;

revoke insert, update, delete on public.audit_logs from anon, authenticated;
revoke insert, update, delete on public.idempotency_keys from anon, authenticated;
revoke insert, update, delete on public.provider_events from anon, authenticated;
revoke insert, delete on public.notifications from anon, authenticated;

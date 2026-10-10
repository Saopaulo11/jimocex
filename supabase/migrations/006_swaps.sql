-- =============================================================================
-- JimoCex — 006_swaps
--
-- The quote engine and swap orders (spec §9, §39).
--
-- The security property this migration exists for: a client submits a
-- `quote_id` and nothing else. Rate, fee and output amount are read back from
-- the row the server itself wrote, never from the request body (spec §9,
-- §19.11, §80.9). `consume_quote()` then makes a quote single-use and
-- expiry-checked inside one atomic statement.
-- =============================================================================

create type public.quote_status as enum ('ACTIVE', 'EXPIRED', 'USED', 'CANCELLED');

create type public.rate_mode as enum ('FIXED', 'FLOATING');

create type public.swap_order_status as enum (
  'CREATED',
  'CONFIRMED',
  'PROCESSING',
  'COMPLETED',    -- terminal
  'FAILED',       -- terminal
  'EXPIRED',      -- terminal
  'CANCELLED'     -- terminal
);

-- -----------------------------------------------------------------------------
-- Quotes
-- -----------------------------------------------------------------------------

create table public.swap_quotes (
  id              uuid primary key default gen_random_uuid(),

  -- A signed-in user, or an anonymous session for the public exchange widget.
  -- Exactly one is set, so a quote always has an owner to check against.
  user_id         uuid references auth.users (id) on delete cascade,
  session_id      text,

  from_asset_id   uuid not null references public.assets (id) on delete restrict,
  to_asset_id     uuid not null references public.assets (id) on delete restrict,

  from_amount     numeric(38, 18) not null,
  rate            numeric(38, 18) not null,
  fee             numeric(38, 18) not null default 0,
  fee_asset_id    uuid references public.assets (id) on delete restrict,
  output_amount   numeric(38, 18) not null,

  rate_mode       public.rate_mode not null default 'FLOATING',

  -- Which market-data provider produced the rate, so an old quote stays
  -- explainable after the provider is swapped (spec §13).
  rate_source     text not null,

  status          public.quote_status not null default 'ACTIVE',
  created_at      timestamptz not null default now(),
  expires_at      timestamptz not null,
  used_at         timestamptz,

  constraint swap_quotes_distinct_assets check (from_asset_id <> to_asset_id),
  constraint swap_quotes_from_amount_positive check (from_amount > 0),
  constraint swap_quotes_rate_positive check (rate > 0),
  constraint swap_quotes_fee_non_negative check (fee >= 0),
  constraint swap_quotes_output_positive check (output_amount > 0),
  constraint swap_quotes_expires_after_created check (expires_at > created_at),
  -- An owner is mandatory: a quote nobody owns cannot be authorized on use.
  constraint swap_quotes_has_owner check (
    (user_id is not null and session_id is null)
    or (user_id is null and session_id is not null)
  )
);

comment on table public.swap_quotes is
  'Server-issued quotes (spec §9). The client never sends rate, fee or output
   amount — it sends this row''s id and the server reads the rest back.';

create index swap_quotes_user_idx on public.swap_quotes (user_id, created_at desc);
create index swap_quotes_session_idx on public.swap_quotes (session_id, created_at desc);
create index swap_quotes_active_idx on public.swap_quotes (expires_at) where status = 'ACTIVE';

-- -----------------------------------------------------------------------------
-- Single-use consumption
--
-- One UPDATE does the whole check: the row must still be ACTIVE, must not have
-- expired, and must belong to the caller. Two concurrent requests cannot both
-- win, because the second finds no row matching `status = 'ACTIVE'`.
-- Doing this as SELECT-then-UPDATE in application code would leave exactly that
-- race open.
-- -----------------------------------------------------------------------------

create or replace function public.consume_quote(
  p_quote_id   uuid,
  p_user_id    uuid default null,
  p_session_id text default null
)
returns public.swap_quotes
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_quote public.swap_quotes;
begin
  update public.swap_quotes
  set status  = 'USED',
      used_at = now()
  where id = p_quote_id
    and status = 'ACTIVE'
    and expires_at > now()
    and (
      (p_user_id is not null and user_id = p_user_id)
      or (p_session_id is not null and session_id = p_session_id)
    )
  returning * into v_quote;

  if v_quote.id is null then
    -- Deliberately one message for "expired", "already used", "cancelled" and
    -- "not yours": distinguishing them would tell a caller about quotes that
    -- are not theirs. The caller gets a single, honest refusal.
    raise exception 'quote % is not usable', p_quote_id
      using errcode = 'restrict_violation',
            hint = 'The quote has expired, was already used, or does not belong to this caller.';
  end if;

  return v_quote;
end;
$$;

comment on function public.consume_quote is
  'Atomically validates and claims a quote (spec §9). Returns the stored quote so
   the caller uses the server''s own rate and fee, and raises if the quote is
   expired, spent or foreign.';

-- Housekeeping: flips lapsed quotes to EXPIRED so the admin views and metrics
-- show a true status. Correctness does not depend on it — consume_quote()
-- re-checks `expires_at` on every call regardless of what `status` says.
create or replace function public.expire_stale_quotes()
returns integer
language sql
security definer
set search_path = ''
as $$
  with expired as (
    update public.swap_quotes
    set status = 'EXPIRED'
    where status = 'ACTIVE' and expires_at <= now()
    returning 1
  )
  select count(*)::integer from expired;
$$;

-- -----------------------------------------------------------------------------
-- Swap orders
-- -----------------------------------------------------------------------------

create table public.swap_orders (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references auth.users (id) on delete restrict,

  -- The quote this swap was priced from. Unique: one quote can back exactly one
  -- swap order, which is the same guarantee consume_quote() gives, expressed in
  -- the schema as well.
  quote_id            uuid not null unique references public.swap_quotes (id) on delete restrict,

  from_asset_id       uuid not null references public.assets (id) on delete restrict,
  to_asset_id         uuid not null references public.assets (id) on delete restrict,

  from_amount         numeric(38, 18) not null,
  to_amount           numeric(38, 18) not null,
  rate                numeric(38, 18) not null,
  fee                 numeric(38, 18) not null default 0,
  fee_asset_id        uuid references public.assets (id) on delete restrict,

  status              public.swap_order_status not null default 'CREATED',

  provider_reference  text unique,
  failure_reason      text,

  settled_at          timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  completed_at        timestamptz,

  constraint swap_orders_distinct_assets check (from_asset_id <> to_asset_id),
  constraint swap_orders_from_amount_positive check (from_amount > 0),
  constraint swap_orders_to_amount_positive check (to_amount > 0),
  constraint swap_orders_rate_positive check (rate > 0),
  constraint swap_orders_fee_non_negative check (fee >= 0)
);

comment on table public.swap_orders is
  'Executed swaps (spec §39). A swap reaches COMPLETED only when the execution
   provider confirms it — never because the UI needs something to show
   (spec §15, §80.1).';

create index swap_orders_user_idx on public.swap_orders (user_id, created_at desc);
create index swap_orders_status_idx on public.swap_orders (status, created_at);

create trigger swap_orders_touch
  before update on public.swap_orders
  for each row execute function public.touch_updated_at();

-- Same terminal-state rule as trading orders: a COMPLETED swap cannot be walked
-- back to PROCESSING, and a FAILED one cannot quietly become COMPLETED.
create or replace function public.guard_swap_status_transition()
returns trigger
language plpgsql
as $$
begin
  if old.status = new.status then
    return new;
  end if;

  if old.status in ('COMPLETED', 'FAILED', 'EXPIRED', 'CANCELLED') then
    raise exception
      'swap order %: status % is terminal and cannot change to %',
      old.id, old.status, new.status
      using errcode = 'restrict_violation';
  end if;

  return new;
end;
$$;

create trigger swap_orders_status_guard
  before update of status on public.swap_orders
  for each row execute function public.guard_swap_status_transition();

revoke all on function public.consume_quote(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.expire_stale_quotes() from public, anon, authenticated;

-- A quote is created by the server on the user's behalf; the user may read it
-- but never write one, or they would be setting their own rate.
revoke insert, update, delete on public.swap_quotes from anon, authenticated;
revoke insert, update, delete on public.swap_orders from anon, authenticated;

-- =============================================================================
-- JimoCex — 005_orders_trades
--
-- Trading orders and the trades that settle them (spec §37, §38).
--
-- Spec §19.8 ("a cancelled order cannot be filled") and §19.9 ("a filled order
-- cannot be cancelled") are one rule stated twice: a terminal status is
-- terminal. The trigger at the bottom enforces it in the database, so no route,
-- webhook or admin action can walk an order back out of a final state.
-- =============================================================================

create type public.order_side as enum ('BUY', 'SELL');

create type public.order_type as enum ('MARKET', 'LIMIT');

create type public.order_status as enum (
  'PENDING',          -- accepted by JimoCex, not yet acknowledged by the provider
  'OPEN',             -- live on the venue
  'PARTIALLY_FILLED',
  'FILLED',           -- terminal
  'CANCELLED',        -- terminal
  'REJECTED',         -- terminal
  'EXPIRED'           -- terminal
);

-- -----------------------------------------------------------------------------
-- Orders
-- -----------------------------------------------------------------------------

create table public.trading_orders (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references auth.users (id) on delete restrict,
  pair_id            uuid not null references public.trading_pairs (id) on delete restrict,

  side               public.order_side not null,
  type               public.order_type not null,

  -- NULL for a MARKET order: the price is whatever execution returns, and
  -- storing a guess would make the record lie. The CHECK below enforces it.
  price              numeric(38, 18),
  amount             numeric(38, 18) not null,
  filled_amount      numeric(38, 18) not null default 0,

  -- Generated, never written: a stored remainder drifts out of agreement with
  -- the two columns it is derived from.
  remaining_amount   numeric(38, 18) generated always as (amount - filled_amount) stored,

  -- Volume-weighted average fill price, once anything has filled.
  average_price      numeric(38, 18),

  status             public.order_status not null default 'PENDING',

  -- The venue's own id. Unique so one provider order can never back two of ours.
  provider_order_id  text unique,

  -- Caller-supplied idempotency key (spec §20): a retried placement returns the
  -- original order instead of opening a second one.
  client_order_id    text,

  -- Funds reserved for this order, released on cancel/expiry (spec §19.7).
  locked_asset_id    uuid references public.assets (id) on delete restrict,
  locked_amount      numeric(38, 18) not null default 0,

  reject_reason      text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),

  constraint trading_orders_amount_positive check (amount > 0),
  constraint trading_orders_filled_non_negative check (filled_amount >= 0),
  -- An order can never fill beyond its own size.
  constraint trading_orders_filled_within_amount check (filled_amount <= amount),
  constraint trading_orders_price_positive check (price is null or price > 0),
  constraint trading_orders_locked_non_negative check (locked_amount >= 0),
  -- A LIMIT order needs a price; a MARKET order must not carry one.
  constraint trading_orders_price_matches_type check (
    (type = 'LIMIT' and price is not null) or (type = 'MARKET' and price is null)
  ),
  constraint trading_orders_client_id_unique unique (user_id, client_order_id)
);

comment on table public.trading_orders is
  'Order state is owned by the server (spec §37). A client-reported status is
   never trusted: only the execution provider adapter and admin actions move an
   order, and the transition guard below bounds even those.';

create index trading_orders_user_idx on public.trading_orders (user_id, created_at desc);
create index trading_orders_pair_status_idx on public.trading_orders (pair_id, status);
-- Supports the "open orders" panel without scanning history.
create index trading_orders_open_idx
  on public.trading_orders (user_id, pair_id)
  where status in ('PENDING', 'OPEN', 'PARTIALLY_FILLED');

create trigger trading_orders_touch
  before update on public.trading_orders
  for each row execute function public.touch_updated_at();

-- -----------------------------------------------------------------------------
-- Terminal status guard (spec §19.8, §19.9)
-- -----------------------------------------------------------------------------

create or replace function public.guard_order_status_transition()
returns trigger
language plpgsql
as $$
begin
  if old.status = new.status then
    return new;
  end if;

  if old.status in ('FILLED', 'CANCELLED', 'REJECTED', 'EXPIRED') then
    raise exception
      'order %: status % is terminal and cannot change to %',
      old.id, old.status, new.status
      using errcode = 'restrict_violation';
  end if;

  -- FILLED must agree with the numbers: a fully filled order whose fills do not
  -- add up to its size means a settlement bug upstream, not a status to accept.
  if new.status = 'FILLED' and new.filled_amount <> new.amount then
    raise exception
      'order %: cannot be FILLED while filled_amount (%) <> amount (%)',
      old.id, new.filled_amount, new.amount
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

create trigger trading_orders_status_guard
  before update of status on public.trading_orders
  for each row execute function public.guard_order_status_transition();

-- -----------------------------------------------------------------------------
-- Trades
-- -----------------------------------------------------------------------------

create table public.trades (
  id                 uuid primary key default gen_random_uuid(),
  pair_id            uuid not null references public.trading_pairs (id) on delete restrict,

  -- One side is NULL when the counterparty is an external venue rather than
  -- another JimoCex order, which is the case for every provider-executed trade.
  buy_order_id       uuid references public.trading_orders (id) on delete restrict,
  sell_order_id      uuid references public.trading_orders (id) on delete restrict,

  price              numeric(38, 18) not null,
  amount             numeric(38, 18) not null,
  quote_amount       numeric(38, 18) not null,

  fee                numeric(38, 18) not null default 0,
  fee_asset_id       uuid references public.assets (id) on delete restrict,

  -- The venue's trade id. Unique, so replaying an execution report cannot
  -- settle the same trade twice (spec §19.6).
  provider_trade_id  text unique,

  -- Set when the ledger entries for this trade have been posted. Checked before
  -- settling so a retry is a no-op rather than a double credit.
  settled_at         timestamptz,
  created_at         timestamptz not null default now(),

  constraint trades_price_positive check (price > 0),
  constraint trades_amount_positive check (amount > 0),
  constraint trades_quote_amount_positive check (quote_amount > 0),
  constraint trades_fee_non_negative check (fee >= 0),
  -- A trade with neither side is not attributable to anyone.
  constraint trades_has_a_side check (buy_order_id is not null or sell_order_id is not null)
);

comment on table public.trades is
  'Settled executions (spec §38). `provider_trade_id` is unique and `settled_at`
   is checked before posting to the ledger: together they make double settlement
   impossible (spec §19.6).';

create index trades_pair_idx on public.trades (pair_id, created_at desc);
create index trades_buy_order_idx on public.trades (buy_order_id);
create index trades_sell_order_idx on public.trades (sell_order_id);
-- Trades awaiting settlement, for the reconciliation job.
create index trades_unsettled_idx on public.trades (created_at) where settled_at is null;

-- Trades are a financial record: append-only, like the ledger. Settlement marks
-- itself through a dedicated function rather than a general UPDATE.
create or replace function public.mark_trade_settled(p_trade_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_updated integer;
begin
  -- The WHERE clause is the guard: a second caller updates zero rows and gets
  -- false, so settlement logic can treat the return value as "I own this".
  update public.trades
  set settled_at = now()
  where id = p_trade_id
    and settled_at is null;

  get diagnostics v_updated = row_count;
  return v_updated = 1;
end;
$$;

comment on function public.mark_trade_settled is
  'Claims a trade for settlement exactly once. Returns true to the single caller
   that won the race and false to every other, so the ledger postings that
   follow can only run one time (spec §19.6).';

revoke all on function public.mark_trade_settled(uuid) from public, anon, authenticated;

revoke insert, update, delete on public.trading_orders from anon, authenticated;
revoke insert, update, delete on public.trades from anon, authenticated;

-- =============================================================================
-- JimoCex — 003_assets_pairs
--
-- Assets and trading pairs (spec §35, §36).
--
-- Two rules this migration exists to enforce:
--   * one row per asset, never a table per asset (spec §35);
--   * pairs live in the database, never hardcoded in the frontend (spec §7).
-- Adding BTC/BRL is an INSERT, not a deploy.
-- =============================================================================

create table public.assets (
  id          uuid primary key default gen_random_uuid(),
  symbol      text not null unique,
  name        text not null,
  type        public.asset_type not null,

  -- Default settlement network for a crypto asset (TRON, ERC20, …). NULL for
  -- fiat. The networks an asset can actually be deposited on live in
  -- `asset_networks` below, because USDT exists on several.
  network     text,

  -- On-chain precision for crypto, minor-unit precision for fiat. Used to round
  -- a displayed amount and to reject input finer than the asset can represent.
  decimals    smallint not null,

  is_active   boolean not null default false,
  metadata    jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  constraint assets_symbol_format check (symbol ~ '^[A-Z0-9]{2,16}$'),
  constraint assets_decimals_range check (decimals between 0 and 18),
  -- Fiat has no network; crypto must name one.
  constraint assets_network_matches_type check (
    (type = 'FIAT' and network is null) or (type = 'CRYPTO' and network is not null)
  )
);

comment on table public.assets is
  'Every supported asset, crypto and fiat alike (spec §35). `is_active` defaults
   to false: an asset is listed only once a provider can actually serve it.';

create index assets_type_active_idx on public.assets (type) where is_active;

create trigger assets_touch
  before update on public.assets
  for each row execute function public.touch_updated_at();

-- -----------------------------------------------------------------------------
-- Networks an asset can be moved on
--
-- Separate from `assets` because the mapping is many-to-one: USDT is the same
-- asset on TRON and on Ethereum, but the deposit address, the fee and the
-- confirmation count are not.
-- -----------------------------------------------------------------------------

create table public.asset_networks (
  id                      uuid primary key default gen_random_uuid(),
  asset_id                uuid not null references public.assets (id) on delete cascade,
  network                 text not null,
  display_name            text not null,

  -- Contract address for a token; NULL for a native coin.
  contract_address        text,

  -- Confirmations before a deposit is credited. A platform decision, not the
  -- provider's: the provider reports a count, this says when it is enough.
  required_confirmations  integer not null default 1,

  deposit_enabled         boolean not null default false,
  withdrawal_enabled      boolean not null default false,

  -- Regex an outbound address must satisfy before the request is accepted. A
  -- cheap first gate; the crypto provider still validates authoritatively.
  address_regex           text,

  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),

  constraint asset_networks_unique unique (asset_id, network),
  constraint asset_networks_confirmations_positive check (required_confirmations >= 0)
);

create trigger asset_networks_touch
  before update on public.asset_networks
  for each row execute function public.touch_updated_at();

-- Now that `assets` exists, bind the limit configuration's quote currency to a
-- real asset symbol rather than free text.
alter table public.tier_limits
  add constraint tier_limits_quote_currency_fkey
  foreign key (quote_currency) references public.assets (symbol)
  on update cascade on delete restrict;

-- -----------------------------------------------------------------------------
-- Trading pairs
-- -----------------------------------------------------------------------------

create table public.trading_pairs (
  id                uuid primary key default gen_random_uuid(),

  -- Canonical wire form, e.g. 'BTC-USDT'. Used in /trade/[pair] and in the
  -- market-data cache key, so it is stored rather than derived at every call.
  symbol            text not null unique,

  base_asset_id     uuid not null references public.assets (id) on delete restrict,
  quote_asset_id    uuid not null references public.assets (id) on delete restrict,
  pair_type         public.pair_type not null,

  min_order_size    numeric(38, 18) not null default 0,
  -- NULL means no per-order ceiling from the pair itself; the LimitEngine still
  -- applies the user's tier limits on top.
  max_order_size    numeric(38, 18),

  price_precision   smallint not null default 2,
  amount_precision  smallint not null default 8,

  -- Separate flags: a pair can stay visible on /markets while order placement
  -- is switched off, which is what an unavailable execution provider means.
  is_active         boolean not null default false,
  trading_enabled   boolean not null default false,
  swap_enabled      boolean not null default false,

  display_order     integer not null default 1000,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  constraint trading_pairs_distinct_assets check (base_asset_id <> quote_asset_id),
  constraint trading_pairs_assets_unique unique (base_asset_id, quote_asset_id),
  constraint trading_pairs_symbol_format check (symbol ~ '^[A-Z0-9]{2,16}-[A-Z0-9]{2,16}$'),
  constraint trading_pairs_min_non_negative check (min_order_size >= 0),
  constraint trading_pairs_max_above_min check (
    max_order_size is null or max_order_size >= min_order_size
  ),
  constraint trading_pairs_precision_range check (
    price_precision between 0 and 18 and amount_precision between 0 and 18
  )
);

comment on table public.trading_pairs is
  'Pairs are configuration, not code (spec §7, §36). `trading_enabled` and
   `swap_enabled` are distinct from `is_active` so a pair can be listed with
   order placement disabled when no execution provider is connected.';

create index trading_pairs_active_idx
  on public.trading_pairs (pair_type, display_order)
  where is_active;

create trigger trading_pairs_touch
  before update on public.trading_pairs
  for each row execute function public.touch_updated_at();

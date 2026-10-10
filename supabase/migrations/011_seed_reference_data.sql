-- =============================================================================
-- JimoCex — 011_seed_reference_data
--
-- Safe seed (spec §49): tiers, assets, networks, pairs, limits and fees.
--
-- What is deliberately NOT here: balances, transactions, trades, deposits,
-- withdrawals, users. Reference data describes what the platform supports;
-- inventing financial history would be a lie told in SQL (spec §49, §80.1–80.8).
--
-- Every pair is seeded with `trading_enabled = false` and `swap_enabled = false`
-- because no execution provider is connected yet. The pairs are real and
-- listable; the ability to act on them switches on when a provider does
-- (spec §15, §64). Likewise every network has deposits and withdrawals off.
--
-- Idempotent throughout: ON CONFLICT DO NOTHING, so re-running changes nothing
-- and cannot overwrite a value an operator has since tuned.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Account tiers (spec §21, §22)
-- -----------------------------------------------------------------------------

insert into public.account_tiers (code, name, rank, requires_kyc, description) values
  ('TIER_0', 'Email account', 0, false,
   'Registered with an email address. Limited capabilities. The product target is up to USD 5,000 equivalent — not a guarantee: risk, compliance and jurisdiction rules can require verification earlier (spec §22).'),
  ('TIER_1', 'Verified', 1, true,
   'Identity verified. Higher limits across exchange, trading and withdrawals.'),
  ('TIER_2', 'Enhanced verification', 2, true,
   'Enhanced due diligence completed. Higher limits again.'),
  ('TIER_3', 'Institutional', 3, true,
   'Institutional or custom arrangement. Limits are set per agreement rather than by this table.')
on conflict (code) do nothing;

-- -----------------------------------------------------------------------------
-- Assets (spec §35)
-- -----------------------------------------------------------------------------

insert into public.assets (symbol, name, type, network, decimals, is_active) values
  ('BTC',  'Bitcoin',          'CRYPTO', 'BITCOIN',  8,  true),
  ('ETH',  'Ethereum',         'CRYPTO', 'ETHEREUM', 18, true),
  ('USDT', 'Tether USD',       'CRYPTO', 'TRON',     6,  true),
  ('USDC', 'USD Coin',         'CRYPTO', 'ETHEREUM', 6,  true),
  ('TRX',  'TRON',             'CRYPTO', 'TRON',     6,  true),
  ('SOL',  'Solana',           'CRYPTO', 'SOLANA',   9,  true),
  ('BRL',  'Brazilian Real',   'FIAT',   null,       2,  true),
  ('RUB',  'Russian Ruble',    'FIAT',   null,       2,  true),
  ('USD',  'US Dollar',        'FIAT',   null,       2,  true),
  ('EUR',  'Euro',             'FIAT',   null,       2,  true),
  ('GBP',  'Pound Sterling',   'FIAT',   null,       2,  true)
on conflict (symbol) do nothing;

-- -----------------------------------------------------------------------------
-- Asset networks (spec §27, §28)
--
-- Deposits and withdrawals are off: there is no crypto provider yet, and an
-- enabled network with no provider behind it would show a deposit address that
-- does not exist (spec §27, §80.2).
-- -----------------------------------------------------------------------------

insert into public.asset_networks (
  asset_id, network, display_name, required_confirmations,
  deposit_enabled, withdrawal_enabled, address_regex
)
select a.id, n.network, n.display_name, n.confirmations, false, false, n.address_regex
from (values
  ('BTC',  'BITCOIN',  'Bitcoin',          2,  '^(bc1|[13])[a-zA-HJ-NP-Z0-9]{25,62}$'),
  ('ETH',  'ETHEREUM', 'Ethereum (ERC20)', 12, '^0x[a-fA-F0-9]{40}$'),
  ('USDT', 'TRON',     'TRON (TRC20)',     19, '^T[1-9A-HJ-NP-Za-km-z]{33}$'),
  ('USDT', 'ETHEREUM', 'Ethereum (ERC20)', 12, '^0x[a-fA-F0-9]{40}$'),
  ('USDC', 'ETHEREUM', 'Ethereum (ERC20)', 12, '^0x[a-fA-F0-9]{40}$'),
  ('TRX',  'TRON',     'TRON',             19, '^T[1-9A-HJ-NP-Za-km-z]{33}$'),
  ('SOL',  'SOLANA',   'Solana',           32, '^[1-9A-HJ-NP-Za-km-z]{32,44}$')
) as n(symbol, network, display_name, confirmations, address_regex)
join public.assets a on a.symbol = n.symbol
on conflict (asset_id, network) do nothing;

-- -----------------------------------------------------------------------------
-- Trading pairs (spec §36, §49)
-- -----------------------------------------------------------------------------

insert into public.trading_pairs (
  symbol, base_asset_id, quote_asset_id, pair_type,
  min_order_size, price_precision, amount_precision,
  is_active, trading_enabled, swap_enabled, display_order
)
select p.symbol,
       b.id,
       q.id,
       p.pair_type::public.pair_type,
       p.min_order_size,
       p.price_precision,
       p.amount_precision,
       true,   -- listed on /markets
       false,  -- no execution provider connected
       false,  -- no liquidity provider connected
       p.display_order
from (values
  ('BTC-USDT',  'BTC',  'USDT', 'CRYPTO',      0.0001, 2, 8, 10),
  ('ETH-USDT',  'ETH',  'USDT', 'CRYPTO',      0.001,  2, 8, 20),
  ('SOL-USDT',  'SOL',  'USDT', 'CRYPTO',      0.01,   3, 6, 30),
  ('TRX-USDT',  'TRX',  'USDT', 'CRYPTO',      1,      5, 2, 40),
  ('USDC-USDT', 'USDC', 'USDT', 'CRYPTO',      1,      4, 2, 50),
  ('BTC-BRL',   'BTC',  'BRL',  'CRYPTO_FIAT', 0.0001, 2, 8, 60),
  ('ETH-BRL',   'ETH',  'BRL',  'CRYPTO_FIAT', 0.001,  2, 8, 70),
  ('USDT-BRL',  'USDT', 'BRL',  'CRYPTO_FIAT', 10,     4, 2, 80),
  ('USDT-RUB',  'USDT', 'RUB',  'CRYPTO_FIAT', 10,     4, 2, 90),
  ('BTC-RUB',   'BTC',  'RUB',  'CRYPTO_FIAT', 0.0001, 2, 8, 100),
  ('USD-BRL',   'USD',  'BRL',  'FX',          10,     4, 2, 110),
  ('EUR-USD',   'EUR',  'USD',  'FX',          10,     5, 2, 120),
  ('EUR-BRL',   'EUR',  'BRL',  'FX',          10,     4, 2, 130),
  ('GBP-USD',   'GBP',  'USD',  'FX',          10,     5, 2, 140),
  ('USD-RUB',   'USD',  'RUB',  'FX',          10,     4, 2, 150),
  ('EUR-RUB',   'EUR',  'RUB',  'FX',          10,     4, 2, 160)
) as p(symbol, base_symbol, quote_symbol, pair_type,
       min_order_size, price_precision, amount_precision, display_order)
join public.assets b on b.symbol = p.base_symbol
join public.assets q on q.symbol = p.quote_symbol
on conflict (symbol) do nothing;

-- -----------------------------------------------------------------------------
-- Tier limits (spec §21, §25)
--
-- Denominated in USD. These are starting product thresholds, not a compliance
-- opinion: a jurisdiction or risk rule can be stricter, and the ComplianceGate's
-- verdict wins over anything here (spec §22, §24).
--
-- TIER_3 rows carry NULL ceilings on purpose — institutional limits are set per
-- agreement, and a NULL documents that decision rather than hiding it.
-- -----------------------------------------------------------------------------

insert into public.tier_limits (tier_code, operation, window_kind, quote_currency, max_amount, min_amount)
select l.tier_code, l.operation::public.limit_operation, l.window_kind::public.limit_window,
       'USD', l.max_amount, l.min_amount
from (values
  -- TIER_0 — email only. Product target: USD 5,000 equivalent in aggregate.
  ('TIER_0', 'SWAP',              'SINGLE',  2000,    10),
  ('TIER_0', 'SWAP',              'DAILY',   5000,    null),
  ('TIER_0', 'SWAP',              'MONTHLY', 5000,    null),
  ('TIER_0', 'TRADE',             'SINGLE',  2000,    10),
  ('TIER_0', 'TRADE',             'DAILY',   5000,    null),
  ('TIER_0', 'TRADE',             'MONTHLY', 5000,    null),
  ('TIER_0', 'CRYPTO_DEPOSIT',    'DAILY',   5000,    null),
  ('TIER_0', 'CRYPTO_DEPOSIT',    'MONTHLY', 5000,    null),
  ('TIER_0', 'CRYPTO_WITHDRAWAL', 'SINGLE',  1000,    10),
  ('TIER_0', 'CRYPTO_WITHDRAWAL', 'DAILY',   2000,    null),
  ('TIER_0', 'CRYPTO_WITHDRAWAL', 'MONTHLY', 5000,    null),
  ('TIER_0', 'FIAT_DEPOSIT',      'DAILY',   5000,    null),
  ('TIER_0', 'FIAT_DEPOSIT',      'MONTHLY', 5000,    null),
  ('TIER_0', 'FIAT_WITHDRAWAL',   'SINGLE',  1000,    10),
  ('TIER_0', 'FIAT_WITHDRAWAL',   'DAILY',   2000,    null),
  ('TIER_0', 'FIAT_WITHDRAWAL',   'MONTHLY', 5000,    null),

  -- TIER_1 — identity verified.
  ('TIER_1', 'SWAP',              'SINGLE',  50000,   10),
  ('TIER_1', 'SWAP',              'DAILY',   100000,  null),
  ('TIER_1', 'SWAP',              'MONTHLY', 500000,  null),
  ('TIER_1', 'TRADE',             'SINGLE',  50000,   10),
  ('TIER_1', 'TRADE',             'DAILY',   100000,  null),
  ('TIER_1', 'TRADE',             'MONTHLY', 500000,  null),
  ('TIER_1', 'CRYPTO_DEPOSIT',    'DAILY',   100000,  null),
  ('TIER_1', 'CRYPTO_DEPOSIT',    'MONTHLY', 500000,  null),
  ('TIER_1', 'CRYPTO_WITHDRAWAL', 'SINGLE',  25000,   10),
  ('TIER_1', 'CRYPTO_WITHDRAWAL', 'DAILY',   50000,   null),
  ('TIER_1', 'CRYPTO_WITHDRAWAL', 'MONTHLY', 250000,  null),
  ('TIER_1', 'FIAT_DEPOSIT',      'DAILY',   100000,  null),
  ('TIER_1', 'FIAT_DEPOSIT',      'MONTHLY', 500000,  null),
  ('TIER_1', 'FIAT_WITHDRAWAL',   'SINGLE',  25000,   10),
  ('TIER_1', 'FIAT_WITHDRAWAL',   'DAILY',   50000,   null),
  ('TIER_1', 'FIAT_WITHDRAWAL',   'MONTHLY', 250000,  null),

  -- TIER_2 — enhanced due diligence.
  ('TIER_2', 'SWAP',              'SINGLE',  250000,  10),
  ('TIER_2', 'SWAP',              'DAILY',   1000000, null),
  ('TIER_2', 'SWAP',              'MONTHLY', 5000000, null),
  ('TIER_2', 'TRADE',             'SINGLE',  250000,  10),
  ('TIER_2', 'TRADE',             'DAILY',   1000000, null),
  ('TIER_2', 'TRADE',             'MONTHLY', 5000000, null),
  ('TIER_2', 'CRYPTO_DEPOSIT',    'DAILY',   1000000, null),
  ('TIER_2', 'CRYPTO_DEPOSIT',    'MONTHLY', 5000000, null),
  ('TIER_2', 'CRYPTO_WITHDRAWAL', 'SINGLE',  250000,  10),
  ('TIER_2', 'CRYPTO_WITHDRAWAL', 'DAILY',   500000,  null),
  ('TIER_2', 'CRYPTO_WITHDRAWAL', 'MONTHLY', 2500000, null),
  ('TIER_2', 'FIAT_DEPOSIT',      'DAILY',   1000000, null),
  ('TIER_2', 'FIAT_DEPOSIT',      'MONTHLY', 5000000, null),
  ('TIER_2', 'FIAT_WITHDRAWAL',   'SINGLE',  250000,  10),
  ('TIER_2', 'FIAT_WITHDRAWAL',   'DAILY',   500000,  null),
  ('TIER_2', 'FIAT_WITHDRAWAL',   'MONTHLY', 2500000, null),

  -- TIER_3 — institutional. Ceilings set per agreement, not by configuration.
  ('TIER_3', 'SWAP',              'SINGLE',  null,    10),
  ('TIER_3', 'TRADE',             'SINGLE',  null,    10),
  ('TIER_3', 'CRYPTO_WITHDRAWAL', 'SINGLE',  null,    10),
  ('TIER_3', 'FIAT_WITHDRAWAL',   'SINGLE',  null,    10)
) as l(tier_code, operation, window_kind, max_amount, min_amount)
on conflict (tier_code, operation, window_kind) do nothing;

-- -----------------------------------------------------------------------------
-- Fee rules (spec §26)
--
-- Operation-wide defaults with a NULL asset and NULL tier. Per-asset and
-- per-tier overrides are rows an operator adds later; nothing in the code needs
-- to change for that.
--
-- Withdrawal network fees are intentionally absent rather than guessed: the
-- real cost comes from the crypto provider, and a made-up number shown as a
-- network fee is exactly the kind of fiction spec §80 rules out.
-- -----------------------------------------------------------------------------

insert into public.fee_rules (operation, asset_id, tier_code, percentage, fixed_fee, min_fee, max_fee)
values
  ('SWAP',            null, null, 0.50, 0, null, null),
  ('TRADE',           null, null, 0.20, 0, null, null),
  ('DEPOSIT',         null, null, 0,    0, null, null),
  ('WITHDRAWAL',      null, null, 0,    0, null, null),
  ('FIAT_DEPOSIT',    null, null, 0,    0, null, null),
  ('FIAT_WITHDRAWAL', null, null, 1.00, 0, null, null)
on conflict (operation, asset_id, tier_code) do nothing;

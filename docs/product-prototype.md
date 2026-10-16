# JimoCex — product prototype

This document describes the working exchange **prototype**: what is real, what is
deterministic demo data, and where a client connects real providers. It
complements `client-handoff.md` (operational handoff) and `white-label.md`
(rebranding).

> **Nothing here is a live exchange.** No liquidity/execution venue, custodian,
> payment, KYC/AML, fiat or blockchain provider is connected. The product is a
> complete, navigable interface over the real core (exact money, double-entry
> ledger, order engine, RLS) with honest states everywhere a real provider is
> missing.

## Information architecture

Customer (public): `/`, `/markets`, `/markets/[pair]`, `/exchange`, `/trade`,
`/trade/[pair]`, `/support`, `/support/faq`, `/support/contact`, plus company and
legal pages (`/about`, `/fees`, `/how-it-works`, `/blog`, `/status`, `/terms`,
`/privacy`, `/risk`).

Customer (signed-in, `(app)` group — `requireUser` + sidebar shell):
`/dashboard`, `/wallets` (+ `/deposit`, `/withdraw`, `/transactions`),
`/orders` (+ `/[id]`), `/assets` (+ `/[symbol]`), `/account`
(+ `/profile`, `/security`, `/sessions`, `/api-keys`, `/verification`),
`/settings`.

Operator (`/admin/*`, gated by `getAdminViewer`/`requireAdmin`): dashboard,
users (+ detail), orders, trades, deposits, withdrawals, assets, markets, fees,
limits, kyc, audit, system, and the provider surfaces (providers, liquidity,
custody, payments).

Navigation lives in one place (`src/components/layout/nav-config.ts`); the
header, sidebar, mobile bar and footer all read from it.

## What is real vs. prototype

| Area | Real | Prototype / honest-unavailable |
| --- | --- | --- |
| Balances | `wallets` + append-only `ledger_entries`, read under RLS | — |
| Orders (LIMIT) | place / preview / cancel through the order engine, exact fee + reserve, idempotent | MARKET refused (no venue) |
| Trade/ledger history | real DB reads | empty until fills exist |
| Markets catalog | `trading_pairs` / `assets` | — |
| Prices, 24h stats, order book, candles | — | **deterministic demo** source, labelled "Demo data" |
| Portfolio valuation | exact Money math | valued with demo prices, labelled |
| Exchange | real fee (`fee_rules` + `computeFee`), quote math | demo rate; **no execution** (confirm is honest) |
| Deposit address | — | deterministic **prototype** address, not monitored |
| Withdrawal request | real `withdrawals` row at `REQUESTED` via gated service-role insert | never auto-completed (no payout provider); no ledger hold |
| Fees / limits | real `fee_rules` / `tier_limits` | — |
| KYC / AML, sessions, API keys, settings, support tickets | — | honest prototype surfaces; no new tables |

## Demo trading (BTC/USDT, ETH/USDT, SOL/USDT)

The demo trading set is **BTC-USDT, ETH-USDT and SOL-USDT** — and only those.
Whether a pair accepts orders is `trading_pairs.trading_enabled` in the
database; `src/config/brand.ts` cannot change it (see `white-label.md`). Both the
order engine (`TRADING_DISABLED`) and `place_limit_order` itself refuse a
disabled pair, so no UI path or service-role caller can open an order on one.

**Enabled by migration 021** (`supabase/migrations/021_enable_demo_trading.sql`).
Migration 011 seeds every pair with `trading_enabled = false` and nothing else
may change it, so 021 sets it to `true` on exactly those three rows — and refuses,
changing nothing, if any of them is missing. Swaps stay off everywhere and the
other 13 pairs stay disabled. Rollback (a separate, reviewed statement — this
repository has no down migrations):

```sql
update public.trading_pairs
set trading_enabled = false
where symbol in ('BTC-USDT', 'ETH-USDT', 'SOL-USDT');
```

A rollback does not touch an order already OPEN on those pairs — it can still be
cancelled, which releases its hold.

**Migrations run everywhere.** Any database that applies 021 accepts LIMIT orders
on those three pairs, a client's production database included. A deployment
launching without a connected execution venue must disable them with a reviewed
migration (the statement above) — see `client-handoff.md`.

The three show **Limit orders** in the trade terminal's market list ("Limit
orders enabled · execution not connected" on the selected pair); every other pair
shows **View only**, its order form has no submit button, and its pair page says
"Limit orders: Not enabled".

What a demo order does — and does not do:

- **Place** (LIMIT only): the engine validates, prices the fee and reserve on the
  server, and `place_limit_order` opens the order `OPEN` and posts one `HOLD`
  (BUY holds the quote: notional + fee; SELL holds the base amount).
- **Cancel**: `cancel_order` posts exactly one `RELEASE` of what is still held and
  marks the order `CANCELLED`; a second cancel is a no-op.
- **Never fills.** No execution provider is connected, nothing calls `apply_fill`,
  and no trade row is written — an order stays `OPEN` until it is cancelled.
- **Survives a lost response.** If the answer to a placement never arrives, the
  form says it could not confirm the order and keeps its idempotency key: the
  retry returns the order the server already placed (with its real reserve)
  instead of placing and reserving a second one.
- **Limits are real.** TIER_0's per-order ceiling (USD 5,000, minimum 10) is
  checked against the demo price: the demo source values BTC, ETH and SOL in USD
  at their USDT pair's demo price (`USD_VALUATION_CROSSES` in `prototype.ts`).

### Demo balance

A new account holds nothing, and the prototype credits no deposit, so an order
is refused as insufficient balance. For development and preview only,
`scripts/fund-demo-account.ts` gives ONE configured account a ledger-backed
opening balance — 10,000 USDT, 1 BTC, 10 ETH, 100 SOL — as `ADJUSTMENT` entries
through `ledger_post`, once (dedup key per asset; a re-run posts nothing), with an
audit row each. It refuses, before connecting, unless
`NEXT_PUBLIC_JIMOCEX_DEMO_MODE=true`, nothing says production, and the target is a
local stack or a named non-production `supabase.co` project. It is a command-line
script run by an operator with the target's service-role key — no route, action
or page reaches it. Procedure: `preview-environment.md`, step 7.

Proven by the "021" and "Slice 9 — the demo trading set" blocks of
`supabase/tests/01_invariants.sql`, by `src/lib/engines/__tests__/order-engine.test.ts`
and `scripts/__tests__/demo-funding.test.ts`, and by a local run of the whole flow
through the real UI (`preview-environment.md`, Evidence, Slice 10).

## Deterministic demo market data

`src/lib/providers/market-data/prototype.ts` is a provider behind the existing
`MarketDataProvider` seam. It is:

- **deterministic & stable** — a pair's figures are a pure function of the pair
  symbol and the current UTC day (no `Math.random()`, same for every viewer,
  moves once a day);
- **float-free** — every figure is computed in exact `Money` (BigInt) and
  crosses out as a `DecimalString`, exactly like a real adapter;
- **labelled** — its `kind` is `"demo"`, and `PriceSourceNote` / page banners say
  "Demo data" wherever it appears. It is never presented as a live feed.

Selection (registry `src/lib/providers/market-data/index.ts`): the env var
`JIMOCEX_MARKET_DATA_PROVIDER` wins if set; otherwise `product.demoMarketData`
(brand config) picks `"prototype"` when true and the refusing `"unavailable"`
provider when false. A real deployment sets `demoMarketData: false` and names a
real adapter.

## Connecting real providers

Every external dependency is an adapter behind a server-side boundary:

- **Market data** → implement `MarketDataProvider`, register it, set the env var.
- **Execution / liquidity** → `ExecutionProvider` → `ExecutionService` →
  `SettlementService` → `apply_fill` (see `execution-provider.md`,
  `settlement-service.md`). Until connected, LIMIT orders rest `OPEN` and MARKET
  is refused.
- **Custody / payments / KYC / AML / fiat / notifications** → not yet
  abstracted in code; the `/admin/providers` surface documents them as
  configuration points. No secrets are shown or accepted there.

## Financial-safety invariants (unchanged)

The prototype adds UI and reads only; it does not weaken any core rule:

- money is exact `Money`/`DecimalString` end to end — no float, no client-supplied
  fee/reserve/balance/userId;
- balances change only through `ledger_post`; `apply_fill` is the only settlement;
- the browser reaches the engine only through server actions that take intent,
  not authority; identity comes from the verified session (DAL), never a payload;
- the withdrawal insert is the one new write — a `REQUESTED` row via the
  service-role client after `requireActiveUser`, never a balance write;
- `src/config/brand.ts` stays presentation-only and is never a security boundary.

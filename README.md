# JimoCex

A white-label crypto / FX / fiat exchange MVP.

**One account. Three core products: Exchange, Trade, Markets.**

> **JimoCex is the default brand, not a hard-coded one.** The application name,
> logo, colours, support details and which products appear all come from
> `src/config/brand.ts`. To stand up a new client, see
> [`docs/white-label.md`](docs/white-label.md).

---

## What this MVP includes (works today)

- **Authentication & accounts** — Supabase Auth, email verification, account
  status, tiers, and a Data Access Layer (`src/lib/auth/session.ts`) that
  establishes identity from the session, never from a request body.
- **Markets** — listed from `trading_pairs` (real configuration).
- **Trading UI** — the four-panel terminal at `/trade` and `/trade/[pair]`.
- **LIMIT orders** — placed through a server order engine with server-side
  validation of market, side, price/amount precision, min/max, tier limits.
- **Server-computed fees & reserve** — shown to the user before they commit;
  the client never computes or sends a fee or a hold amount.
- **Balances & reservation** — real, ledger-backed: a BUY holds quote, a SELL
  holds base; available↓ / locked↑.
- **Open orders & cancel** — real rows for the signed-in user; cancel releases
  the hold atomically; the order becomes `CANCELLED`.
- **Internal ledger** — append-only double-entry; one writer (`ledger_post`);
  exact `numeric(38,18)` money; reconciliation invariant.
- **Database security** — Row Level Security on every table; money movers are
  `service_role`-only `SECURITY DEFINER` functions.
- **Core server boundaries** — the browser reaches the engine only through
  typed Server Actions that return safe results (no SQL, no internals).

## What is intentionally NOT connected

Each defaults to an honest "unavailable" state — never invented data.

| Capability | Status |
| --- | --- |
| Market-data provider (prices, candles, order book) | Not connected |
| Liquidity / execution venue | Not connected |
| Custodian | Not connected |
| Crypto deposits / withdrawals | Not connected |
| Payment processor / fiat rails | Not connected |
| KYC / AML provider | Not connected |
| Production notifications (email/push) | Not connected |
| Production infrastructure & secrets | Client-provided |

Because no execution venue exists, a placed LIMIT order **rests as `OPEN` and
does not fill** — it never pretends to be `FILLED`. Market orders are shown as
unavailable. See [`docs/client-handoff.md`](docs/client-handoff.md) for the full
delivered-vs-to-complete split.

## Architecture

- **Next.js 16** (App Router), React 19, TypeScript strict
- **Supabase** — PostgreSQL, Supabase Auth, Row Level Security
- Migrations are plain SQL in `supabase/migrations/` (001 … 018), applied in
  filename order

### The financial core

Money is `numeric(38,18)` everywhere, carried in the app as an exact `bigint`
(`src/lib/money.ts`) — never a float. `ledger_entries` is append-only (an
`UPDATE`/`DELETE` is refused for every role, `service_role` included); a
correction is a new `ADJUSTMENT` entry. Each entry carries two signed deltas:

| Entry | available | locked |
| --- | --- | --- |
| `DEPOSIT` | `+X` | `0` |
| `HOLD` | `−X` | `+X` |
| `RELEASE` | `+X` | `−X` |
| `WITHDRAWAL` | `0` | `−X` |

Balances change through exactly one function, `public.ledger_post()`, in one
transaction serialized per wallet. Order placement and cancellation
(`place_limit_order`, `cancel_order`, migration 018) create the order row **and**
post the HOLD/RELEASE in the same transaction, so there is never an order
without its reservation.

## Local development

```bash
npm install                      # install dependencies
cp .env.example .env             # then fill in Supabase values (see below)
npm run dev                      # start the dev server at http://localhost:3000

npm run typecheck                # tsc --noEmit
npm run lint                     # eslint
npm run test:unit                # node --test (pure engines, money, parsers, config)
npm run test:db                  # throwaway PG cluster: SQL invariants (profile 017)
npm run test:db:019              # same, privilege profile 019
npm run build                    # production build
npm run verify                   # lint + typecheck + test + build
```

`.env` holds `SUPABASE_SERVICE_ROLE_KEY`, which **bypasses RLS** and must never
appear in a `NEXT_PUBLIC_*` variable, a client component, or the browser bundle.
`npm run test:db` needs a local PostgreSQL 16 (it builds and destroys its own
cluster; the hosted project is never touched).

**Migrations.** Apply `supabase/migrations/*.sql` in filename order to a
database you control. For the audited hosted rollout, follow
[`docs/preview-environment.md`](docs/preview-environment.md) — do not apply to a
hosted project outside that gate.

## Configuration

| What | Where |
| --- | --- |
| Brand name, wordmark, tagline, company name | `src/config/brand.ts` → `brand` |
| Logo artwork, favicon | `src/components/brand/LogoMark.tsx`, `public/brand/*`, `src/app/icon.svg` |
| Colours / palette | `src/styles/tokens.css` (brand mirrors the accent in `brand.theme`) |
| Support email / links, legal & social links | `src/config/brand.ts` → `brand` |
| Which products & order types the UI offers | `src/config/brand.ts` → `product` |
| Visible trading pairs | `src/config/brand.ts` → `product.enabledMarkets` |
| Supabase URL / keys, app URL, provider selection | `.env` (see `.env.example`) |

`src/config/brand.ts` is **presentation/product configuration only**. It is
imported into the browser bundle and must never hold a secret, a fee, a limit or
an authorization decision. Those are server- and database-controlled and cannot
be changed from this file. See [`docs/white-label.md`](docs/white-label.md).

## Provider integration (for the client)

The application talks to external systems only through typed interfaces and
database integration points, so a provider can be introduced without touching a
component, a route or an engine. Every provider defaults to an adapter that
honestly refuses.

- **Market data** — implement `MarketDataProvider`
  (`src/lib/providers/market-data/types.ts`) and register it; select it with
  `JIMOCEX_MARKET_DATA_PROVIDER`. It must return exact `DecimalString` figures
  (parse upstream JSON with `parseJsonExact`), and **say so when it cannot** —
  never interpolate, fall back silently, or invent a price.
- **Execution / liquidity, custodian, deposits, withdrawals, payments,
  KYC/AML** — integration points exist in the schema (`trading_orders`,
  `provider_events`, `deposits`, `withdrawals`) but **no code interface is
  built yet**; these are client integration tasks. The general contract the
  schema already assumes: persist the provider's own id (e.g.
  `trading_orders.provider_order_id`), make every inbound effect idempotent
  (verify the signature over raw bytes, store the raw payload, dedup on
  `(provider, event_id)`), handle provider errors as refusals rather than
  guesses, and reconcile provider state against the ledger. See
  [`docs/provider-webhook-payloads.md`](docs/provider-webhook-payloads.md) and
  [`docs/client-handoff.md`](docs/client-handoff.md). This repository does not
  define any specific provider's API — that is filled in per integration.

## Documentation

- [`docs/client-handoff.md`](docs/client-handoff.md) — what is delivered, what
  the client completes, and a before-production checklist.
- [`docs/white-label.md`](docs/white-label.md) — standing up a new client
  instance from this one codebase.
- [`docs/preview-environment.md`](docs/preview-environment.md) — audited hosted
  rollout gate for migrations.
- Further design notes under `docs/` (ledger model, privileges, webhook
  payloads, fees).

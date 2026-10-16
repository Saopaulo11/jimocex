# White-label: standing up a new client instance

This codebase is a **single reusable exchange template**. Each client is a
**separate deployment with its own isolated database and secrets** — not a
tenant inside a shared system. There is deliberately **no multi-tenant
architecture**: one codebase → one client instance per deployment.

> **Never reuse another client's production database, secrets or provider
> credentials.** Every client gets its own Supabase project, its own
> `SUPABASE_SERVICE_ROLE_KEY`, and its own provider accounts. Crossing these is
> a data-isolation and security incident, not a shortcut.

---

## Procedure

### 1. Clone / copy the repository

Start from this template for the new client.

### 2. Create a new environment

A separate hosting environment (e.g. a new Vercel project) dedicated to this
client. Do not point it at another client's resources.

### 3. Create an isolated Supabase project / database

A brand-new Supabase project for this client only. This is the client's data
boundary — it is never shared.

### 4. Apply migrations

Apply `supabase/migrations/*.sql` in filename order to the new database. For a
hosted project, follow the audited gate in
[`preview-environment.md`](preview-environment.md); do not apply outside it.

### 5. Configure environment variables

Copy `.env.example` to `.env` (or set them in the host) and fill in **this
client's** values:

- `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY` (server-only; bypasses RLS)
- `NEXT_PUBLIC_APP_URL` (the client's domain, used for email links)
- provider selection variables (e.g. `JIMOCEX_MARKET_DATA_PROVIDER`) once real
  adapters exist — leave unset to keep honest "unavailable" states

### 6. Configure the brand

Edit `src/config/brand.ts` → `brand`:

- `name`, `wordmark` (a plain string, or a two-tone `{ primary, accent }`
  split like the JimoCex default), `tagline`, `description`
- `companyName` (copyright / legal display name)
- `supportEmail`, `supportUrl`
- `legalLinks`, `socialLinks`
- `theme.accentColor` / `theme.backgroundColor` (these mirror the palette and
  feed the browser theme colour)

Then the **visual assets**:

- Logo artwork: `src/components/brand/LogoMark.tsx` (the monogram geometry) and
  the files in `public/brand/` referenced by `brand.logo`
- Favicon: `src/app/icon.svg`
- Full palette: `src/styles/tokens.css` (the `--jc-*` custom properties). The
  `jc-` class prefix is an internal technical identifier — leave it; only change
  the colour values.

### 7. Configure markets / features

Edit `src/config/brand.ts` → `product`:

- `enabledMarkets` — `"all"`, or an allow-list of pair symbols to surface
- `enabledTrading`, `enabledLimitOrders`, `enabledMarketOrders`,
  `enabledExchange`

These are **presentation/product toggles only**. Whether a pair is actually
tradable is `trading_pairs.trading_enabled` in the database; whether a market
order can execute depends on a connected venue. To truly disable trading on a
pair, set `trading_enabled = false` in the database — the config does not and
cannot do that. (Migration 021 enables the demo set — BTC-USDT, ETH-USDT,
SOL-USDT — wherever the migrations run; see `product-prototype.md`.)

### 8. Configure provider adapters

Implement and register the providers this client is launching with (start with
`MarketDataProvider`). Leave the rest on their honest "unavailable" defaults
until their integrations exist. See
[`client-handoff.md`](client-handoff.md#how-integrations-attach).

### 9. Run tests

```bash
npm run typecheck
npm run lint
npm run test:unit
npm run test:db
npm run test:db:019
```

### 10. Build

```bash
npm run build
```

### 11. Deploy

Deploy to the client's own environment with the client's own secrets.

### 12. Client-specific integration verification

In the client's connected environment, verify the real flows end to end against
the client's database and providers: sign-in, markets, placing and cancelling a
LIMIT order (balance reserve/release), and any connected provider. Do not assume
a flow works against a real database until it has been exercised there.

---

## What a client can change without touching core logic

- Brand identity — name, wordmark, tagline, company name, logo, favicon,
  colours, support/legal/social links (`src/config/brand.ts`, `tokens.css`,
  brand assets)
- Which products, order types and pairs the UI offers (`product` config)
- Metadata / titles (derived from the brand name)
- Environment: Supabase project, app URL, provider selection

## What a client must NOT put in brand/product config

Brand config is presentation only, shipped to the browser. It is **not** a
security boundary. Keep these server- and database-controlled, never in
`src/config/brand.ts`:

- fees, limits, account status, verification/eligibility rules
- the ledger and its invariants
- Row Level Security, authorization decisions
- service-role credentials, provider secrets

Changing a brand/product value can never enable a financial capability the
database and server engines do not already permit.

# Client handoff

This document describes what is delivered as a working exchange MVP, what the
client completes to reach production, and the checklist to run before going
live. It is a practical handoff, not legal or regulatory advice.

The default brand is **JimoCex**; everything brand-related is configurable
(see [`white-label.md`](white-label.md)).

---

## Delivered by us (works today)

A functioning, self-contained exchange core:

- **Authentication & accounts** — Supabase Auth, email verification, account
  status and tiers, and a server-side Data Access Layer that derives identity
  from the session (never from a request body).
- **Markets** — real `trading_pairs` configuration, listed in the UI.
- **Trading** — the Trade terminal, with a server order engine that places
  **LIMIT** orders after server-side validation (market enabled, side,
  price/amount precision, min/max order size, tier limits).
- **Fees & reservation** — computed on the server from `fee_rules` and shown to
  the user before they commit; the reserve is a real ledger HOLD (BUY holds
  quote = notional + fee; SELL holds base = amount).
- **Balances** — real, derived from an append-only double-entry ledger.
- **Open orders & cancel** — the user's own orders only; cancel releases the
  hold atomically and sets `CANCELLED`.
- **Idempotency** — placement is idempotent on a client order id; a retry does
  not open a second order or place a second hold.
- **Internal ledger** — exact `numeric(38,18)` money, one writer
  (`ledger_post`), reconciliation invariant, append-only (corrections are new
  entries).
- **Database security** — Row Level Security on every table; money-moving
  functions are `service_role`-only `SECURITY DEFINER`.
- **Server boundaries** — the browser reaches financial logic only through
  typed Server Actions returning safe results; the service-role client never
  enters the browser bundle.
- **Honest unavailable states** — where an integration is absent, the UI says
  so rather than inventing data.
- **Tests** — unit tests (engines, money, parsers, config) and a SQL invariant
  suite run against a throwaway PostgreSQL cluster; production build.

## To be completed by the client (integrations & infrastructure)

None of these are built; each has an honest "unavailable" state today. They are
distinct integration tasks.

- **Liquidity / execution venue** — fill resting orders; report executions.
  Until connected, a LIMIT order rests `OPEN` and never fills.
- **Custodian** — custody of crypto assets.
- **Crypto deposits** — crediting incoming on-chain funds.
- **Crypto withdrawals** — outbound transfers (behind the existing limit / risk
  / compliance checks).
- **Payment processor & fiat rails** — fiat deposits and payouts.
- **KYC / AML provider** — identity verification and screening that drives
  tier upgrades and eligibility.
- **Production market data** — prices, candles, order book (implement
  `MarketDataProvider`; it must refuse honestly when it cannot answer).
- **Production notifications** — email / push delivery.
- **Production infrastructure & secrets** — hosted database, domain,
  credentials, monitoring, backups.

### How integrations attach

- Talk to externals through typed interfaces / DB integration points — not from
  components. `MarketDataProvider` is the built example.
- Persist the provider's own identifier (e.g. `trading_orders.provider_order_id`).
- Make every inbound effect **idempotent**: verify the signature over the raw
  bytes, store the raw payload, and dedup on `(provider, event_id)` (see
  [`provider-webhook-payloads.md`](provider-webhook-payloads.md)).
- Treat a provider that cannot answer as a **refusal**, not a guess.
- **Reconcile** provider state against the internal ledger; the ledger is the
  source of truth.
- This repository defines **no specific provider's API** — that is supplied per
  integration and must not be invented.

## Before production — checklist

- [ ] **Provider credentials** — for each integration actually being launched.
- [ ] **Database** — a dedicated, isolated hosted database for this client;
      migrations applied via the audited gate ([`preview-environment.md`](preview-environment.md)).
- [ ] **Secrets** — `SUPABASE_SERVICE_ROLE_KEY` and provider keys set server-side
      only; never in `NEXT_PUBLIC_*`, client code, or logs.
- [ ] **Domain** — production domain and `NEXT_PUBLIC_APP_URL` (email links).
- [ ] **Email** — a real transactional email sender for auth flows.
- [ ] **Liquidity / execution** — connected and verified, or trading disabled
      at the DB (`trading_pairs.trading_enabled = false`). Migration 021 enables
      LIMIT orders on BTC-USDT, ETH-USDT and SOL-USDT for the demo; without a
      venue those orders reserve funds and never fill, so a launch without one
      disables them with a reviewed migration (the rollback in 021's header).
- [ ] **Demo funding** — `scripts/fund-demo-account.ts` is for development and
      preview only and refuses production; never run it against this database.
- [ ] **Custodian** — connected before enabling deposits/withdrawals.
- [ ] **Deposits / withdrawals** — connected, with limits and compliance checks
      verified end to end.
- [ ] **Payments** — fiat rails connected if fiat is offered.
- [ ] **KYC / AML** — connected and wired to tiers/eligibility.
- [ ] **Monitoring** — logs, error reporting, alerting.
- [ ] **Backups** — database backups and a tested restore.
- [ ] **Production security review** — RLS, secret handling, service-role usage,
      and the full order/cancel/withdraw paths reviewed against the live config.
- [ ] **Regulatory / legal configuration** — licensing, terms, disclosures and
      jurisdiction rules appropriate to the operator (operator's responsibility).

## Known limitations at handoff

- Market orders are not executable (no venue); shown as unavailable.
- Market data is public, read-only display data (`JIMOCEX_MARKET_DATA_PROVIDER`,
  default `binance`: BTC-USDT, ETH-USDT, SOL-USDT only), polled — not a
  streamed or licensed feed, and not an executable quote. Other pairs show no
  price. If the source cannot be reached from the deployment's region, prices
  show as unavailable and the limit check refuses orders. The labelled demo
  source (`prototype`) remains for explicit local/demo use. Whether the public
  source's terms suit a client's production use is the client's decision.
- A resting LIMIT order does not fill until an execution provider is connected.
- The end-to-end app↔Supabase trading flow should be verified in the client's
  own connected environment; it is not exercised against a hosted database here.
- The audited migration gate in `docs/preview-environment.md` is pinned to the
  current migrations (001–018, 020, 021); applying it to a hosted test database
  still needs the owner's go. This does not mean live market data, a connected
  execution venue, or live fills or settlement — none of those exist.

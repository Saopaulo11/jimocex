# JimoCex

Crypto / FX / fiat trading platform.

**One account. Three core products: Exchange, Trade, Markets.**

---

## Status

Early development. The database foundation is built and verified; the
application is being added on top of it.

What exists today is deliberately honest about what it cannot do: no execution
provider, market-data provider, crypto provider, fiat provider or KYC provider
is connected, so nothing in this repository can move real money. Pairs and
assets are listed, but trading and swaps are switched off at the database level
until a provider is wired up. There are no seeded balances, trades or
transactions anywhere — a platform that invents financial history is worse than
one that admits it has none.

| Component | Status |
| --- | --- |
| Database schema, RLS, financial invariants | **Real** |
| Market data | Not connected |
| Crypto liquidity / trade execution | Not connected |
| Crypto deposit / withdrawal | Not connected |
| BRL fiat / RUB fiat | Not connected |
| KYC | Not connected |
| Risk / AML | Not connected |
| Email / notifications | Not connected |

## Architecture

- **Next.js 16** (App Router), React 19, TypeScript strict
- **Supabase** — PostgreSQL 17, Supabase Auth, Row Level Security
- Migrations are plain SQL in `supabase/migrations/`, applied in order

### The financial core

Money is `numeric(38,18)` everywhere. Never a float: `double precision` is
inexact, and an inexact ledger is an unrecoverable accounting bug.

`ledger_entries` is append-only — an `UPDATE` or `DELETE` is refused by a
trigger for every role, including `service_role`. A correction is a new
`ADJUSTMENT` entry, never an edit.

Each entry carries two signed deltas rather than one amount, because money moves
between buckets as well as in and out:

| Entry | available | locked |
| --- | --- | --- |
| `DEPOSIT` | `+X` | `0` |
| `HOLD` | `−X` | `+X` |
| `RELEASE` | `+X` | `−X` |
| `WITHDRAWAL` | `0` | `−X` |

That makes the reconciliation invariant exact: a wallet's balance must equal the
sum of its ledger deltas. `public.reconcile_wallets()` returns only wallets
where it does not — an empty result is the invariant holding.

Balances change through exactly one function, `public.ledger_post()`, which
writes the ledger entry and the wallet projection in one transaction, serialized
per wallet. It is executable by `service_role` only.

## Layout

```
supabase/
  migrations/    001 … 012, applied in filename order
  tests/         Supabase primitives stubbed for local PostgreSQL, + the suite
scripts/
  test-db.sh     fresh cluster -> migrations -> invariants
```

## Tests

```bash
./scripts/test-db.sh
```

Creates a throwaway PostgreSQL cluster, applies every migration, and runs 60
assertions drawn from the specification's financial invariants — overdraft
protection, append-only ledger, single-use quotes, at-most-once deposits and
withdrawals, one-way order status, and Row Level Security exercised as a real
signed-in request. The cluster is destroyed afterwards; the hosted project is
never touched.

The suite tests the *database's* refusals, not the application's intentions. A
bug in a route handler cannot defeat a CHECK constraint.

## Environment

Copy `.env.example` to `.env`. `SUPABASE_SERVICE_ROLE_KEY` bypasses RLS and is
therefore server-only: it must never appear in a `NEXT_PUBLIC_*` variable, in a
client component, or in the browser bundle.

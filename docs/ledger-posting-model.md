# Ledger posting model: amount, deltas and entry type

Status: analysis and proposal. No schema change. Must be decided and enforced **before the first new
caller of `ledger_post()`** (deposit crediting, withdrawal completion, trade or swap settlement).

## What the database guarantees today (after 017)

- A balance moves only through `ledger_post()`: no role but the table owner can write `wallets` or
  `ledger_entries`; `ledger_entries` refuses UPDATE, DELETE and TRUNCATE for every role.
- Each entry and its wallet change are written in one statement, under the wallet's row lock; a
  duplicate `dedup_key` aborts the whole call.
- Every figure is present, finite, not NaN, at most 18 decimals and within `numeric(38,18)`.
- `amount > 0`; at least one delta is non-zero; neither bucket goes below zero.
- `reconcile_wallets()` reports any wallet whose balances differ from the sum of its deltas.

What it does **not** check: that `amount` describes the deltas, or that the deltas match the entry type.

## Reproduction (local PostgreSQL 17, hosted-015 replica with package v4, as `service_role`, rolled back)

```sql
select public.ledger_post(:user, :usdt, 'DEPOSIT', 1, 1000, 0, 'p12', null, 'p12:1');   -- accepted
select public.ledger_post(:user, :usdt, 'DEPOSIT', 5,   -5, 0, 'p12', null, 'p12:2');   -- accepted: a "deposit" that debits
select public.ledger_post(:user, :usdt, 'HOLD',   10,  -10, 3, 'p12', null, 'p12:3');   -- accepted: a hold that destroys 7
```

Result: wallet `985 / 3`; `reconcile_wallets()` returns no row; `sum(amount)` is 16 while the net movement
is 988.

So the balance invariant holds — balances equal the ledger — but the ledger can say something false:
`amount` (used for statements and reporting) can disagree with what moved, a type can carry the wrong
direction, and a HOLD or RELEASE, which should only move funds between buckets, can create or destroy
them. Reconciliation cannot see any of it, because it compares balances with deltas, not deltas with
meaning.

Exposure today: only `service_role` and `SECURITY DEFINER` functions can call `ledger_post()`. The one
caller in the schema, `release_withdrawal_hold()`, posts `RELEASE amount X, available +X, locked −X` —
consistent. The application does not call it yet. A wrong posting therefore needs a server-side bug; once
deposit crediting or settlement exists, such a bug would be recorded as fact and not detected.

## Why not `amount = greatest(|available_delta|, |locked_delta|)`

It holds for every scheme 004 documents, but it is the wrong invariant: it would still accept a
"deposit" that debits and a hold that destroys funds (both satisfy it with suitable numbers), and it would
forbid a combined entry should settlement ever need one. The rule has to come from the entry type.

## Proposed model: one movement per entry, rules by type

| entry_type | available_delta | locked_delta |
|---|---|---|
| DEPOSIT, FIAT_DEPOSIT | +amount | 0 |
| HOLD | −amount | +amount |
| RELEASE | +amount | −amount |
| WITHDRAWAL, FIAT_WITHDRAWAL | 0 | −amount (held funds leave) |
| TRADE, SWAP, TRADE_FEE, SWAP_FEE | to be fixed with the settlement design: one bucket moves by ±amount |
| ADJUSTMENT | either bucket, ±amount; requires an audit reference |

An operation that changes several things (a fill that consumes a hold and refunds the rest, a fee) is
several entries in the same transaction with one `reference_id`, each obeying its row. `amount` is then
always the size of the one movement it records, and HOLD/RELEASE conserve funds by construction.

Enforcement: in `ledger_post()` (refuse with `23514` before writing), plus one invariant test per type for
the accepted pattern and for each refused pattern — the reproduction above among them. A CHECK on
`ledger_entries` could express the same table and is worth adding alongside; the function check comes
first because it reports the caller's mistake by name.

When: in the migration that introduces the first new posting flow, together with that flow — not in 017,
which does not change what callers exist, and before any real money is posted.

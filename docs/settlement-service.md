# Settlement service (Slice 6C)

How a validated external execution **fill** becomes an internal **trade** and a
**ledger settlement**. This is the wiring between the provider-neutral execution
seam (Slice 5) and the atomic SQL `apply_fill` (migration 020, Slice 6B).

> **No live venue is connected.** Nothing produces an `ExecutionFill` in this
> deployment, so nothing calls the settlement service, and a reserved LIMIT order
> stays `OPEN`. This slice builds the primitive; connecting a real LP adapter
> (and so actually producing fills) is later work. The settlement service never
> fabricates a fill, and it is **not** wired into the Order Engine.

---

## The chain

```
ExecutionProvider        src/lib/execution/*        (a concrete LP adapter, future)
      ↓  (provider-neutral types, DecimalString money)
ExecutionService         src/lib/execution/service.ts   (timeout, classify, dedupe, reconcile reads)
      ↓  ExecutionFill (validated, discrete, with its own externalFillId)
SettlementService        src/lib/settlement/service.ts  (pure orchestration, DI gateway)
      ↓  ApplyFillInput (exact Money)
apply_fill(...)          supabase/migrations/020        (THE atomic financial boundary)
      ↓  ledger_post(...) only
Ledger / wallets         the source of truth
```

`apply_fill` is the **only** financial operation: it inserts the trade, posts
the `TRADE` / `TRADE_FEE` / `RELEASE` ledger entries and updates the order in one
transaction. The settlement service moves no money, writes no wallets, and
writes no ledger entries; it resolves identity, validates, maps, calls
`apply_fill`, and classifies the result.

## `ExecutionFill` → `apply_fill` mapping

`mapExecutionFillToApplyFill` (pure, `src/lib/settlement/types.ts`):

| `ExecutionFill` | `apply_fill` arg | Notes |
| --- | --- | --- |
| (resolved server-side) | `p_order_id` | from `resolveOrderByExternalId(externalOrderId)` — never a client value |
| `externalFillId` | `p_provider_trade_id` | authoritative idempotency key (`trades.provider_trade_id`) |
| `amount` | `p_base_amount` | base filled |
| `quoteAmount` | `p_quote_amount` | **venue-authoritative** — never `price × amount` |
| `price` | `p_execution_price` | recorded; validated against quote, not used to recompute it |
| `fee` | `p_fee_amount` | server-trusted execution input (fee-source policy deferred) |
| (resolved from `feeAsset`) | `p_fee_asset_id` | symbol → id; `null` when the fee is zero |
| `executedAt` | `p_executed_at` | |

`ExecutionFill` gained a `quoteAmount` field in this slice: `apply_fill` needs
the venue's exact executed quote, and deriving it from `price × amount` is
exactly what Slice 6A/6B forbid. A cumulative-quote venue must derive the
per-fill delta before building the `ExecutionFill`.

## Error taxonomy

`classifyApplyFillError` maps a raw `apply_fill` SQL error to a bounded code and
a **generic** message — the raw PostgreSQL text is never surfaced:

| SQLSTATE / shape | Code | retryable | reconcile |
| --- | --- | --- | --- |
| `23503` (unknown order) | `ORDER_NOT_FOUND` | no | yes |
| `23001` (terminal order) | `ORDER_NOT_SETTLEABLE` | no | yes |
| `23514` + "exceeds order" | `OVER_FILL` | no | yes |
| `23514` + fee message | `INVALID_FEE` | no | no |
| `23514` + "is reserved" | `INSUFFICIENT_RESERVATION` | no | yes |
| `23514` + "inconsistent with price" | `INVALID_PRECISION` | no | no |
| `23514` (other) | `INVALID_FILL` | no | no |
| `40001`/`40P01`/`08xxx`/`53300`/none | `DATABASE_ERROR` | **yes** | no |
| anything else | `UNKNOWN` | no | yes |

Success is `SUCCESS` (new trade) or `DUPLICATE` (the fill was already settled —
detected by a pre-read, and guaranteed either way by `apply_fill`'s atomic
`provider_trade_id` idempotency). `retryable` means a safe re-call; `reconcile`
flags a provider/internal inconsistency to investigate.

## Idempotency

The authoritative key is `trades.provider_trade_id`. The service returns
`DUPLICATE` when a trade already exists for the fill and does not call
`apply_fill`; even without that pre-check, `apply_fill` is atomically idempotent
(`ON CONFLICT (provider_trade_id) DO NOTHING`), so a race never double-settles —
no second trade, no second ledger posting, no second `filled_amount` increment.
Provider **event** de-duplication (`provider_events`) is a separate mechanism
and is not conflated with the provider **trade** id.

## Cumulative snapshots

A venue that reports a cumulative filled amount is **not** a fill.
`deriveFillDelta(cumulativeFilledBase, internalFilledBase)` computes the
unsettled delta; only a positive delta becomes a discrete `ExecutionFill` (with
its own `externalFillId`), minted by the adapter. The settlement service only
ever settles one concrete fill. A non-positive delta is nothing to settle.

## Reconciliation (pure decision, no polling, no worker)

`decideReconciliation` chooses, given the venue's order status, its discrete
fills, the already-applied trade ids, and the internal order status:

- unseen fills + live order → **SETTLE** the unseen fills
- unseen fills + terminal internal order → **INCIDENT** (venue reports more than the order holds)
- no unseen fills + venue FILLED but internal not FILLED → **RECONCILE_REQUIRED**
- otherwise → **NOOP**

There is no scheduler or background worker here — only the decision function, to
be driven by future orchestration.

## Security

- `service.server.ts` is `server-only`; the admin client never reaches the
  browser bundle, and the browser can never call `apply_fill`.
- Order identity is resolved server-side from the venue's external order id; the
  service takes no internal order id, user id, wallet, fee, execution price or
  settlement amount from a caller — a fill with an unmapped external id is
  `ORDER_NOT_FOUND`, not a chance to settle an arbitrary order.
- Every money argument crosses through `moneyArgs("apply_fill", …)`; no float.
- `apply_fill` (service-role-only) is the single atomic settlement; no wallet or
  ledger row is written from TypeScript.
- Raw provider/SQL errors are never shown; results carry only a bounded code and
  a generic message.

## Trust restated

A provider response is **not** financial truth. It is validated against the
internal order and then handed to `apply_fill`, which revalidates and is the
atomic authority. The ledger — not the venue — is the source of truth, and every
settlement is auditable (`trades` row + `ledger_entries`, reconcilable by
`reconcile_wallets()`).

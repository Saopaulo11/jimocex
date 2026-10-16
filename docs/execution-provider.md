# Execution / liquidity provider integration

This is the **provider-neutral foundation** for connecting an execution /
liquidity venue (Slice 5). It defines the seam, the contract, the lifecycle and
the safety rules. It does **not** connect a real venue, and it deliberately
describes **no specific provider's API**.

> **Status.** No liquidity-provider / execution-venue API documentation is
> present in this repository or the accessible workspace. Therefore: **a
> concrete LP integration cannot yet be implemented from the currently
> accessible materials.** What is built here is the neutral boundary a client's
> LP adapter plugs into; the adapter itself is the client's integration task and
> must be written against that provider's real documentation.

---

## Provider-neutral architecture

```
client
  → Order Engine            (src/lib/engines/order-engine.ts — pure, DI)
  → Execution Service       (src/lib/execution/service.ts — pure, timeout + classification + idempotency)
  → ExecutionProvider       (src/lib/execution/types.ts — the interface the core sees)
  → a concrete LP adapter   (client-written, server-only, holds the venue's credentials)
```

The core never names a provider. A venue is selected by the server-side
environment variable `JIMOCEX_EXECUTION_PROVIDER` (default `"unavailable"`), via
the registry in `src/lib/execution/index.ts` — exactly like the market-data
registry. Replacing the venue, or adding a second one later, means writing an
adapter and registering it; nothing in the Order Engine, the ledger, or any
business logic changes.

## The `ExecutionProvider` contract

See `src/lib/execution/types.ts` for the authoritative types. Shape:

```ts
interface ExecutionProvider {
  readonly name: string;
  isConfigured(): boolean;
  placeOrder(request, options?): Promise<ExecutionOrderAck>;
  cancelOrder(ref, options?): Promise<ExecutionCancelAck>;
  getOrder(ref, options?): Promise<ExecutionOrderView>;
  getOpenOrders(options?): Promise<ExecutionOrderView[]>;
  getFills(ref, options?): Promise<ExecutionFill[]>;
}
```

- **Money crosses as `DecimalString`** (exact decimal text) — never a JS number,
  never a bigint. An adapter parses an upstream body with `parseJsonExact()` /
  `asDecimalString()` so no figure passes through a float.
- **LIMIT only.** MARKET is refused by the core before it reaches here.
- **`ExternalOrderStatus` is the provider's own enum**, mapped to internal
  `order_status` by `mapExternalStatus` — a provider's vocabulary never leaks
  into the core. `UNKNOWN` maps to nothing; it is a reconciliation event.
- The adapter should throw a classified **`ExecutionError`** (`kind`,
  `retryable`, `ambiguous`); the Execution Service classifies anything else as
  `PROVIDER_ERROR` and never propagates a raw message.

## Order lifecycle

```
client → Order Engine
  → internal order created OPEN + funds reserved (HOLD)   [place_limit_order, migration 018 — EXISTS]
  → Execution Service.submitOrder(...)                    [carries the internal clientOrderId]
  → venue accepts → externalOrderId persisted             [trading_orders.provider_order_id — EXISTS]
  → fill(s) arrive (poll getFills / getOrder, or webhook) [provider_events dedup — EXISTS]
  → internal trade row created                            [trades.provider_trade_id unique — EXISTS]
  → ledger settlement: consume HOLD, credit/debit assets  [apply-fill settlement fn — NOT YET BUILT]
```

Today the chain stops after "internal order created OPEN + reserved": with no
venue, `submitOrder` returns `UNAVAILABLE` and the order rests `OPEN` honestly.
Wiring the Execution Service into the Order Engine, and building the atomic
apply-fill settlement, are the next steps (they need the real venue's fill
semantics — see "What still requires the client").

### Race conditions and how they are handled

| Situation | Handling |
| --- | --- |
| Venue accepts but the HTTP response is lost | `submitOrder` returns a **TIMEOUT**/NETWORK error flagged `ambiguous: true`. The caller **reconciles** (`reconcileByClientOrderId` → `getOrder`), it does **not** resubmit. |
| Client retries the same user action | The same internal `clientOrderId` is reused; `place_limit_order` is first-wins, and the venue is asked to be idempotent on that same key — no second order. |
| Provider replays a duplicate event / fill | `getFills` de-duplicates by `externalFillId`; the authoritative guard is the unique `trades.provider_trade_id` and `provider_events(provider, event_id)`. |
| Cancel arrives while a fill arrives | The service never guesses; it reads the venue's authoritative `getOrder` + `getFills`, and settlement reconciles that against the internal order. A partial fill before a cancel is kept. |
| Partial fill / full fill | Reported by the venue; mapped via `mapExternalStatus` to `PARTIALLY_FILLED` / `FILLED`. Settlement posts only the delta. |
| Provider timeout / rejection / unknown order | Classified to `TIMEOUT` / `REJECTED` / `UNKNOWN_ORDER`; the raw error never reaches the client. |
| Webhook arrives before the polling response | Both land in the same idempotent sinks (`provider_events`, `trades.provider_trade_id`); whichever is first wins, the other is a no-op. |

## Idempotency

- **Placement:** the internal `client_order_id` is the idempotency key end to
  end — DB (`(user_id, client_order_id)` unique, first-wins), and passed to the
  venue as its client order id.
- **Fills / settlement:** `trades.provider_trade_id` is unique and
  `mark_trade_settled` claims a trade for settlement exactly once, so a replayed
  execution report cannot double-credit.
- **Webhooks:** `provider_events(provider, event_id)` + `claim_provider_event`
  give single-winner handling (see `docs/provider-webhook-payloads.md`).

## External order identity

- The venue's order id → `trading_orders.provider_order_id` (unique).
- The venue's trade id → `trades.provider_trade_id` (unique).
- A client/browser **never** supplies an external id; the engine establishes it
  from the venue response and persists it server-side.

## Reconciliation boundary

A provider response is **never** internal financial truth — it is an
instruction. Settlement validates every fill against the internal order and the
append-only ledger before posting, and the ledger (not the venue) is the source
of truth. `getOpenOrders` / `getFills` support a periodic reconciliation that
compares venue state to internal state and surfaces drift, rather than trusting
either blindly.

## Provider error handling

`ExecutionErrorKind` is bounded: `UNAVAILABLE`, `TIMEOUT`, `REJECTED`,
`DUPLICATE`, `UNKNOWN_ORDER`, `RATE_LIMITED`, `AUTH`, `NETWORK`,
`PROVIDER_ERROR`. The Execution Service returns a safe
`{ kind, retryable, ambiguous, message }` — never a URL, a key, or a stack. A
server action maps the `kind` to an `AppError`/HTTP status at the edge.

## Where credentials belong

In the **adapter's own server-only environment variables**, read only inside
the `server-only` adapter module. Never in `src/config/brand.ts` (that ships to
the browser), never in a `NEXT_PUBLIC_*` variable, never logged, never in client
components. Provider selection (`JIMOCEX_EXECUTION_PROVIDER`) is server-side
configuration; one deployment serves one client/exchange instance (no
multi-tenant).

## How a future client-specific LP adapter should be implemented

1. Write `src/lib/execution/<provider>.ts` with `import "server-only"`,
   implementing `ExecutionProvider`.
2. Read the venue's credentials from that module's own env vars; sign requests
   per the venue's scheme.
3. Parse every upstream amount with `parseJsonExact()` / `asDecimalString()` →
   `DecimalString`. Never `JSON.parse` a money field into a number.
4. Map the venue's statuses to `ExternalOrderStatus`; throw `ExecutionError`
   with the correct `kind` on failure (set `ambiguous` for timeouts / dropped
   connections).
5. Always echo the `clientOrderId` to the venue for idempotency; return the
   venue's order id as `externalOrderId`.
6. Register it in `src/lib/execution/index.ts` and set
   `JIMOCEX_EXECUTION_PROVIDER`.
7. Then (separate work) build the atomic apply-fill settlement DB function and
   wire the Execution Service into the Order Engine.

## Confirmed provider capabilities

None — no LP API documentation is available in the accessible materials, so no
provider capability can be confirmed here. This section is to be filled in from
the chosen venue's real documentation when it exists. Nothing above invents an
endpoint, a field, or an authentication scheme.

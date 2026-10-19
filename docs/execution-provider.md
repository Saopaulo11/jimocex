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
  readonly fillReporting: "DISCRETE" | "CUMULATIVE";
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

## Internal order lifecycle (Slice 14A)

`src/lib/execution/lifecycle.ts` (pure) defines it; `coordinator.ts` drives an
order through it over ports. **No execution provider is connected**, and the
coordinator is not wired into the application.

```
OPEN ──► SUBMITTED ──► PARTIALLY_FILLED ──► FILLED
 │           │                │
 └──────────►┴───────────────►┴──────────► CANCELLED
```

| Phase | Meaning |
| --- | --- |
| `OPEN` | Accepted by JimoCex, funds reserved (the HOLD), not sent to a venue. |
| `SUBMITTED` | Claimed for a venue: entered *before* the venue is called, so the hand-over may still be in flight and the venue id may not be recorded yet; nothing filled. From here the venue may execute against the reservation. |
| `PARTIALLY_FILLED` | 0 < settled base < order amount. |
| `FILLED` | Settled base == order amount. Terminal. |
| `CANCELLED` | The remainder will never execute and what it still held was released. Terminal. |

Exactly eight moves are legal (`OPEN→SUBMITTED`, `OPEN→CANCELLED`,
`SUBMITTED→PARTIALLY_FILLED|FILLED|CANCELLED`,
`PARTIALLY_FILLED→PARTIALLY_FILLED|FILLED|CANCELLED`). Anything else —
`OPEN→FILLED`, `OPEN→PARTIALLY_FILLED`, `CANCELLED→OPEN`, `FILLED→OPEN`,
`FILLED→CANCELLED`, … — is refused. An internally inconsistent order record (an
`OPEN` order with fills, a `FILLED` order still holding funds) is never acted on;
it is an incident. `REJECTED`/`EXPIRED` exist in the schema and are terminal;
nothing moves an order into them yet (no primitive releases into them), so a
venue rejection or expiry ends as `CANCELLED`, releasing only the remainder.

**Provider boundary.** A venue receives identity and intent only: internal
order id, venue reference, pair, side, `LIMIT`, limit price, amount, remaining
amount. No balance, fee, reserve or ledger instruction crosses it. A venue's
answer moves no money:

- **acceptance is not a fill** — an ack, even one saying `FILLED`, settles
  nothing; fills arrive through `getFills` / `getOrder` and go to settlement;
- **a cancel the venue accepted releases nothing** — the order may still fill
  until the venue says it ended;
- **the remainder is released only** when the venue reports the order ended
  (`CANCELLED`/`REJECTED`/`EXPIRED`) *and* every fill it executed is settled
  (`decideFinalization`). If the venue executed more than is settled, those fills
  are settled first; releasing earlier would hand back money the venue spent.

**Idempotency reference.** Every request for an order carries
`venueClientOrderIdFor(internal order id)` — server-generated and globally
unique. Not the order's `client_order_id`, which is the browser's form key and
unique only per user, so two customers could present the same one to a venue.
The order is claimed (`OPEN→SUBMITTED`) *before* the venue is called; a claim
lost to a concurrent submit or the customer's cancel calls no venue.

**Failures** (all keep the reservation; none guesses):

| Case | Outcome |
| --- | --- |
| Venue rejects the submission | `REJECTED_BY_VENUE`: no fill, no trade, funds stay reserved. `reconcile` releases them only once the venue confirms it holds no order under the reference and refuses the same request again. |
| Timeout / dropped connection / duplicate / provider error | `UNRESOLVED`: neither success nor rejection is assumed. `reconcile` reads the venue by reference: found → its id is recorded; not found → resent under the **same** reference (one venue order). |
| Unknown status (ack, cancel answer or venue read) | Fails closed: nothing recorded as filled or cancelled, nothing released. |
| Duplicate submit | `ALREADY_SUBMITTED` / `CLAIM_LOST`; the venue is called once. |
| Fill reported after a cancel request | The cancel released nothing, so the fill settles normally (`FILLED` if complete); a pending cancel never overwrites it. |
| Fill reported after the order is `FILLED`/`CANCELLED` | Refused (`ORDER_NOT_SETTLEABLE`) — an incident, never a credit; a replay of an old fill is a `DUPLICATE`. |

**Cancellation after a partial fill.** `apply_fill` draws the reservation down by
exactly what each fill consumed (BUY: quote + fee; SELL: base), so what is left
locked belongs to the unfilled remainder only. Example: a 0.010 BTC BUY at
80000 reserves 801.60 USDT; a 0.003 fill at 80000 consumes 240.48; the cancel
releases the remaining 561.12 — never the 240.48 already spent. Proven in SQL
(`supabase/tests/01_invariants.sql`, "cancel after partial fill") and in the
coordinator tests.

### Database lifecycle — migration 022 (Slice 14B)

`supabase/migrations/022_submitted_lifecycle.sql` persists the lifecycle above.
**It is written and tested, and applied nowhere**: only the throwaway clusters of
`npm run test:db` have run it — not Preview, not Production. Nothing in the
application calls its functions. `execution/lifecycle-gateway.server.ts`
implements `OrderLifecycleGateway` over them, and nothing imports it (a boundary
test pins this, and also that the gateway writes no table and calls only these
three functions).

| Piece | What 022 does |
| --- | --- |
| `SUBMITTED` | `order_status` gains `SUBMITTED` (after `OPEN`). The open-order lists, the admin open-order count and the status badge include it, so reserved funds stay visible. |
| Lifecycle guard | `guard_order_status_transition` enforces the eight moves and nothing else (`23001`); `FILLED` still requires `filled_amount = amount` (`23514`). It fires on any update of `status` or `provider_order_id`. |
| Submission claim | `claim_order_for_submission(user, order)` is one conditional `UPDATE` (`OPEN→SUBMITTED`) on the owner's reserved, unfilled `LIMIT` order with no venue id. It returns the order id, or `NULL` and changes nothing. Concurrent claims queue on the row lock and each re-checks the condition against the committed row, so exactly one wins. A real two-session race in `test-db.sh` proves this: the loser waits and gets nothing, and if the winner rolls back, the waiter wins. Audited as `order.submit`. |
| Venue-id compare-and-set | `record_provider_order_id(user, order, id)` returns `RECORDED`, `ALREADY_RECORDED` (the same id again) or `CONFLICT` (another id already there, not the owner's order, not `SUBMITTED`, or the id belongs to another order). The guard enforces the same rule on its own: `provider_order_id` is set once, only onto a `SUBMITTED` order, and is never replaced or cleared. |
| Customer cancel | `cancel_order` releases only an `OPEN` order with no venue id. For `SUBMITTED` or `PARTIALLY_FILLED` it returns `false` and releases nothing. |
| Venue-confirmed release | `finalize_venue_cancellation(order, venue order id, venue status, venue final cumulative filled)` — see below. |
| `apply_fill` | Refuses (`23001`, "never submitted") unless the order is `SUBMITTED` or `PARTIALLY_FILLED` and has a venue id. Every other statement, and so the accounting, is 020's. Settlement pre-checks the same rule (`NOT_SUBMITTED`, reported as `ORDER_NOT_SETTLEABLE`). |

The three new functions are `SECURITY DEFINER` with `search_path=''`, and
executable by `service_role` only. They are in every registry: `DB_FUNCTIONS`,
`FUNCTIONS_019`, `SECURITY_DEFINER_FUNCTIONS`, the `function_calls` matrix and
`database.types.ts`.

**Submission is claim → venue once → compare-and-set.** If the claim is lost,
no venue is called. If the venue's answer is ambiguous (timeout, dropped
connection, provider error), the order stays `SUBMITTED` with no venue id, as
follows:

- nothing reverts it to `OPEN`, since the venue may hold it;
- nothing invents a venue order;
- nothing is released;
- `reconcile` reads the venue by the order's reference and records the venue id
  only through the compare-and-set.

A refused compare-and-set is an incident, never an overwrite.

**Customer cancel vs venue cancel.**

- **`OPEN`:** the order never left JimoCex, so `cancel_order` releases it at
  once. The claim and the cancel lock the same row, so only the first to commit
  takes effect.
- **`SUBMITTED` or `PARTIALLY_FILLED`:** the customer's cancel can only be a
  venue cancel request (`coordinator.requestCancel`), and it releases nothing. A
  cancel the venue merely accepted is still live, and the order can still fill.

**When the remainder is released.** `finalize_venue_cancellation` releases only
when all of these hold:

- the order is `SUBMITTED` or `PARTIALLY_FILLED`;
- the venue status is final: `CANCELLED`, `REJECTED` or `EXPIRED`;
- the confirmation names this order's venue id. Both ids may be `NULL` only if
  no venue ever acknowledged the order, and then both filled amounts must be
  zero;
- the venue's final cumulative filled base equals `filled_amount`;
- `filled_amount` equals the sum of the order's settled trades.

It then releases `locked_amount`. That is what `apply_fill` left after drawing
the reservation down for each settled fill — never the original hold, and never
a caller's figure, because the function takes no amount to release. It sets
`CANCELLED` and posts under the same `order:release:<id>` key `cancel_order`
uses, so an order is released at most once by either path.

A repeat call returns `ALREADY_FINALIZED` and changes nothing. Any mismatch
(`VENUE_ORDER_MISMATCH`, `FILLED_MISMATCH`, `NOT_SUBMITTED`, `TERMINAL`) also
changes nothing. The venue's own status goes into the `order.venue_cancel`
audit row. The stored status is `CANCELLED`, because `REJECTED` and `EXPIRED`
remain unused as stored states.

**No real provider mapping exists.** `providerStatusTable` builds a venue's
table from that venue's documented vocabulary, but the code builds no such
table outside tests. Any status not in a table is `UNKNOWN`, which moves
nothing.

**Reconciliation is mandatory.** No timer or default releases funds. An
unresolved submission or a pending cancel ends only when a reconcile reads the
venue.

**Still required before a venue is connected** (each separately authorized):

1. Apply 022. The Preview runbook's gate (`docs/preview-environment.md`,
   step 3) approves 022 by its sha256 since Slice 14C, so an empty test project
   gets it with 001–021. A test project that already has 001–021, as the
   Preview's does, gets it only through step 3b's upgrade package
   (`supabase/drafts/upgrade_021_022`), verified locally; the Preview itself
   remains at 021. After the Preview comes Production, each with its own go.
2. A real adapter for a real venue, with that venue's documented status
   vocabulary added to `status-map.ts`.
3. Wiring:
   - a server path that calls `coordinator.submit` after placement;
   - a periodic reconciliation job;
   - an Open Orders cancel that uses `requestCancel` for a submitted order. The
     button calls `cancel_order` directly, which now answers `false` for such an
     order.

## Provider status mapping

`src/lib/execution/status-map.ts`: each adapter declares one table from its
venue's raw status strings to the neutral `ExternalOrderStatus`
(`ACCEPTED, OPEN, PARTIALLY_FILLED, FILLED, CANCEL_PENDING, CANCELLED, REJECTED,
EXPIRED, UNKNOWN`). The lookup is exact; anything unlisted — a new venue status,
a typo, a non-string — is `UNKNOWN`, which fails closed (never read as `FILLED`
or `CANCELLED`). No real table exists yet: the venue's mapping is TBD and comes
from its documentation.

## Order lifecycle (Slice 5 chain)

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

- **Placement:** the browser's `client_order_id` makes placement first-wins in
  the DB (`(user_id, client_order_id)` unique). At the venue the idempotency key
  is `venueClientOrderIdFor(internal order id)` (Slice 14A) — globally unique,
  never customer-supplied.
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

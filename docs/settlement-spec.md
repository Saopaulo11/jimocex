# Settlement specification — fill accounting (Slice 6A)

Design-only. This document specifies exactly how an external execution **fill**
becomes an internal **trade** and **ledger settlement**, so that Slice 6B can
build the atomic `apply_fill` SQL function against a precise contract. **No code,
migration, or schema changes are made in 6A.** It is provider-neutral: it
invents no LP endpoint, field, fee rule or behaviour. Where the current schema
cannot safely represent something, the gap is recorded (§14), not worked around.

All amounts are `numeric(38,18)` in the database and exact `bigint` (scaled
10^18) in the application (`src/lib/money.ts`). No JavaScript float ever touches
a figure.

---

## 1. Current accounting model (as built, verified against source)

### 1.1 Tables and columns that matter

- **`trading_orders`** (005): `id, user_id, pair_id, side (BUY|SELL),
  type (LIMIT|MARKET), price, amount, filled_amount (default 0),
  remaining_amount (GENERATED = amount − filled_amount), average_price,
  status, provider_order_id (UNIQUE), client_order_id, locked_asset_id,
  locked_amount (default 0), reject_reason`.
  CHECKs: `amount > 0`, `filled_amount >= 0`, `filled_amount <= amount`,
  `price > 0 or null`, `locked_amount >= 0`, price-matches-type,
  `UNIQUE (user_id, client_order_id)`.
- **`trades`** (005): `id, pair_id, buy_order_id (nullable),
  sell_order_id (nullable), price, amount, quote_amount, fee,
  fee_asset_id (nullable), provider_trade_id (UNIQUE), settled_at, created_at`.
  CHECKs: `price > 0`, `amount > 0`, `quote_amount > 0`, `fee >= 0`,
  and `buy_order_id is not null OR sell_order_id is not null`.
  For a venue-executed trade exactly one side references our order; the other is
  NULL (the counterparty is the external venue).
- **`wallets`** (004): `user_id, asset_id, available_balance, locked_balance`,
  `UNIQUE (user_id, asset_id)`, CHECKs `available_balance >= 0` and
  `locked_balance >= 0` (the overdraft guard).
- **`ledger_entries`** (004): append-only (UPDATE/DELETE refused for every role);
  `entry_type, amount, available_delta, locked_delta, reference_type,
  reference_id, dedup_key, metadata`.

### 1.2 The one money writer: `ledger_post`

```
ledger_post(p_user_id, p_asset_id, p_entry_type, p_amount,
            p_available_delta, p_locked_delta,
            p_reference_type, p_reference_id, p_dedup_key, p_metadata)
```
`service_role` only, `SECURITY DEFINER`, `search_path=''`. It writes the ledger
entry and the wallet projection in one transaction, serialized per wallet;
refuses a negative amount, a NaN, a value past `numeric(38,18)` scale, and any
update that would drive `available_balance` or `locked_balance` below zero; and
de-duplicates on `dedup_key`. `amount` is the gross magnitude; direction lives
in the two signed deltas.

`ledger_entry_type` enum (004): `DEPOSIT, WITHDRAWAL, TRADE, TRADE_FEE, SWAP,
SWAP_FEE, FIAT_DEPOSIT, FIAT_WITHDRAWAL, HOLD, RELEASE, ADJUSTMENT`. **`TRADE`
and `TRADE_FEE` already exist** — settlement is expressible without new enum
values.

### 1.3 The three posting shapes already in use

| Shape | available_delta | locked_delta | Net wallet | Example |
| --- | --- | --- | --- | --- |
| Inflow to available | `+X` | `0` | `+X` | `DEPOSIT` |
| Reserve (internal move) | `−X` | `+X` | `0` | `HOLD` |
| Release reservation | `+X` | `−X` | `0` | `RELEASE` |
| Outflow from reservation | `0` | `−X` | `−X` | `WITHDRAWAL` |

Settlement needs exactly these shapes — nothing new. Consuming a reserved asset
to pay a venue is the **`WITHDRAWAL` shape** (`0 / −X`); crediting a received
asset is the **`DEPOSIT` shape** (`+X / 0`); refunding an over-reservation is the
**`RELEASE` shape** (`+X / −X`).

### 1.4 Placement and reservation (migration 018, built in Slice 2)

`place_limit_order` creates an `OPEN` order and posts a `HOLD` in one
transaction (`dedup_key = 'order:hold:<order_id>'`), idempotent on
`(user_id, client_order_id)`. The reserve is computed by `reserveForOrder`
(`src/lib/engines/order-rules.ts`):

- **BUY** → lock **QUOTE** = `notional + fee`, where
  `notional = multiplyMoney(price, amount, "up")` and
  `fee = computeFee(notional, rule)` (`src/lib/engines/fee-rules.ts`).
- **SELL** → lock **BASE** = `amount`. No fee reserved on the base; the fee is
  taken from the quote proceeds at settlement.

`cancel_order` releases the order's current `locked_amount`, sets `CANCELLED`
and `locked_amount = 0`, idempotently (`dedup_key = 'order:release:<order_id>'`).

### 1.5 Claim-once primitives already present

- `trades.provider_trade_id` **UNIQUE** — a venue trade id maps to at most one
  internal trade.
- `mark_trade_settled(p_trade_id)` — sets `settled_at` once, returns true to the
  single winner.
- `provider_events (provider, event_id)` UNIQUE + `claim_provider_event` — webhook
  single-winner handling.

**What does NOT exist:** any function that applies a fill end to end (insert
trade + bump `filled_amount`/`average_price` + transition status + post the
`TRADE`/`TRADE_FEE`/refund entries) atomically. `mark_trade_settled` only
*claims*; it posts nothing. This is what 6B builds. (§14 gap G1.)

---

## 2. BUY settlement

Reservation at placement (BUY): `locked QUOTE = notional_limit + fee_reserved`.
A fill reports executed `base` (quantity), `quote` (actual quote moved) and
`fee`. Per fill, with the fee charged in the **quote** asset:

| Ledger entry | asset | entry_type | available_delta | locked_delta |
| --- | --- | --- | --- | --- |
| Pay the venue | QUOTE | `TRADE` | `0` | `− quote` |
| Fee | QUOTE | `TRADE_FEE` | `0` | `− fee` |
| Receive base | BASE | `TRADE` | `+ base` | `0` |

Order row: `filled_amount += base`; `average_price = VWAP`;
`locked_amount −= (quote + fee)`; status → `PARTIALLY_FILLED` (or `FILLED` when
`filled_amount == amount`).

On the fill that **completes** the order, any residual quote still locked (price
improvement + over-reserved fee) is refunded:

| Refund leftover | QUOTE | `RELEASE` | `+ residual` | `− residual` |

so `locked_amount` ends at `0` and the FILLED invariant (`filled == amount`)
holds. See the worked example in §4.

---

## 3. SELL settlement

Reservation at placement (SELL): `locked BASE = amount`. Per fill, fee charged
in the **quote** proceeds:

| Ledger entry | asset | entry_type | available_delta | locked_delta |
| --- | --- | --- | --- | --- |
| Deliver base | BASE | `TRADE` | `0` | `− base` |
| Receive proceeds | QUOTE | `TRADE` | `+ quote` | `0` |
| Fee from proceeds | QUOTE | `TRADE_FEE` | `− fee` | `0` |

Order row: `filled_amount += base`; `average_price = VWAP`;
`locked_amount −= base`; status transition as for BUY. On full fill the locked
base is exactly consumed (`locked_amount == 0`); no base refund is needed
because the base reservation is in quantity, not value, and the seller receives
quote, not base, from price improvement. If the order is cancelled with base
still locked, `cancel_order` releases it (§ H).

---

## 4. Worked example — BUY, price improvement, two fills

Order: **BUY 1 BTC** @ limit **100,000 USDT**, TRADE fee **0.20%** (seed), fee in
quote.

**Placement.** `notional_limit = 100,000 × 1 = 100,000`;
`fee_reserved = 0.20% × 100,000 = 200`; **HOLD QUOTE 100,200**
(available −100,200 / locked +100,200). `locked_amount = 100,200`.

**Fill #1 — 0.25 BTC @ 99,500** → `quote = 24,875`, `fee = 0.20% × 24,875 =
49.75`:
- QUOTE `TRADE` locked −24,875; QUOTE `TRADE_FEE` locked −49.75; BASE `TRADE`
  available +0.25.
- `filled_amount = 0.25`, `average_price = 99,500`, status `PARTIALLY_FILLED`,
  `locked_amount = 100,200 − 24,875 − 49.75 = 75,275.25`.

**Fill #2 — 0.75 BTC @ 99,500** → `quote = 74,625`, `fee = 149.25`:
- QUOTE `TRADE` locked −74,625; QUOTE `TRADE_FEE` locked −149.25; BASE `TRADE`
  available +0.75.
- `filled_amount = 1.0 == amount` → this fill completes the order.
- Residual locked = `75,275.25 − 74,625 − 149.25 = 501.00`.
- QUOTE `RELEASE` available +501 / locked −501 (price-improvement + fee refund:
  reserved 100,200 vs actual 99,500 cost + 199 fee = 99,699; refund 501 ✓).
- `locked_amount = 0`, status `FILLED`.

Customer net: −99,500 QUOTE (cost) −199 QUOTE (fee) +1 BTC; every QUOTE figure
traces to a ledger entry; the wallet's available QUOTE returns to
`start − 99,699`.

---

## 5. Multiple fills (cumulative accounting)

For one internal order with fills #1..#n:
- `filled_amount` increases **monotonically** by each fill's `base`;
  `apply_fill` must enforce `old.filled_amount + base <= amount` (never
  over-fill) and reject a fill that would exceed it.
- `average_price` is the volume-weighted mean:
  `Σ(base_i × price_i) / Σ(base_i)` (computed in exact `Money`, rounding defined
  in §8), stored on completion of each fill.
- `locked_amount` is drawn down per fill; the completing fill releases any
  residual (BUY) or leaves `0` (SELL).
- Each fill is its own `trades` row keyed by `provider_trade_id`; each posts its
  own `TRADE`/`TRADE_FEE` entries with per-fill `dedup_key`s.

If a venue reports a **cumulative filled snapshot** rather than discrete fills
with ids, `apply_fill` (which is keyed per fill) does not apply directly — the
adapter must derive per-fill deltas, or a snapshot-reconciliation path is needed.
This depends on the real venue's report shape (§14 gap G6).

---

## 6. Price improvement

**BUY:** limit price ≥ execution price. Quote initially reserved uses the
**limit** price (`notional_limit + fee_reserved`); quote actually consumed uses
the **execution** quote reported by the venue (`trades.quote_amount`), which is
authoritative. The difference, plus any fee over-reservation, is **released**
back to available on completion (or on cancel of the remainder). The customer is
charged exactly what executed, never the limit.

**SELL:** execution price ≥ limit price. The base reserved is a **quantity**
(`amount`), unaffected by price; price improvement means **more quote proceeds**,
credited to available. No base refund arises; the base hold is consumed exactly.

Authoritative figures: **`base` and `quote` as reported by the venue are
authoritative** (what actually moved). `execution_price` is derived
(`quote / base`) and used for `average_price`/display, not to recompute `quote`.
`apply_fill` validates consistency (§8) but never recomputes `quote` from
`price × base` with its own rounding.

---

## 7. Fees

### 7.1 What the core can represent today
- `trades.fee` (`numeric(38,18)`) + `trades.fee_asset_id` (nullable FK to
  `assets`) — a **per-trade fee in a named asset**. This is sufficient to record
  a fee in the quote asset, the base asset, or a third asset.
- `ledger_entry_type.TRADE_FEE` — a dedicated fee posting.
- `fee_rules` (008) + FeeEngine (`fee-rules.ts`): `percentage` (numeric(10,6)),
  `fixed_fee`, `min_fee`, `max_fee`, resolved most-specific by
  `(operation, asset_id, tier_code)`; `computeFee = clamp(percentageOf(base,pct,up)
  + fixed, min, max)` floored at zero.

### 7.2 Where fee is calculated / reserved / charged today
- **Calculated**: server-side in `computeFee` on the order **notional at the
  limit price** (`src/lib/engines/order-engine.ts` → `computePlacement`).
- **Reserved**: for a **BUY**, folded into the QUOTE hold (`notional + fee`); for
  a **SELL**, **not** reserved (it is taken from quote proceeds).
- **Charged**: **nowhere yet** — no fill settles today, so no `TRADE_FEE` has
  ever been posted. This is new in 6B.

### 7.3 Behaviour under partial fill / price improvement / multiple fills
- **Partial fill**: the fee charged should be proportional to the **executed**
  amount, not the full order — i.e. computed on each fill's executed quote, so
  partial fills accrue partial fees.
- **Price improvement (BUY)**: the fee is on the **actual** executed quote
  (lower than the limit notional), so the fee charged is ≤ the fee reserved; the
  difference is released with the price-improvement refund.
- **Multiple fills**: fees accrue per fill; `min_fee`/`max_fee` clamping across
  fills is ambiguous (per-fill vs per-order) — see the decision below.

### 7.4 The fee decision 6B must make (provider-neutral; needs real LP semantics)
The fee the customer is charged at settlement can be sourced three ways:
1. **Venue pass-through** — charge exactly `trades.fee` as the venue reports it.
2. **Internal recompute** — ignore the venue fee; charge the FeeEngine fee on the
   executed quote.
3. **Pass-through + markup** — venue fee plus a platform margin.

6A does **not** pick one: it is a business-policy decision that also depends on
the real venue's fee model (maker/taker, fee asset, whether fee is already
netted into the reported `quote`). `apply_fill` takes the fee **as an input**
(`p_fee_amount`, `p_fee_asset_id`) so the policy lives in the settlement service
above it; the DB function records and posts whatever fee it is given, and
validates it against the reservation. The `min_fee`/`max_fee` clamping scope
(per-order vs per-fill) is part of the same decision.

### 7.5 Fee-asset gap (important)
The BUY reservation reserves the fee in **QUOTE**. If a venue charges the fee in
the **base** asset or a **third** asset (a fee token), the quote reservation does
not cover it, and the fee posting would have to draw from an unreserved balance.
For the MVP, 6B should either **constrain supported pairs/venues to
quote-denominated fees** (a documented limitation) or extend the reservation to
cover the fee asset. This cannot be resolved without the real venue's fee model.
(§14 gap G2.)

---

## 8. Rounding / precision

- **Scales**: `Money` = bigint × 10^18 = `numeric(38,18)`. `assets.decimals` is
  display precision; `trading_pairs.price_precision` / `amount_precision` bound
  input; `fee_rules.percentage` is `numeric(10,6)`.
- **Provider → internal**: an adapter parses every upstream figure with
  `parseJsonExact()` / `asDecimalString()` → `DecimalString` → `numeric`. **No
  `JSON.parse` into a number, ever.**
- **Internal math**: exact `bigint` via `@/lib/money` (`multiplyMoney`,
  `percentageOf`, `addMoney`, `subtractMoney`); `multiplyMoney`/`percentageOf`
  round **up** by default (the platform never under-charges itself or the hold
  by a rounding step).
- **Authoritative fill figures**: `base` and `quote` come from the venue and are
  stored as-is; `execution_price` and `average_price` are derived
  (`quote / base`, VWAP) rounding to `price_precision` for display — never used
  to recompute `quote`.
- **Consistency check** (not a recompute): reject a fill where `quote` and
  `price × base` diverge beyond a tolerance of one unit at the pair's price
  precision — a malformed report, not a rounding artefact.
- **Residual / dust**: the BUY completion refund is `reserved − Σ(quote) −
  Σ(fee)`; because consumption rounds up and the reserve rounded up at placement,
  the residual is `≥ 0` and is released in full — no locked dust is left on a
  completed order (`locked_amount` must end exactly `0`).
- **Zero-after-rounding**: a fill whose `base` or `quote` rounds to zero at the
  stored scale is rejected (`trades` CHECKs require `amount > 0`,
  `quote_amount > 0`).
- **Minimum fill**: not currently modelled; a venue minimum-fill rule is a venue
  concern and is not invented here.

---

## 9. Idempotency

**Authoritative dedupe identifier for a FILL: `trades.provider_trade_id`
(UNIQUE).** `apply_fill` must `INSERT INTO trades (...) ON CONFLICT
(provider_trade_id) DO NOTHING`; if zero rows were inserted, the fill is already
applied → the function is a no-op and posts no ledger entries. The ledger
`dedup_key`s (`'trade:fill:<trade_id>'`, `'trade:fee:<trade_id>'`,
`'trade:refund:<order_id>'`) are a second guard.

| Scenario | Handling |
| --- | --- |
| 1. Same fill once | Trade inserted; entries posted once. |
| 2. Same fill twice | 2nd insert hits `provider_trade_id` UNIQUE → DO NOTHING → no second settlement. |
| 3. Same provider event twice | `provider_events(provider,event_id)` UNIQUE + `claim_provider_event` → only one handler runs. |
| 4. Webhook + polling return the same fill | Both carry the same `provider_trade_id` → whichever lands first settles; the other no-ops. |
| 5. Two different fills, same order | Two `provider_trade_id`s → two trade rows, cumulative `filled_amount`. |
| 6. Venue re-sends the order with a higher cumulative filled | Not a per-fill event; `apply_fill` cannot key it on `provider_trade_id`. Must be reconciled against already-applied fills (derive the delta) — see §14 G6. |

**No double ledger settlement**: guaranteed by the `provider_trade_id` UNIQUE
insert *and* the ledger `dedup_key`, both inside the one `apply_fill`
transaction.

---

## 10. Failure / recovery

| Case | Strategy |
| --- | --- |
| A. Trade inserted, ledger posting fails | Same transaction → the whole `apply_fill` rolls back (no trade row, no entries). Retry re-applies cleanly. **Atomicity is the recovery.** |
| B. Ledger succeeds, process crashes before responding | The transaction committed; the fill is applied. A retry hits `provider_trade_id` UNIQUE → no-op. Safe. |
| C. Provider event arrives twice | `claim_provider_event` + `provider_trade_id` → second is a no-op. |
| D. Fill arrives before the placement HTTP response returns | The internal order exists (placement committed before the response); `apply_fill` looks the order up by `provider_order_id`/`client_order_id`. If the order row is not yet visible, the event is retried/queued — never settle against a missing order. |
| E. Provider says FILLED but the fills endpoint is temporarily down | Do not settle on the status alone — settlement requires per-fill figures. Mark for reconciliation and retry `getFills`; the order stays in its last ledger-backed state. |
| F. Internal OPEN but provider FILLED | Reconciliation fetches the fills and applies them idempotently; internal state catches up. The ledger, not the status flag, is the truth. |
| G. Internal FILLED but provider sends another fill | `filled_amount == amount` already; `apply_fill` must **reject** a fill that would push `filled_amount > amount` (over-fill) and surface it as a reconciliation incident — never silently credit beyond the order. |

None of this recovery is implemented in 6A.

---

## 11. Reconciliation boundary

- **Provider truth**: external order state, external fills, external fees. Lives
  behind the `server-only` adapter and the `ExecutionService` (Slice 5).
- **Internal truth**: customer balances, holds, the append-only ledger, settled
  trades, internal order state. The **ledger is the source of truth.**
- **Invariants:**
  1. An external fill **never** mutates a customer balance directly; it only
     ever moves money through `apply_fill` → `ledger_post`.
  2. A fill is validated against the internal order (ownership, pair, side,
     remaining amount, reservation) before any posting.
  3. A duplicate external event cannot produce a second ledger posting
     (`provider_trade_id` UNIQUE + `dedup_key`).
  4. Every settlement is auditable: a `trades` row + `ledger_entries` that sum to
     the wallet deltas, re-checkable by `reconcile_wallets()`.
  5. The reconciliation invariant (`wallet balance == Σ ledger deltas`) holds
     after every `apply_fill`.

---

## 12. Proposed `apply_fill` contract (no SQL in 6A)

Derived from the existing schema; every figure already has a home.

```
apply_fill(
  p_order_id          uuid,      -- internal order; found via provider_order_id/client_order_id upstream
  p_provider_trade_id text,      -- venue trade id — THE idempotency key (→ trades.provider_trade_id)
  p_base_amount       numeric,   -- base filled this fill (→ trades.amount)
  p_quote_amount      numeric,   -- quote moved this fill, venue-authoritative (→ trades.quote_amount)
  p_execution_price   numeric,   -- derived quote/base (→ trades.price); validated, not used to recompute quote
  p_fee_amount        numeric,   -- fee charged this fill (→ trades.fee); policy decided above apply_fill
  p_fee_asset_id      uuid,      -- → trades.fee_asset_id
  p_executed_at       timestamptz
) returns uuid  -- the trade id (existing trade id on a duplicate, with no new postings)
```

| Param | Type | Source | Validation | Client-controlled? | Idempotency role |
| --- | --- | --- | --- | --- | --- |
| `p_order_id` | uuid | internal (resolved from `provider_order_id`) | order exists, non-terminal, is the fill's order | **No** | — |
| `p_provider_trade_id` | text | venue fill | non-empty | **No** | **authoritative dedupe** |
| `p_base_amount` | numeric | venue fill | `> 0`; `filled_amount + base <= amount` | **No** | — |
| `p_quote_amount` | numeric | venue fill | `> 0`; consistent with `price × base` (§8) | **No** | — |
| `p_execution_price` | numeric | derived | `> 0`; within pair price precision | **No** | — |
| `p_fee_amount` | numeric | settlement policy | `>= 0`; covered by reservation / fee asset | **No** | — |
| `p_fee_asset_id` | uuid | settlement policy | FK `assets`; see §7.5 | **No** | — |
| `p_executed_at` | timestamptz | venue fill | — | **No** | — |

Every parameter is **server-established** from the provider adapter + settlement
policy; **none** is accepted from a browser. `apply_fill` is `service_role`-only,
`SECURITY DEFINER`, `search_path=''`, like every money mover. It must, in one
transaction: resolve + lock the order row `FOR UPDATE`; insert the trade
`ON CONFLICT (provider_trade_id) DO NOTHING` (no-op return on conflict); validate
against the order; post the `TRADE` / `TRADE_FEE` / refund entries via
`ledger_post`; bump `filled_amount`, `average_price`, draw down `locked_amount`;
transition status; write an `audit_logs` row.

---

## 13. State machine

```
            apply_fill (partial)        apply_fill (completes)
   OPEN ───────────────────────► PARTIALLY_FILLED ───────────────► FILLED
     │                                   │
     │ cancel_order                      │ cancel_order (release remaining base/quote)
     ▼                                   ▼
  CANCELLED                          CANCELLED
```

- `OPEN → PARTIALLY_FILLED → FILLED`, `OPEN → CANCELLED`,
  `PARTIALLY_FILLED → CANCELLED` are all permitted.
- **`guard_order_status_transition` (005) today**: freezes terminal states
  (`FILLED/CANCELLED/REJECTED/EXPIRED` cannot change — so **cancel-after-full-fill
  is already a hard no-op**, §I), and enforces `FILLED ⇒ filled_amount == amount`.
- **Sufficient as a backstop? Partly.** It does NOT enforce: fill monotonicity
  (`filled_amount` only increases), that a `filled_amount` change is backed by a
  `trades` row, or that `locked_amount` is drawn down consistently. Those
  invariants must be owned by `apply_fill`'s own logic; optionally 6B adds a
  CHECK/trigger. (§14 gap G3.) **6A changes no SQL.**

### Cancel scenarios
- **H. Cancel after partial fill**: settled base/quote stays; `cancel_order`
  releases the current `locked_amount` (remaining reserved QUOTE for a BUY, or
  remaining locked BASE for a SELL) back to available, sets `locked_amount = 0`,
  status `CANCELLED`. Already supported.
- **I. Cancel after full fill**: order is terminal `FILLED`; the guard rejects
  the transition and `cancel_order` returns `false` → safe no-op. Already
  enforced.

---

## 14. Known schema gaps

- **G1 — No `apply_fill`.** The atomic insert-trade + post-ledger + update-order
  function does not exist. 6B builds it. `mark_trade_settled` only claims.
- **G2 — Fee-asset vs reservation asset.** BUY reserves the fee in QUOTE; a
  venue fee in base or a fee token is not covered. 6B must constrain to
  quote-denominated fees (documented limit) or extend the reservation. Needs the
  real venue fee model.
- **G3 — Status guard is a partial backstop.** It freezes terminals and checks
  the FILLED total, but does not enforce fill monotonicity, trade-backing, or
  reservation drawdown; `apply_fill` must enforce them (and 6B may strengthen the
  trigger / add a CHECK).
- **G4 — Fee policy undefined.** Pass-through vs internal-recompute vs markup, and
  `min/max` clamping scope — a business decision, provider-dependent (§7.4).
- **G5 — Registry wiring.** A new `apply_fill` must be added to
  `src/lib/db/money-columns.ts` `DB_FUNCTIONS` (money args), `scripts/privilege-
  registry.ts` (service_role + SECURITY DEFINER), `supabase/tests/01_invariants.sql`
  (`function_calls` fixture + behavioural assertions), and
  `src/lib/supabase/database.types.ts` Functions — the same wiring `place_limit_
  order` has.
- **G6 — Cumulative-snapshot venues.** A venue that reports a cumulative filled
  amount instead of discrete fills with ids cannot be keyed on
  `provider_trade_id`; needs a derive-delta/reconcile path. Depends on real LP
  report shape — not invented here.
- **G7 — `average_price` write.** The column exists; `apply_fill` computes VWAP in
  exact `Money`. No schema change; noted so 6B defines the rounding (§8).

---

## 15. Invariants Slice 6B must enforce

1. **One settlement per fill** — `apply_fill` idempotent on `provider_trade_id`;
   a duplicate posts nothing.
2. **Atomicity** — trade row, ledger entries and order update commit together or
   not at all.
3. **No over-fill** — reject any fill where `filled_amount + base > amount`.
4. **No overdraft** — all asset movement via `ledger_post`; `locked`/`available`
   never negative (DB-enforced); a BUY never consumes more quote than reserved.
5. **Exact residual release** — a completed BUY releases
   `reserved − Σquote − Σfee` so `locked_amount` ends exactly `0`; a completed
   SELL leaves `locked_amount == 0`.
6. **FILLED ⇔ filled_amount == amount** (already DB-enforced; keep it true).
7. **Reconciliation holds** — `reconcile_wallets()` returns empty after every
   `apply_fill`; `wallet == Σ ledger deltas`.
8. **Server-only settlement** — `apply_fill` is `service_role`-only; no client
   path, no client-supplied fill/price/fee/trade-id; provider figures enter only
   through the `server-only` adapter → settlement service → `apply_fill`.
9. **Venue response is never truth** — a fill is validated against the internal
   order and reservation before any posting; the ledger remains the source of
   truth and fully auditable.
10. **No MARKET, no fabricated fill** — settlement applies only real,
    provider-reported fills; nothing is invented when no venue is connected.

---

## Security (Slice-6A review of the settlement path)

- A client **cannot** submit a fill, a `provider_trade_id`, an execution price, or
  a fee: `apply_fill` is `service_role`-only and every parameter is
  server-established (the browser reaches nothing here).
- The provider adapter is `server-only` (Slice 5); settlement runs on the
  internal service-role path only.
- RLS is not bypassed from the client: `trading_orders`/`trades` writes are
  revoked from `anon`/`authenticated`; only `ledger_post`/`apply_fill` (service
  role) move money, atomically.
- Fees, reserves and user identity remain server-established (unchanged from
  Slices 2b/3).

---

*Provider-neutral. No LP-specific behaviour is assumed; where the real venue's
fill/fee semantics are required to decide (fee source, fee asset, cumulative vs
discrete fills), it is recorded as a gap, not invented. No code, migration, DB,
hosted Supabase or migration-gate change is made in Slice 6A.*

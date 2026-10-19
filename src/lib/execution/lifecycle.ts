import { compareMoney, isNegative, isPositive, isZero, type Money } from "../money.ts";
import type { ExternalOrderStatus, OrderSide, OrderStatus, OrderType } from "./types.ts";

/**
 * Internal order lifecycle (Slice 14A) — pure, no I/O.
 *
 *     OPEN ──► SUBMITTED ──► PARTIALLY_FILLED ──► FILLED
 *      │           │                │
 *      └──────────►┴───────────────►┴──────────► CANCELLED
 *
 *   OPEN              accepted by JimoCex, funds reserved (the HOLD), not yet
 *                     sent to an execution venue;
 *   SUBMITTED         an execution request exists at the venue under the
 *                     order's venue reference; nothing has filled;
 *   PARTIALLY_FILLED  0 < settled base < order amount;
 *   FILLED            settled base == order amount (terminal);
 *   CANCELLED         the unfilled remainder will never execute and what is
 *                     still reserved for it was released (terminal).
 *
 * REJECTED and EXPIRED are statuses the schema already has; they are terminal
 * here and nothing in this slice moves an order into them (no primitive releases
 * a reservation into either yet — a venue rejection or expiry ends as CANCELLED,
 * releasing only the remainder).
 *
 * Every phase change happens inside a financial primitive (`apply_fill` moves a
 * submitted order to PARTIALLY_FILLED/FILLED; the release primitive to
 * CANCELLED). This module decides whether a change is legal and what a venue's
 * report means; it moves no money and writes nothing. Illegal input fails
 * closed: nothing is repaired, nothing is guessed.
 *
 * STORAGE (migration 022, written but applied nowhere yet): `order_status` has
 * SUBMITTED; `guard_order_status_transition` enforces this table in the
 * database; `claim_order_for_submission`, `record_provider_order_id` and
 * `finalize_venue_cancellation` are the only writes that move an order into
 * and out of SUBMITTED; `cancel_order` releases only an OPEN order; `apply_fill`
 * refuses an order never submitted. Nothing in the application submits an order.
 */

export type OrderPhase = "OPEN" | "SUBMITTED" | "PARTIALLY_FILLED" | "FILLED" | "CANCELLED" | "REJECTED" | "EXPIRED";

export const TERMINAL_PHASES: readonly OrderPhase[] = ["FILLED", "CANCELLED", "REJECTED", "EXPIRED"];

export function isTerminalPhase(phase: OrderPhase): boolean {
  return TERMINAL_PHASES.includes(phase);
}

/** The only legal moves. Anything absent — OPEN → FILLED, CANCELLED → OPEN, FILLED → CANCELLED — is refused. */
const LEGAL_TRANSITIONS: Readonly<Record<OrderPhase, readonly OrderPhase[]>> = {
  OPEN: ["SUBMITTED", "CANCELLED"],
  SUBMITTED: ["PARTIALLY_FILLED", "FILLED", "CANCELLED"],
  PARTIALLY_FILLED: ["PARTIALLY_FILLED", "FILLED", "CANCELLED"],
  FILLED: [],
  CANCELLED: [],
  REJECTED: [],
  EXPIRED: [],
};

export function canTransition(from: OrderPhase, to: OrderPhase): boolean {
  return LEGAL_TRANSITIONS[from].includes(to);
}

export type TransitionCheck = { ok: true } | { ok: false; reason: string };

export function checkTransition(from: OrderPhase, to: OrderPhase): TransitionCheck {
  return canTransition(from, to) ? { ok: true } : { ok: false, reason: `${from} → ${to} is not a legal order transition` };
}

/** A stored status as a phase. PENDING is unused by this lifecycle and maps to nothing (fail closed). */
export function phaseFromStatus(status: OrderStatus): OrderPhase | null {
  switch (status) {
    case "OPEN":
    case "SUBMITTED":
    case "PARTIALLY_FILLED":
    case "FILLED":
    case "CANCELLED":
    case "REJECTED":
    case "EXPIRED":
      return status;
    case "PENDING":
      return null;
  }
}

/** What the lifecycle needs to know about an order, read from persisted state. */
export type OrderRecord = {
  orderId: string;
  /** The order's owner; the submission claim and the venue-id record verify it. */
  userId: string;
  /** Canonical pair symbol, e.g. "BTC-USDT". */
  pair: string;
  side: OrderSide;
  type: OrderType;
  phase: OrderPhase;
  /** The customer's limit price; null only for MARKET, which never reaches a venue. */
  price: Money | null;
  amount: Money;
  /** Base settled so far (trading_orders.filled_amount). */
  filledAmount: Money;
  /** What the order still holds (trading_orders.locked_amount). */
  lockedAmount: Money;
  /** The venue's order id once the venue acknowledged the submission. */
  externalOrderId: string | null;
};

/**
 * Whether a persisted order is internally consistent for its phase. A record
 * that is not is never acted on — it is an incident, not a state to repair.
 */
export function checkOrderRecord(order: OrderRecord): { ok: true } | { ok: false; problem: string } {
  const bad = (problem: string) => ({ ok: false as const, problem });
  if (!isPositive(order.amount)) return bad("order amount is not positive");
  if (isNegative(order.filledAmount)) return bad("filled amount is negative");
  if (isNegative(order.lockedAmount)) return bad("locked amount is negative");
  const filledVsAmount = compareMoney(order.filledAmount, order.amount);
  if (filledVsAmount > 0) return bad("filled amount exceeds the order amount");
  if (order.type === "LIMIT" && (order.price === null || !isPositive(order.price))) return bad("a LIMIT order has no positive price");

  switch (order.phase) {
    case "OPEN":
      if (!isZero(order.filledAmount)) return bad("an OPEN order has fills");
      if (order.externalOrderId !== null) return bad("an OPEN order carries a venue order id");
      return { ok: true };
    case "SUBMITTED":
      if (!isZero(order.filledAmount)) return bad("a SUBMITTED order has fills");
      return { ok: true };
    case "PARTIALLY_FILLED":
      if (isZero(order.filledAmount) || filledVsAmount === 0) return bad("PARTIALLY_FILLED needs 0 < filled < amount");
      if (order.externalOrderId === null) return bad("a filled order has no venue order id");
      return { ok: true };
    case "FILLED":
      if (filledVsAmount !== 0) return bad("FILLED needs filled == amount");
      if (!isZero(order.lockedAmount)) return bad("a FILLED order still holds funds");
      return { ok: true };
    case "CANCELLED":
    case "REJECTED":
    case "EXPIRED":
      if (!isZero(order.lockedAmount)) return bad(`a ${order.phase} order still holds funds`);
      return { ok: true };
  }
}

/**
 * The phase an order moves to once `filledAfter` base is settled. Fails closed on
 * an over-fill, a non-positive total, or a move the table refuses — a fill on an
 * OPEN order (never sent to a venue) or on a terminal one.
 */
export function phaseAfterFill(
  from: OrderPhase,
  filledAfter: Money,
  amount: Money,
): { ok: true; phase: OrderPhase } | { ok: false; reason: string } {
  if (!isPositive(filledAfter)) return { ok: false, reason: "a fill must leave a positive filled amount" };
  const vsAmount = compareMoney(filledAfter, amount);
  if (vsAmount > 0) return { ok: false, reason: "the fill would exceed the order amount" };
  const to: OrderPhase = vsAmount === 0 ? "FILLED" : "PARTIALLY_FILLED";
  const check = checkTransition(from, to);
  return check.ok ? { ok: true, phase: to } : check;
}

/**
 * What a venue's status means for the money still reserved:
 *   LIVE    the venue may still execute (incl. a cancel it has not confirmed);
 *   FILLED  the venue executed the whole order;
 *   ENDED   the unfilled remainder can no longer execute (cancelled, rejected, expired);
 *   UNKNOWN nothing may change — reconcile.
 */
export type VenueStatusClass = "LIVE" | "FILLED" | "ENDED" | "UNKNOWN";

export function classifyVenueStatus(status: ExternalOrderStatus): VenueStatusClass {
  switch (status) {
    case "ACCEPTED":
    case "OPEN":
    case "PARTIALLY_FILLED":
    case "CANCEL_PENDING":
      return "LIVE";
    case "FILLED":
      return "FILLED";
    case "CANCELLED":
    case "REJECTED":
    case "EXPIRED":
      return "ENDED";
    case "UNKNOWN":
      return "UNKNOWN";
  }
}

export type FinalizationDecision =
  /** Venue ended and every venue fill is settled: release what the order still holds, nothing more. */
  | { kind: "RELEASE_REMAINDER" }
  /** The venue executed more than is settled: settle those fills first; release nothing. */
  | { kind: "SETTLE_MISSING_FILLS" }
  /** The venue may still execute: release nothing. */
  | { kind: "NOT_ENDED" }
  /** Venue and internal state both say FILLED: settlement already released any residual. */
  | { kind: "NOTHING_TO_RELEASE" }
  | { kind: "ALREADY_TERMINAL" }
  /** The venue's status is not known: release nothing, reconcile. */
  | { kind: "UNRESOLVED" }
  | { kind: "INCIDENT"; reason: string };

/**
 * Whether an order's remaining reservation may be released, from the venue's
 * final word and the internally SETTLED amount. A cancel request the venue merely
 * accepted releases nothing; only an ended venue order whose every fill is
 * settled does — and then only what is still reserved, which `apply_fill` has
 * already drawn down for every settled fill. Releasing before the missing fills
 * are settled would hand back money the venue already spent.
 */
export function decideFinalization(input: {
  phase: OrderPhase;
  amount: Money;
  internalFilled: Money;
  venueStatus: ExternalOrderStatus;
  venueFilled: Money;
}): FinalizationDecision {
  if (isTerminalPhase(input.phase)) return { kind: "ALREADY_TERMINAL" };
  if (input.phase === "OPEN") return { kind: "INCIDENT", reason: "an order never sent to a venue has no venue state" };
  if (isNegative(input.venueFilled) || compareMoney(input.venueFilled, input.amount) > 0) {
    return { kind: "INCIDENT", reason: "the venue reports a filled amount outside the order" };
  }

  const venueClass = classifyVenueStatus(input.venueStatus);
  if (venueClass === "UNKNOWN") return { kind: "UNRESOLVED" };
  if (venueClass === "LIVE") return { kind: "NOT_ENDED" };
  if (venueClass === "FILLED" && compareMoney(input.venueFilled, input.amount) !== 0) {
    return { kind: "INCIDENT", reason: "the venue reports FILLED for less than the order amount" };
  }

  const settledVsVenue = compareMoney(input.internalFilled, input.venueFilled);
  if (settledVsVenue > 0) return { kind: "INCIDENT", reason: "more is settled internally than the venue executed" };
  if (settledVsVenue < 0) return { kind: "SETTLE_MISSING_FILLS" };
  return venueClass === "FILLED" ? { kind: "NOTHING_TO_RELEASE" } : { kind: "RELEASE_REMAINDER" };
}

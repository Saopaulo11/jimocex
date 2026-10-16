import { ZERO, isNegative, parseMoney, subtractMoney, type Money } from "../money.ts";
import type { ExecutionFill, ExternalOrderStatus, OrderSide, OrderStatus } from "../execution/types.ts";

/**
 * Settlement service contracts — provider-neutral, pure, no I/O (Slice 6C).
 *
 * This layer turns a validated `ExecutionFill` (Slice 5) into a call to the
 * atomic SQL `apply_fill` (migration 020, Slice 6B). The SQL function is the
 * ONLY financial boundary: it inserts the trade, posts the ledger entries and
 * updates the order in one transaction. Nothing here moves money; this is the
 * mapping, the error taxonomy and the reconciliation decisions, kept pure so
 * they are unit-testable with a deterministic gateway double. The server wiring
 * (`service.server.ts`) is the only part that touches the service-role client.
 *
 * TRUST: a provider response is NOT financial truth. The internal order is
 * resolved server-side from the venue's external order id — never from a client
 * value — and every fill is validated before `apply_fill`, which revalidates
 * again and is the atomic, idempotent authority.
 *
 * The money import is relative because these modules are unit-tested with
 * `node --test`, which does not resolve `@/`. The execution and enum imports are
 * type-only and erased at build.
 */

/** What `apply_fill` needs, with money as exact `Money` (serialised by moneyArgs). */
export type ApplyFillInput = {
  orderId: string;
  providerTradeId: string;
  baseAmount: Money;
  /** Venue-authoritative executed quote — never `price × base`. */
  quoteAmount: Money;
  executionPrice: Money;
  feeAmount: Money;
  /** null when the fee is zero. */
  feeAssetId: string | null;
  executedAt: Date;
};

export type SettlementFailureCode =
  | "INVALID_FILL"
  | "ORDER_NOT_FOUND"
  | "ORDER_NOT_SETTLEABLE"
  | "OVER_FILL"
  | "INSUFFICIENT_RESERVATION"
  | "INVALID_FEE"
  | "INVALID_PRECISION"
  | "DATABASE_ERROR"
  | "UNKNOWN";

export type SettlementFailure = {
  code: SettlementFailureCode;
  message: string;
  /** Safe to retry the same call (transient)? */
  retryable: boolean;
  /** Needs a reconciliation / incident follow-up (a provider/internal inconsistency)? */
  reconcile: boolean;
};

export type SettlementResult =
  | { code: "SUCCESS"; tradeId: string }
  | { code: "DUPLICATE"; tradeId: string }
  | SettlementFailure;

/**
 * The outside world the settlement service needs, as a port. The real adapter
 * (`service.server.ts`) implements it over the service-role client; tests
 * implement it as a deterministic double. Order identity is resolved HERE from
 * the venue's external order id — the service never accepts an internal order id
 * as input, so a caller cannot settle against an arbitrary order.
 */
export interface SettlementGateway {
  resolveOrderByExternalId(externalOrderId: string): Promise<{ orderId: string; side: OrderSide } | null>;
  resolveAssetId(symbol: string): Promise<string | null>;
  findTradeByProviderTradeId(providerTradeId: string): Promise<string | null>;
  /** Calls apply_fill. Returns the trade id, or the raw SQL error shape — never throws for a SQL error. */
  applyFill(
    input: ApplyFillInput,
  ): Promise<{ ok: true; tradeId: string } | { ok: false; code?: string | null; message?: string | null }>;
}

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

/**
 * Maps a venue fill to `apply_fill` inputs. The internal order id and the fee
 * asset id are resolved server-side and passed in — this function only parses
 * the exact decimals. The quote comes straight from the venue's `quoteAmount`;
 * it is never recomputed from `price × amount`.
 */
export function mapExecutionFillToApplyFill(
  fill: ExecutionFill,
  resolved: { orderId: string; feeAssetId: string | null },
): ApplyFillInput {
  return {
    orderId: resolved.orderId,
    providerTradeId: fill.externalFillId,
    baseAmount: parseMoney(fill.amount),
    quoteAmount: parseMoney(fill.quoteAmount),
    executionPrice: parseMoney(fill.price),
    feeAmount: parseMoney(fill.fee),
    feeAssetId: resolved.feeAssetId,
    executedAt: fill.executedAt,
  };
}

// ---------------------------------------------------------------------------
// Error taxonomy
// ---------------------------------------------------------------------------

const MESSAGES: Record<SettlementFailureCode, string> = {
  INVALID_FILL: "The execution report is not a valid fill for this order.",
  ORDER_NOT_FOUND: "No internal order matches this execution.",
  ORDER_NOT_SETTLEABLE: "This order can no longer take a fill.",
  OVER_FILL: "This fill would exceed the order's size.",
  INSUFFICIENT_RESERVATION: "This fill exceeds the funds reserved for the order.",
  INVALID_FEE: "The fill's fee is not valid for this market.",
  INVALID_PRECISION: "The fill's amounts are inconsistent.",
  DATABASE_ERROR: "Settlement could not be completed. Please retry.",
  UNKNOWN: "Settlement failed for an unexpected reason.",
};

function failure(code: SettlementFailureCode, retryable: boolean, reconcile: boolean): SettlementFailure {
  return { code, message: MESSAGES[code], retryable, reconcile };
}

/**
 * Classifies a raw `apply_fill` SQL error into a bounded, safe failure. The raw
 * PostgreSQL message is NEVER propagated — only a code and a generic message.
 * SQLSTATEs come from migration 020: 23503 unknown order, 23001 terminal order,
 * 23514 the validation CHECKs (sub-classified by message); transient classes
 * (serialization/deadlock/connection) are retryable.
 */
export function classifyApplyFillError(error: { code?: string | null; message?: string | null }): SettlementFailure {
  const sqlstate = (error.code ?? "").trim();
  const raw = error.message ?? "";

  if (sqlstate === "23503") return failure("ORDER_NOT_FOUND", false, true);
  if (sqlstate === "23001") return failure("ORDER_NOT_SETTLEABLE", false, true);
  if (sqlstate === "23514") {
    if (/exceeds order/.test(raw)) return failure("OVER_FILL", false, true);
    if (/quote asset|fee must be a non-negative|fee .* exceeds the quote proceeds/.test(raw))
      return failure("INVALID_FEE", false, false);
    if (/is reserved|only .* is reserved/.test(raw)) return failure("INSUFFICIENT_RESERVATION", false, true);
    if (/inconsistent with price/.test(raw)) return failure("INVALID_PRECISION", false, false);
    return failure("INVALID_FILL", false, false);
  }
  // Transient: serialization failure, deadlock, connection/resource classes.
  if (sqlstate === "40001" || sqlstate === "40P01" || sqlstate.startsWith("08") || sqlstate === "53300") {
    return failure("DATABASE_ERROR", true, false);
  }
  // A thrown transport error reaches here with no SQLSTATE — treat as transient.
  if (sqlstate === "") return failure("DATABASE_ERROR", true, false);
  return failure("UNKNOWN", false, true);
}

// ---------------------------------------------------------------------------
// Reconciliation (pure decisions — no polling, no provider, no I/O)
// ---------------------------------------------------------------------------

export type ReconciliationAction =
  | { kind: "SETTLE"; fills: ExecutionFill[] }
  | { kind: "NOOP" }
  | { kind: "RECONCILE_REQUIRED"; reason: string }
  | { kind: "INCIDENT"; reason: string };

const TERMINAL: readonly OrderStatus[] = ["FILLED", "CANCELLED", "REJECTED", "EXPIRED"];

/**
 * Decides what to do with a venue's order view + discrete fills, given which
 * provider trade ids are already settled internally and the internal order's
 * status. Pure: it chooses an action, it does not perform one.
 *
 *   * unseen fills + live order            → SETTLE the unseen fills
 *   * unseen fills + terminal internal     → INCIDENT (internal terminal, venue reports more)
 *   * no unseen fills + venue FILLED, internal not FILLED → RECONCILE_REQUIRED
 *   * otherwise                            → NOOP
 *
 * A cumulative-snapshot venue must NOT be passed here as a fill: see
 * `deriveFillDelta`. Each element of `providerFills` is a discrete fill with its
 * own `externalFillId`.
 */
export function decideReconciliation(input: {
  providerStatus: ExternalOrderStatus;
  providerFills: readonly ExecutionFill[];
  appliedProviderTradeIds: readonly string[];
  internalStatus: OrderStatus;
}): ReconciliationAction {
  const applied = new Set(input.appliedProviderTradeIds);
  const unseen = input.providerFills.filter((f) => !applied.has(f.externalFillId));
  const internalTerminal = TERMINAL.includes(input.internalStatus);

  if (unseen.length > 0) {
    if (internalTerminal) {
      return { kind: "INCIDENT", reason: "internal order is terminal but the venue reports new fills" };
    }
    return { kind: "SETTLE", fills: unseen };
  }

  if (input.providerStatus === "FILLED" && input.internalStatus !== "FILLED") {
    return { kind: "RECONCILE_REQUIRED", reason: "venue reports FILLED but no settleable fills are available" };
  }
  return { kind: "NOOP" };
}

/**
 * Converts a venue's CUMULATIVE filled base into the delta not yet settled
 * internally. A cumulative snapshot is never itself a fill (settlement-spec
 * gap G6): an adapter computes this delta and, only if it is positive, mints a
 * discrete `ExecutionFill` (with its own `externalFillId`) for it. A
 * non-positive delta means nothing new to settle.
 */
export function deriveFillDelta(cumulativeFilledBase: Money, internalFilledBase: Money): Money {
  const delta = subtractMoney(cumulativeFilledBase, internalFilledBase);
  return isNegative(delta) ? ZERO : delta;
}

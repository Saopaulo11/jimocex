import {
  addMoney,
  compareMoney,
  divideMoney,
  isNegative,
  isPositive,
  isZero,
  parseMoney,
  subtractMoney,
  toDecimalString,
  ZERO,
  type Money,
} from "../money.ts";
import type { ExecutionFill, ExecutionSnapshot, OrderSide } from "../execution/types.ts";

/**
 * Fill validation and cumulative-delta derivation (Slice 14A) — pure, no I/O.
 *
 * Settlement only ever hands `apply_fill` a DISCRETE fill: one quantity, one
 * quote, one fee, one idempotency id. Two kinds of venue report reach that shape:
 *
 *   * a discrete fill with the venue's own trade id — checked by
 *     `checkDiscreteFill`, settled under that id;
 *   * a cumulative snapshot (running totals) — turned into the fill not yet
 *     settled by `deriveCumulativeFill`, from PERSISTED settled totals, never
 *     from a client or from the snapshot alone.
 *
 * THE CUMULATIVE RULE. The derived fill is
 *
 *     delta = venue cumulative − settled cumulative      (base, quote and fee)
 *
 * and its id is `cumulative:<venue order id>:<settled base it starts from>`.
 * Keying the id on the START point, not the snapshot, is what makes it exactly
 * once: every settled fill moves the settled base on from where it started, so
 * a start point can be settled at most once — a replayed snapshot, or two
 * snapshots computed concurrently from the same stale start, carry the same id,
 * and `apply_fill` (UNIQUE provider_trade_id, order row lock) settles one and
 * returns the other as a duplicate. A later snapshot then starts from the new
 * settled base. This holds only if every fill of the order goes through this
 * path, so an order is settled in ONE mode: a discrete fill may not use the
 * reserved prefix, and either path refuses an order that already carries fills
 * of the other kind.
 *
 * `apply_fill` re-validates everything (over-fill, terminal order, reservation)
 * inside its transaction; these checks fail fast and give each refusal a name.
 */

export const CUMULATIVE_FILL_PREFIX = "cumulative:";

/** The idempotency id of the fill that starts at `settledBase` on this venue order. */
export function cumulativeFillId(externalOrderId: string, settledBase: Money): string {
  return `${CUMULATIVE_FILL_PREFIX}${externalOrderId}:${toDecimalString(settledBase)}`;
}

export function isCumulativeFillId(providerTradeId: string): boolean {
  return providerTradeId.startsWith(CUMULATIVE_FILL_PREFIX);
}

export type FillProblem =
  /** Zero or negative base or quote. */
  | "NOT_POSITIVE"
  /** A negative fee. */
  | "INVALID_FEE"
  | "SIDE_MISMATCH"
  /** The fill would take the order past its amount. */
  | "OVER_FILL"
  /** The order is FILLED/CANCELLED/REJECTED/EXPIRED and cannot take a new fill. */
  | "ORDER_TERMINAL"
  /** The order was never submitted to a venue (OPEN): no venue fill can belong to it. */
  | "NOT_SUBMITTED"
  /** A discrete fill presenting an id from the reserved cumulative scheme. */
  | "RESERVED_FILL_ID"
  /** A cumulative snapshot below what is already settled. */
  | "REGRESSION"
  /** Totals that contradict each other (e.g. more base but no more quote). */
  | "INCONSISTENT"
  /** The persisted order and its settled trades disagree — read again, never guess. */
  | "STATE_MISMATCH"
  /** The order carries fills of the other reporting mode. */
  | "MIXED_FILL_MODES";

/** The internal order a fill is checked against, as persisted. */
export type FillTarget = {
  side: OrderSide;
  amount: Money;
  /** trading_orders.filled_amount */
  filledAmount: Money;
  terminal: boolean;
  /** SUBMITTED or later — as apply_fill requires (022). */
  submitted: boolean;
};

/** One settled trade of the order, as persisted. */
export type SettledFill = { providerTradeId: string; base: Money; quote: Money; fee: Money };

export type FillCheck = { ok: true } | { ok: false; problem: FillProblem };

const exact = (value: string): Money | null => {
  try {
    return parseMoney(value);
  } catch {
    return null;
  }
};

/** Checks one discrete venue fill against the order before it may reach `apply_fill`. */
export function checkDiscreteFill(target: FillTarget, fill: ExecutionFill, settled: readonly SettledFill[]): FillCheck {
  if (isCumulativeFillId(fill.externalFillId)) return { ok: false, problem: "RESERVED_FILL_ID" };
  if (settled.some((s) => isCumulativeFillId(s.providerTradeId))) return { ok: false, problem: "MIXED_FILL_MODES" };
  if (fill.side !== target.side) return { ok: false, problem: "SIDE_MISMATCH" };

  const base = exact(fill.amount);
  const quote = exact(fill.quoteAmount);
  const fee = exact(fill.fee);
  if (base === null || quote === null || !isPositive(base) || !isPositive(quote)) return { ok: false, problem: "NOT_POSITIVE" };
  if (fee === null || isNegative(fee)) return { ok: false, problem: "INVALID_FEE" };
  if (target.terminal) return { ok: false, problem: "ORDER_TERMINAL" };
  if (!target.submitted) return { ok: false, problem: "NOT_SUBMITTED" };
  if (compareMoney(addMoney(target.filledAmount, base), target.amount) > 0) return { ok: false, problem: "OVER_FILL" };
  return { ok: true };
}

export type CumulativeDerivation =
  | { kind: "FILL"; fill: ExecutionFill }
  /** The snapshot adds nothing to what is settled (e.g. the same snapshot again). */
  | { kind: "NOTHING_NEW" }
  | { kind: "REJECT"; problem: FillProblem };

/**
 * The fill a cumulative snapshot adds to what is already settled, or why there is
 * none. `settled` is every trade the order carries, read from the database.
 */
export function deriveCumulativeFill(
  target: FillTarget,
  snapshot: ExecutionSnapshot,
  settled: readonly SettledFill[],
): CumulativeDerivation {
  const reject = (problem: FillProblem): CumulativeDerivation => ({ kind: "REJECT", problem });
  if (snapshot.side !== target.side) return reject("SIDE_MISMATCH");

  const ownPrefix = `${CUMULATIVE_FILL_PREFIX}${snapshot.externalOrderId}:`;
  if (settled.some((s) => !s.providerTradeId.startsWith(ownPrefix))) return reject("MIXED_FILL_MODES");

  let settledBase = ZERO;
  let settledQuote = ZERO;
  let settledFee = ZERO;
  for (const s of settled) {
    settledBase = addMoney(settledBase, s.base);
    settledQuote = addMoney(settledQuote, s.quote);
    settledFee = addMoney(settledFee, s.fee);
  }
  // The order row and its trades are written in one apply_fill transaction; if
  // they disagree, the two reads straddled a settlement. Read again.
  if (compareMoney(settledBase, target.filledAmount) !== 0) return reject("STATE_MISMATCH");

  const cumBase = exact(snapshot.cumulativeBase);
  const cumQuote = exact(snapshot.cumulativeQuote);
  const cumFee = exact(snapshot.cumulativeFee);
  if (cumBase === null || cumQuote === null || cumFee === null) return reject("INCONSISTENT");
  if (isNegative(cumBase) || isNegative(cumQuote) || isNegative(cumFee)) return reject("INCONSISTENT");
  if (compareMoney(cumBase, target.amount) > 0) return reject("OVER_FILL");

  const deltaBase = subtractMoney(cumBase, settledBase);
  if (isNegative(deltaBase)) return reject("REGRESSION");
  const deltaQuote = subtractMoney(cumQuote, settledQuote);
  const deltaFee = subtractMoney(cumFee, settledFee);
  if (isZero(deltaBase)) {
    return isZero(deltaQuote) && isZero(deltaFee) ? { kind: "NOTHING_NEW" } : reject("INCONSISTENT");
  }
  if (target.terminal) return reject("ORDER_TERMINAL");
  if (!target.submitted) return reject("NOT_SUBMITTED");
  if (!isPositive(deltaQuote) || isNegative(deltaFee)) return reject("INCONSISTENT");

  return {
    kind: "FILL",
    fill: {
      externalFillId: cumulativeFillId(snapshot.externalOrderId, settledBase),
      externalOrderId: snapshot.externalOrderId,
      side: snapshot.side,
      // Informational (trades.price); the quote below is the venue's own figure.
      price: toDecimalString(divideMoney(deltaQuote, deltaBase)),
      amount: toDecimalString(deltaBase),
      quoteAmount: toDecimalString(deltaQuote),
      fee: toDecimalString(deltaFee),
      feeAsset: snapshot.feeAsset,
      executedAt: snapshot.observedAt,
    },
  };
}

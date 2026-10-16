import { ZERO, addMoney, isNegative, maxMoney, minMoney, percentageOf, type Money } from "../money.ts";

/**
 * FeeEngine decision logic, with no I/O (spec §26).
 *
 * The I/O half (reading the most specific `fee_rules` row for an operation,
 * asset and tier) lives in `fee-engine.ts`; this is the pure arithmetic, so the
 * rule that decides what the platform charges is testable without a database or
 * a mock. As in `limit-rules.ts`, the money import is relative because
 * `node --test` runs this file directly and does not resolve `@/`.
 *
 * A fee is NEVER a literal in a component or a route: a client-supplied fee is
 * ignored, always (spec §19.11, §80.18). The caller resolves a `ResolvedFeeRule`
 * from the database by the server-side user's tier and passes it here.
 *
 * Every amount is a `Money` (exact BigInt scaled by 10^18). There is no float
 * anywhere in this file.
 */

/**
 * A `fee_rules` row resolved to Money, mirroring the columns:
 *   percentage numeric(10,6)  — in percent: 0.5 means 0.5%
 *   fixed_fee  numeric(38,18) — flat component, in the operation's asset
 *   min_fee / max_fee numeric(38,18), either NULL (no bound)
 */
export type ResolvedFeeRule = {
  /** Percent as Money: 0.5% is parseMoney("0.5"). */
  percentage: Money;
  fixedFee: Money;
  minFee: Money | null;
  maxFee: Money | null;
};

/**
 * The fee charged on `base`, computed from a resolved rule.
 *
 * `base` is the figure the proportional part applies to — for a trade, the
 * notional in the quote asset. The result is:
 *
 *     clamp( percentageOf(base) + fixedFee , minFee , maxFee )
 *
 * The proportional part rounds UP (the platform never under-charges itself by a
 * rounding step, and the customer sees the exact figure before committing —
 * `percentageOf`'s default). A rule with percentage 0 and fixed_fee 0 yields a
 * zero fee, which is a real, configured answer, not a missing one.
 *
 * Clamping order: the floor and the ceiling are applied after the components
 * are summed. A `max` below the computed fee caps it; a `min` above it raises
 * it. `fee_rules_min_below_max` guarantees min ≤ max in the database, so the two
 * bounds cannot contradict.
 */
export function computeFee(base: Money, rule: ResolvedFeeRule): Money {
  if (isNegative(base)) {
    throw new RangeError("computeFee: base must not be negative");
  }

  const proportional = percentageOf(base, rule.percentage, "up");
  let fee = addMoney(proportional, rule.fixedFee);

  if (rule.minFee !== null) fee = maxMoney(fee, rule.minFee);
  if (rule.maxFee !== null) fee = minMoney(fee, rule.maxFee);

  // A negative fee can never arise from non-negative inputs, but assert the
  // floor rather than trust that: a fee is a charge, not a credit.
  return maxMoney(fee, ZERO);
}

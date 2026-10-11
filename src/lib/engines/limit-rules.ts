import {
  ZERO,
  addMoney,
  compareMoney,
  formatMoney,
  greaterThan,
  isPositive,
  lessThan,
  multiplyMoney,
  type Money,
} from "../money.ts";
import type { Database } from "@/lib/db/database";

/**
 * The LimitEngine's decision logic, with no I/O (spec §12, §25).
 *
 * The money import below is relative, not aliased: this module is executed
 * directly by `node --test`, which does not resolve `@/`. The Database import
 * can stay aliased because it is type-only and erased before Node sees it.
 *
 * Separated from the database access in `limit-engine.ts` because this is the
 * part that decides whether money is allowed to move, and a decision that
 * important should be testable without a network, a database, or a mock that
 * can drift from the thing it imitates. Everything here is a pure function of
 * its arguments.
 *
 * Every amount is a `Money` — an exact BigInt scaled by 10^18, matching
 * numeric(38,18). There is no float anywhere in this file, and the module
 * exposes no way to introduce one: the arithmetic all comes from @/lib/money.
 */

export type LimitOperation = Database["public"]["Enums"]["limit_operation"];
export type LimitWindow = Database["public"]["Enums"]["limit_window"];
export type AccountStatus = Database["public"]["Enums"]["account_status"];

export type LimitRule = {
  window: LimitWindow;
  quoteCurrency: string;
  /** null means "this rule sets no ceiling". */
  max: Money | null;
  min: Money | null;
};

export type EvaluatedLimit = {
  window: LimitWindow;
  /** Decimal strings, for display and logging. */
  amount: string;
  used: string;
  max: string | null;
  min: string | null;
  withinLimit: boolean;
};

export type LimitDecision =
  | { decision: "ALLOW"; evaluated: EvaluatedLimit[] }
  | { decision: "REQUIRE_KYC"; reason: string; requiredTier: string; evaluated: EvaluatedLimit[] }
  | { decision: "BLOCK"; reason: string; evaluated: EvaluatedLimit[] }
  | { decision: "UNAVAILABLE"; reason: string };

/**
 * Statuses from which no financial operation proceeds (spec §9).
 *
 * RESTRICTED is intentionally absent: a restricted account is judged per
 * operation by RiskEngine, not barred outright.
 */
export const STATUSES_BARRED_FROM_OPERATIONS: readonly AccountStatus[] = [
  "SUSPENDED",
  "FROZEN",
  "CLOSED",
];

export type EvaluateInput = {
  accountStatus: AccountStatus;
  /**
   * The operation's value in the limit currency — or null when it could not be
   * determined.
   *
   * null is the most important input here. It means no market data provider
   * could value the asset, and the only correct response is to refuse
   * (spec §13). It must never be coerced to zero, which would read as "costs
   * nothing" and clear every ceiling.
   */
  amountInQuote: Money | null;
  rules: LimitRule[];
  /** Consumed so far per window. An absent window counts as zero. */
  usage: Partial<Record<LimitWindow, Money>>;
  /**
   * Ceilings at higher tiers for the breached window, so the engine can answer
   * REQUIRE_KYC naming a tier instead of refusing flatly. Ordered by rank
   * ascending; a null max means that tier sets no ceiling.
   */
  higherTiers?: { code: string; max: Money | null }[];
};

/**
 * An amount's value in the limit currency, at `rate` (limit currency per unit).
 *
 * Rounded UP to the 18th place. This is the figure the operation is charged
 * against the ceiling and, once authorised, consumes from the window, so the
 * rounding must never make it look smaller than it is: truncating would let
 * every operation consume up to 10^-18 less than it moved. Whatever rounds this
 * figure, it is fixed once and stored (limit_usage.usd_equivalent), never
 * recomputed.
 */
export function valueInLimitCurrency(amount: Money, rate: Money): Money {
  return multiplyMoney(amount, rate, "up");
}

export function evaluateLimits(input: EvaluateInput): LimitDecision {
  if (input.accountStatus === "CLOSED") {
    return { decision: "BLOCK", reason: "this account is closed", evaluated: [] };
  }

  if (STATUSES_BARRED_FROM_OPERATIONS.includes(input.accountStatus)) {
    return {
      decision: "BLOCK",
      reason: `account status ${input.accountStatus} does not permit financial operations`,
      evaluated: [],
    };
  }

  // An operation nobody has written a policy for is an operation nobody has
  // approved. Silence is not permission (spec §25).
  if (input.rules.length === 0) {
    return {
      decision: "BLOCK",
      reason: "no limit policy is configured for this operation at this tier",
      evaluated: [],
    };
  }

  // The refusal spec §13 exists for. Without a conversion the engine cannot
  // know whether any ceiling is breached, and approving on an approximate rate
  // is not an option.
  if (input.amountInQuote === null) {
    return {
      decision: "UNAVAILABLE",
      reason: "the operation could not be valued in the limit currency: no market data available",
    };
  }

  const amount = input.amountInQuote;

  // A zero or negative amount moves nothing a limit could measure, and a
  // negative one would REDUCE the window's running total — every ceiling would
  // pass. Input parsing refuses both before this point (parseAmountInput); the
  // engine refuses them again rather than trust that.
  if (!isPositive(amount)) {
    return { decision: "BLOCK", reason: "the amount must be greater than zero", evaluated: [] };
  }

  const evaluated: EvaluatedLimit[] = [];
  let breached: LimitWindow | null = null;
  let belowMinimum = false;

  for (const rule of input.rules) {
    const used = rule.window === "SINGLE" ? ZERO : (input.usage[rule.window] ?? ZERO);

    // SINGLE bounds this operation alone; a rolling window bounds it on top of
    // what the window has already consumed.
    const total = rule.window === "SINGLE" ? amount : addMoney(used, amount);
    const withinLimit = rule.max === null || !greaterThan(total, rule.max);

    if (rule.min !== null && lessThan(amount, rule.min)) belowMinimum = true;
    if (!withinLimit && breached === null) breached = rule.window;

    evaluated.push({
      window: rule.window,
      amount: formatMoney(amount),
      used: formatMoney(used),
      max: rule.max === null ? null : formatMoney(rule.max),
      min: rule.min === null ? null : formatMoney(rule.min),
      withinLimit,
    });
  }

  if (belowMinimum) {
    return {
      decision: "BLOCK",
      reason: "amount is below the minimum for this operation",
      evaluated,
    };
  }

  if (breached === null) {
    return { decision: "ALLOW", evaluated };
  }

  // Over the limit is not automatically a refusal. If verification would lift
  // the ceiling, say so and name the tier (spec §11, §23).
  const upgrade = (input.higherTiers ?? []).find(
    (tier) => tier.max === null || compareMoney(tier.max, amount) >= 0,
  );

  if (upgrade) {
    return {
      decision: "REQUIRE_KYC",
      reason: `this amount exceeds the ${breached.toLowerCase()} limit for your account tier`,
      requiredTier: upgrade.code,
      evaluated,
    };
  }

  return {
    decision: "BLOCK",
    reason: `this amount exceeds the ${breached.toLowerCase()} limit and no higher tier permits it`,
    evaluated,
  };
}

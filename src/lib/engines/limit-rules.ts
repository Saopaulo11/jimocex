import type { Database } from "@/lib/supabase/database.types";

/**
 * The LimitEngine's decision logic, with no I/O (spec §12, §25).
 *
 * Separated from the database access in `limit-engine.ts` for one reason: this
 * is the part that decides whether money is allowed to move, and a decision
 * that important should be testable without a network, a database or a mock
 * that might drift from the real client's behaviour. Everything here is a pure
 * function of its arguments.
 *
 * No `server-only` import: nothing here reads a secret or touches a connection.
 */

export type LimitOperation = Database["public"]["Enums"]["limit_operation"];
export type LimitWindow = Database["public"]["Enums"]["limit_window"];
export type AccountStatus = Database["public"]["Enums"]["account_status"];

export type LimitRule = {
  window: LimitWindow;
  quoteCurrency: string;
  /** Decimal string, or null for "this rule sets no ceiling". */
  max: string | null;
  min: string | null;
};

export type EvaluatedLimit = {
  window: LimitWindow;
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

/* ---------------------------------------------------------------------------
   Decimal arithmetic
   ---------------------------------------------------------------------------

   Scaled BigInt, 18 fractional digits, matching the database's
   numeric(38,18). Deliberately not `Number`: a float cannot represent 18
   decimal places, and 0.1 + 0.2 !== 0.3 is not an acceptable property for the
   comparison that decides whether a withdrawal proceeds.
   --------------------------------------------------------------------------- */

const SCALE = 18;
const SCALE_FACTOR = 10n ** BigInt(SCALE);

export function toScaled(decimal: string): bigint {
  const trimmed = decimal.trim();
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) {
    throw new Error(`not a decimal number: ${JSON.stringify(decimal)}`);
  }
  const negative = trimmed.startsWith("-");
  const unsigned = negative ? trimmed.slice(1) : trimmed;
  const [whole = "0", fraction = ""] = unsigned.split(".");
  // Truncate rather than round beyond 18 places: rounding up here would invent
  // value that the database column cannot hold anyway.
  const padded = (fraction + "0".repeat(SCALE)).slice(0, SCALE);
  const value = BigInt(whole) * SCALE_FACTOR + BigInt(padded || "0");
  return negative ? -value : value;
}

export function fromScaled(value: bigint): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const whole = abs / SCALE_FACTOR;
  const fraction = (abs % SCALE_FACTOR).toString().padStart(SCALE, "0").replace(/0+$/, "");
  const text = fraction ? `${whole}.${fraction}` : whole.toString();
  return negative ? `-${text}` : text;
}

/** `a * b`, both scaled, result scaled. */
export function multiplyScaled(a: bigint, b: bigint): bigint {
  return (a * b) / SCALE_FACTOR;
}

/**
 * Statuses from which no financial operation proceeds (spec §9).
 *
 * RESTRICTED is intentionally not here: a restricted account is judged per
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
   * The operation's value in the limit currency, as a decimal string — or null
   * when it could not be determined.
   *
   * null is the single most important input here. It means no market data
   * provider could value the asset, and the only correct response is to refuse
   * (spec §13). It must never be coerced to 0, which would read as "costs
   * nothing" and pass every ceiling.
   */
  amountInQuote: string | null;
  rules: LimitRule[];
  /** Consumed so far per window, as decimal strings. Absent means zero. */
  usage: Partial<Record<LimitWindow, string>>;
  /**
   * Ceilings at higher tiers for the window that was breached, so the engine can
   * answer REQUIRE_KYC naming a tier instead of a flat refusal. Ordered by rank
   * ascending; a null max means that tier sets no ceiling.
   */
  higherTiers?: { code: string; max: string | null }[];
};

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

  // The refusal that spec §13 exists for. Without a conversion the engine
  // cannot know whether any ceiling is breached, and approving on an
  // approximate rate is not an option.
  if (input.amountInQuote === null) {
    return {
      decision: "UNAVAILABLE",
      reason: "the operation could not be valued in the limit currency: no market data available",
    };
  }

  const amount = toScaled(input.amountInQuote);
  const evaluated: EvaluatedLimit[] = [];
  let breached: LimitWindow | null = null;
  let belowMinimum = false;

  for (const rule of input.rules) {
    const usedRaw = rule.window === "SINGLE" ? "0" : (input.usage[rule.window] ?? "0");
    const used = toScaled(usedRaw);

    const max = rule.max === null ? null : toScaled(rule.max);
    const min = rule.min === null ? null : toScaled(rule.min);

    // SINGLE compares this operation alone; the rolling windows compare it on
    // top of what the window has already consumed.
    const total = rule.window === "SINGLE" ? amount : used + amount;
    const withinLimit = max === null || total <= max;

    if (min !== null && amount < min) belowMinimum = true;
    if (!withinLimit && breached === null) breached = rule.window;

    evaluated.push({
      window: rule.window,
      amount: fromScaled(amount),
      used: fromScaled(used),
      max: max === null ? null : fromScaled(max),
      min: min === null ? null : fromScaled(min),
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
    (tier) => tier.max === null || toScaled(tier.max) >= amount,
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

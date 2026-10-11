import "server-only";

import { moneySelect } from "@/lib/db/money-columns";
import { isAppError } from "@/lib/errors";
import {
  ZERO,
  addMoney,
  fromDatabase,
  multiplyMoney,
  parseMoney,
  type Money,
} from "@/lib/money";
import { getMarketDataProvider } from "@/lib/providers/market-data";
import { createAdminClient } from "@/lib/supabase/admin";

import {
  evaluateLimits,
  type LimitDecision,
  type LimitOperation,
  type LimitRule,
  type LimitWindow,
} from "./limit-rules";

/**
 * LimitEngine (spec §12, §25) — the I/O half.
 *
 * Gathers the inputs: the account's tier and status, the rules for the
 * operation, what the windows have already consumed, and the operation's value
 * in the limit currency. `evaluateLimits` then decides.
 *
 * Every money column is read through `moneySelect()`, which appends `::text` so
 * PostgreSQL renders the exact decimal instead of letting PostgREST serialise
 * it as a JSON number. `fromDatabase()` then parses it, and throws if a number
 * arrives anyway — so a dropped cast fails loudly here rather than quietly
 * approving an operation against a rounded ceiling.
 *
 * What is NOT a parameter here, and cannot be: the tier, the limits, the fee,
 * the account status. Each is read from the database by the server-side user
 * id. A client that sends `{ tier: "TIER_3" }` is sending a field nothing reads
 * (spec §10, §15).
 */

export type LimitCheckInput = {
  /** Established by the DAL from the verified session. Never a request body field. */
  userId: string;
  operation: LimitOperation;
  /** Asset the amount is denominated in, e.g. "BTC". */
  assetSymbol: string;
  /** Exact decimal string. Never a number — see @/lib/money. */
  amount: string;
};

export async function checkEligibility(input: LimitCheckInput): Promise<LimitDecision> {
  const supabase = createAdminClient();

  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("tier_code, status")
    .eq("user_id", input.userId)
    .single();

  if (profileError || !profile) {
    return { decision: "UNAVAILABLE", reason: "account profile could not be read" };
  }

  const { data: ruleRows, error: rulesError } = await supabase
    .from("tier_limits")
    .select(moneySelect("tier_limits", "window_kind, quote_currency, max_amount, min_amount"))
    .eq("tier_code", profile.tier_code)
    .eq("operation", input.operation)
    .eq("is_active", true)
    .overrideTypes<
      { window_kind: LimitWindow; quote_currency: string; max_amount: string | null; min_amount: string | null }[]
    >();

  if (rulesError) {
    return { decision: "UNAVAILABLE", reason: "limit configuration could not be read" };
  }

  const rules: LimitRule[] = (ruleRows ?? []).map((row) => ({
    window: row.window_kind,
    quoteCurrency: row.quote_currency,
    max: fromDatabase(row.max_amount, "tier_limits.max_amount"),
    min: fromDatabase(row.min_amount, "tier_limits.min_amount"),
  }));

  const quoteCurrency = rules[0]?.quoteCurrency ?? "USD";
  const amountInQuote = await convertToQuoteCurrency(
    input.amount,
    input.assetSymbol,
    quoteCurrency,
  );

  // Usage is only needed for rolling windows, and only when a conversion
  // exists — there is nothing to compare against otherwise.
  const usage: Partial<Record<LimitWindow, Money>> = {};
  if (amountInQuote !== null) {
    for (const rule of rules) {
      if (rule.window === "SINGLE") continue;

      const consumed = await usageInWindow(
        supabase,
        input.userId,
        input.operation,
        windowStart(rule.window, new Date()),
      );

      if (consumed === null) {
        // Unknown consumption is the same class of problem as a missing rate:
        // the window cannot be evaluated, so the answer is "cannot decide",
        // never "assume zero".
        return { decision: "UNAVAILABLE", reason: "limit usage could not be read" };
      }
      usage[rule.window] = consumed;
    }
  }

  const higherTiers = await ceilingsAtHigherTiers({
    supabase,
    currentTier: profile.tier_code,
    operation: input.operation,
    rules,
  });

  return evaluateLimits({
    accountStatus: profile.status,
    amountInQuote,
    rules,
    usage,
    higherTiers,
  });
}

/**
 * Sums what a window has already consumed.
 *
 * Reads the rows and adds them in exact BigInt rather than calling a SQL
 * aggregate through PostgREST. An RPC returning `numeric` would be serialised
 * as a JSON number and arrive rounded — the very defect this boundary exists to
 * close — and a function's return type cannot be cast at the call site the way
 * a column can. The row count per user, per operation, per window is small, so
 * the exactness costs nothing worth saving.
 */
async function usageInWindow(
  supabase: ReturnType<typeof createAdminClient>,
  userId: string,
  operation: LimitOperation,
  since: Date,
): Promise<Money | null> {
  const { data, error } = await supabase
    .from("limit_usage")
    .select(moneySelect("limit_usage", "usd_equivalent"))
    .eq("user_id", userId)
    .eq("operation", operation)
    .gte("occurred_at", since.toISOString())
    .overrideTypes<{ usd_equivalent: string }[]>();

  if (error) return null;

  let total = ZERO;
  for (const row of data ?? []) {
    total = addMoney(total, fromDatabase(row.usd_equivalent, "limit_usage.usd_equivalent"));
  }
  return total;
}

function windowStart(window: Exclude<LimitWindow, "SINGLE">, now: Date): Date {
  const start = new Date(now);
  start.setUTCHours(0, 0, 0, 0);
  if (window === "MONTHLY") start.setUTCDate(1);
  return start;
}

/**
 * Converts `amount` of `assetSymbol` into `quoteCurrency`.
 *
 * Returns null when it cannot — which the caller passes straight through to
 * `evaluateLimits`, where null means UNAVAILABLE. A fallback rate, a stale
 * cached rate or a zero would each turn an unanswerable question into a wrong
 * answer (spec §13, §80.1).
 */
async function convertToQuoteCurrency(
  amount: string,
  assetSymbol: string,
  quoteCurrency: string,
): Promise<Money | null> {
  // Identity: exact, and the path that lets USD-denominated limits be enforced
  // on USD operations with no market data connected at all.
  if (assetSymbol === quoteCurrency) return parseMoney(amount);

  const provider = getMarketDataProvider();
  if (!provider.isConfigured()) return null;

  try {
    const ticker = await provider.getTicker(`${assetSymbol}-${quoteCurrency}`);
    const rate = parseMoney(ticker.price);
    if (rate <= 0n) return null;
    return multiplyMoney(parseMoney(amount), rate);
  } catch (error) {
    if (!isAppError(error)) {
      console.error("[limit-engine] rate lookup failed", error);
    }
    return null;
  }
}

async function ceilingsAtHigherTiers(args: {
  supabase: ReturnType<typeof createAdminClient>;
  currentTier: string;
  operation: LimitOperation;
  rules: LimitRule[];
}): Promise<{ code: string; max: Money | null }[]> {
  const { supabase, currentTier, operation, rules } = args;
  if (rules.length === 0) return [];

  const { data: tiers } = await supabase
    .from("account_tiers")
    .select("code, rank")
    .eq("is_active", true)
    .order("rank", { ascending: true });

  if (!tiers) return [];

  const currentRank = tiers.find((t) => t.code === currentTier)?.rank;
  if (currentRank === undefined) return [];

  // The SINGLE ceiling is what a customer can act on immediately after
  // verifying, so it is what the upgrade suggestion is based on.
  const window: LimitWindow = rules.some((r) => r.window === "SINGLE") ? "SINGLE" : "DAILY";

  const { data: higherRules } = await supabase
    .from("tier_limits")
    .select(moneySelect("tier_limits", "tier_code, max_amount"))
    .eq("operation", operation)
    .eq("window_kind", window)
    .eq("is_active", true)
    .overrideTypes<{ tier_code: string; max_amount: string | null }[]>();

  return tiers
    .filter((t) => t.rank > currentRank)
    .map((tier) => {
      const rule = (higherRules ?? []).find((r) => r.tier_code === tier.code);
      if (!rule) return null;
      return { code: tier.code, max: fromDatabase(rule.max_amount, "tier_limits.max_amount") };
    })
    .filter((v): v is { code: string; max: Money | null } => v !== null);
}

export type { LimitDecision } from "./limit-rules";

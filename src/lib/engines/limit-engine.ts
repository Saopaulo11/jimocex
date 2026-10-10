import "server-only";

import { isAppError } from "@/lib/errors";
import { getMarketDataProvider } from "@/lib/providers/market-data";
import { createAdminClient } from "@/lib/supabase/admin";

import {
  evaluateLimits,
  fromScaled,
  multiplyScaled,
  toScaled,
  type LimitDecision,
  type LimitOperation,
  type LimitRule,
  type LimitWindow,
} from "./limit-rules";

/**
 * LimitEngine (spec §12, §25) — the I/O half.
 *
 * This file gathers the inputs: the account's tier and status, the rules for
 * the operation, what the windows have already consumed, and the operation's
 * value in the limit currency. `evaluateLimits` in `./limit-rules` then decides.
 * Keeping the decision pure is what makes it testable without a database.
 *
 * What is NOT a parameter here, and cannot be: the tier, the limits, the fee,
 * the account status. Every one is read from the database by the server-side
 * user id. A client that sends `{ tier: "TIER_3" }` is sending a field nothing
 * reads (spec §10, §15).
 */

export type LimitCheckInput = {
  /** Established by the DAL from the verified session. Never a request body field. */
  userId: string;
  operation: LimitOperation;
  /** Asset the amount is denominated in, e.g. "BTC". */
  assetSymbol: string;
  /** Decimal string, never a float. */
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
    .select("window_kind, quote_currency, max_amount, min_amount")
    .eq("tier_code", profile.tier_code)
    .eq("operation", input.operation)
    .eq("is_active", true);

  if (rulesError) {
    return { decision: "UNAVAILABLE", reason: "limit configuration could not be read" };
  }

  const rules: LimitRule[] = (ruleRows ?? []).map((row) => ({
    window: row.window_kind,
    quoteCurrency: row.quote_currency,
    max: row.max_amount === null ? null : String(row.max_amount),
    min: row.min_amount === null ? null : String(row.min_amount),
  }));

  const quoteCurrency = rules[0]?.quoteCurrency ?? "USD";
  const amountInQuote = await convertToQuoteCurrency(
    input.amount,
    input.assetSymbol,
    quoteCurrency,
  );

  // Usage is only needed for the rolling windows, and only when a conversion
  // exists — there is nothing to compare against otherwise.
  const usage: Partial<Record<LimitWindow, string>> = {};
  if (amountInQuote !== null) {
    for (const rule of rules) {
      if (rule.window === "SINGLE") continue;
      const since = windowStart(rule.window, new Date());
      const { data, error } = await supabase.rpc("limit_usage_in_window", {
        p_user_id: input.userId,
        p_operation: input.operation,
        p_since: since.toISOString(),
      });
      if (error) {
        // Unknown consumption is the same class of problem as a missing rate:
        // the window cannot be evaluated, so the answer is "cannot decide",
        // never "assume zero".
        return { decision: "UNAVAILABLE", reason: "limit usage could not be read" };
      }
      usage[rule.window] = String(data ?? "0");
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
 * `evaluateLimits`, where null means UNAVAILABLE. A fallback rate, a cached
 * stale rate or a zero would each turn an unanswerable question into a wrong
 * answer (spec §13, §80.1).
 */
async function convertToQuoteCurrency(
  amount: string,
  assetSymbol: string,
  quoteCurrency: string,
): Promise<string | null> {
  // Identity: exact, and the path that lets USD-denominated limits be enforced
  // on USD operations with no market data connected at all.
  if (assetSymbol === quoteCurrency) return amount;

  const provider = getMarketDataProvider();
  if (!provider.isConfigured()) return null;

  try {
    const ticker = await provider.getTicker(`${assetSymbol}-${quoteCurrency}`);
    const rate = toScaled(ticker.price);
    if (rate <= 0n) return null;
    return fromScaled(multiplyScaled(toScaled(amount), rate));
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
}): Promise<{ code: string; max: string | null }[]> {
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

  // The SINGLE ceiling is the one a customer can act on immediately after
  // verifying, so it is what the upgrade suggestion is based on.
  const window: LimitWindow = rules.some((r) => r.window === "SINGLE") ? "SINGLE" : "DAILY";

  const { data: higherRules } = await supabase
    .from("tier_limits")
    .select("tier_code, max_amount")
    .eq("operation", operation)
    .eq("window_kind", window)
    .eq("is_active", true);

  return tiers
    .filter((t) => t.rank > currentRank)
    .map((tier) => {
      const rule = (higherRules ?? []).find((r) => r.tier_code === tier.code);
      return rule ? { code: tier.code, max: rule.max_amount === null ? null : String(rule.max_amount) } : null;
    })
    .filter((v): v is { code: string; max: string | null } => v !== null);
}

export type { LimitDecision } from "./limit-rules";

import { parseAmountInput, toDecimalString, type Money } from "../src/lib/money.ts";

/**
 * Demo account funding — the pure half (Slice 10).
 *
 * A development/preview-only fixture that gives ONE dedicated demo account a
 * fixed, ledger-backed opening balance, so the real order lifecycle (place →
 * HOLD → cancel → RELEASE) can be exercised from the UI. It is not a faucet:
 *
 *   * it is a command-line script (`scripts/fund-demo-account.ts`), never a
 *     route, a server action or anything the application bundles or imports;
 *   * it needs the TARGET project's service-role key, which only an operator
 *     holds, and it refuses — before it connects — unless every check in
 *     `checkFundingEnvironment` passes; an unknown environment is a refusal;
 *   * the account comes from configuration (one email), the assets and amounts
 *     are the constants below, and nothing takes an amount, a user or an asset
 *     from a browser;
 *   * every unit is posted through `ledger_post` as an ADJUSTMENT under a fixed
 *     dedup key, so it is an immutable, auditable ledger entry, a balance is
 *     never written directly, and running it twice funds once.
 *
 * This module holds the decisions (environment guard, plan, idempotency) behind
 * ports, so they are unit-tested without a database; the CLI wires the ports to
 * a service-role Supabase client.
 */

/** Projects that are production. Funding refuses them whatever else is set. */
export const PRODUCTION_PROJECT_REFS: readonly string[] = ["sykhghtlkcrzwaoehlhf"];

/**
 * The opening balance, per asset: enough for a BUY (quote) and a SELL (base) on
 * each pair of the demo trading set. Whole units, so each fits every asset's
 * precision (BTC 8, ETH 18, SOL 9, USDT 6 decimals in 011).
 */
export const DEMO_OPENING_BALANCES: readonly { symbol: string; amount: string }[] = [
  { symbol: "USDT", amount: "10000" },
  { symbol: "BTC", amount: "1" },
  { symbol: "ETH", amount: "10" },
  { symbol: "SOL", amount: "100" },
];

/** Bump only with a new, reviewed funding policy: it is part of every dedup key. */
export const FUNDING_VERSION = "v1";

export const dedupKeyFor = (userId: string, symbol: string): string =>
  `demo-funding:${FUNDING_VERSION}:${userId}:${symbol}`;

export type FundingEnvironment = "development" | "preview";

export type FundingTarget = {
  environment: FundingEnvironment;
  /** Printed so the operator sees where it is about to write. Public by design. */
  host: string;
};

export type GuardResult =
  | { ok: true; target: FundingTarget; email: string }
  | { ok: false; reason: string };

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const SUPABASE_HOST = /^([a-z0-9]{20})\.supabase\.co$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Decides whether funding may run, from the environment alone. Fail-closed:
 * every rule must positively pass, and anything it does not recognise is a
 * refusal. It never echoes a secret.
 *
 *   1. Nothing says "production" (`NODE_ENV`, `VERCEL_ENV`).
 *   2. Demo mode is explicitly on: `NEXT_PUBLIC_JIMOCEX_DEMO_MODE=true`, the
 *      repository's demo flag (.env.example: false or unset in production).
 *   3. The target is recognised:
 *        - a loopback Supabase URL → development (a local stack);
 *        - `https://<ref>.supabase.co` → preview, only when `<ref>` is not a
 *          production project AND the operator named that same ref in
 *          `JIMOCEX_DEMO_FUNDING_PROJECT_REF` (a stale .env pointing elsewhere
 *          is refused);
 *        - anything else is an unknown environment → refused.
 *   4. A service-role key is present (the script cannot work without one).
 *   5. `JIMOCEX_DEMO_ACCOUNT_EMAIL` names the one demo account.
 */
export function checkFundingEnvironment(env: Readonly<Record<string, string | undefined>>): GuardResult {
  if (env.NODE_ENV === "production" || env.VERCEL_ENV === "production") {
    return { ok: false, reason: "this is a production environment; demo funding never runs there" };
  }
  if (env.NEXT_PUBLIC_JIMOCEX_DEMO_MODE !== "true") {
    return { ok: false, reason: "demo mode is not on (NEXT_PUBLIC_JIMOCEX_DEMO_MODE must be exactly \"true\")" };
  }

  const rawUrl = env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, reason: "NEXT_PUBLIC_SUPABASE_URL is missing or not a URL" };
  }
  if (url.username || url.password) {
    return { ok: false, reason: "NEXT_PUBLIC_SUPABASE_URL must not carry credentials" };
  }

  let target: FundingTarget;
  if (LOOPBACK_HOSTS.has(url.hostname) && (url.protocol === "http:" || url.protocol === "https:")) {
    target = { environment: "development", host: url.host };
  } else {
    const match = url.protocol === "https:" ? SUPABASE_HOST.exec(url.hostname) : null;
    const ref = match?.[1];
    if (!ref) {
      return { ok: false, reason: "unknown environment: the Supabase URL is neither a local stack nor a supabase.co project" };
    }
    if (PRODUCTION_PROJECT_REFS.includes(ref)) {
      return { ok: false, reason: "the Supabase URL names the production project; demo funding never runs there" };
    }
    if (env.JIMOCEX_DEMO_FUNDING_PROJECT_REF !== ref) {
      return {
        ok: false,
        reason: "JIMOCEX_DEMO_FUNDING_PROJECT_REF must name the same test project as NEXT_PUBLIC_SUPABASE_URL",
      };
    }
    target = { environment: "preview", host: url.host };
  }

  if (!env.SUPABASE_SERVICE_ROLE_KEY) {
    return { ok: false, reason: "SUPABASE_SERVICE_ROLE_KEY (the target project's) is not set" };
  }

  const email = (env.JIMOCEX_DEMO_ACCOUNT_EMAIL ?? "").trim().toLowerCase();
  if (!EMAIL.test(email)) {
    return { ok: false, reason: "JIMOCEX_DEMO_ACCOUNT_EMAIL must name the demo account's email address" };
  }

  return { ok: true, target, email };
}

/* ===========================================================================
   Funding
   =========================================================================== */

export type FundingDeps = {
  /** The profile for the email, or null. Throws if more than one matches. */
  findAccount(email: string): Promise<{ userId: string; status: string } | null>;
  findAsset(symbol: string): Promise<{ assetId: string; decimals: number; isActive: boolean } | null>;
  /** The ledger entry already posted under this dedup key, if any. */
  findEntry(dedupKey: string): Promise<{ entryId: string } | null>;
  /**
   * One `ledger_post` ADJUSTMENT: +amount available, 0 locked. DUPLICATE when a
   * concurrent run posted the same dedup key first (the unique index refused it).
   */
  postOpeningBalance(args: {
    userId: string;
    assetId: string;
    amount: Money;
    dedupKey: string;
    environment: FundingEnvironment;
  }): Promise<{ ok: true; entryId: string } | { ok: false; reason: "DUPLICATE" }>;
  hasAuditRecord(entryId: string): Promise<boolean>;
  recordAudit(args: {
    entryId: string;
    userId: string;
    symbol: string;
    amount: Money;
    dedupKey: string;
    environment: FundingEnvironment;
  }): Promise<void>;
};

export type FundingLine = {
  symbol: string;
  amount: string;
  outcome: "funded" | "already funded";
  entryId: string;
};

export class FundingRefused extends Error {}

/**
 * Gives the demo account its opening balance, once. Validates the account and
 * every asset BEFORE posting anything, so a missing asset cannot leave a
 * half-funded account; then, per asset, posts only if no entry carries its
 * dedup key. An audit row is written for each funding entry that has none, so a
 * run interrupted between the two completes the record on the next run.
 */
export async function ensureDemoAccountFunded(
  deps: FundingDeps,
  args: { email: string; environment: FundingEnvironment },
): Promise<{ userId: string; lines: FundingLine[] }> {
  const account = await deps.findAccount(args.email);
  if (!account) {
    throw new FundingRefused("no account has that email: sign it up through the application first, then run this again");
  }
  if (account.status !== "ACTIVE") {
    throw new FundingRefused(`the demo account is ${account.status}, not ACTIVE; nothing was funded`);
  }

  const plan: { symbol: string; assetId: string; amount: Money }[] = [];
  for (const balance of DEMO_OPENING_BALANCES) {
    const asset = await deps.findAsset(balance.symbol);
    if (!asset || !asset.isActive) {
      throw new FundingRefused(`asset ${balance.symbol} is missing or inactive; nothing was funded`);
    }
    const parsed = parseAmountInput(balance.amount, { maxDecimals: asset.decimals });
    if (!parsed.ok) {
      throw new FundingRefused(`${balance.amount} ${balance.symbol} does not fit the asset (${parsed.problem}); nothing was funded`);
    }
    plan.push({ symbol: balance.symbol, assetId: asset.assetId, amount: parsed.value });
  }

  const lines: FundingLine[] = [];
  for (const item of plan) {
    const dedupKey = dedupKeyFor(account.userId, item.symbol);
    let outcome: FundingLine["outcome"];
    let entryId: string;

    const existing = await deps.findEntry(dedupKey);
    if (existing) {
      outcome = "already funded";
      entryId = existing.entryId;
    } else {
      const posted = await deps.postOpeningBalance({
        userId: account.userId,
        assetId: item.assetId,
        amount: item.amount,
        dedupKey,
        environment: args.environment,
      });
      if (posted.ok) {
        outcome = "funded";
        entryId = posted.entryId;
      } else {
        const winner = await deps.findEntry(dedupKey);
        if (!winner) throw new Error(`ledger_post refused ${dedupKey} as a duplicate, but no entry carries it`);
        outcome = "already funded";
        entryId = winner.entryId;
      }
    }

    if (!(await deps.hasAuditRecord(entryId))) {
      await deps.recordAudit({
        entryId,
        userId: account.userId,
        symbol: item.symbol,
        amount: item.amount,
        dedupKey,
        environment: args.environment,
      });
    }

    lines.push({ symbol: item.symbol, amount: toDecimalString(item.amount), outcome, entryId });
  }

  return { userId: account.userId, lines };
}

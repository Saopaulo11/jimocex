import { createClient } from "@supabase/supabase-js";

import { moneySelect } from "../src/lib/db/money-columns.ts";
import { moneyArgs, moneyInsert } from "../src/lib/db/money-write.ts";
import { parseMoney, toDecimalString } from "../src/lib/money.ts";
import type { Database } from "../src/lib/db/database.ts";

import {
  checkFundingEnvironment,
  ensureDemoAccountFunded,
  FundingRefused,
  type FundingDeps,
} from "./demo-funding.ts";

/**
 * Funds the dedicated demo account of a development or preview database with a
 * ledger-backed opening balance (see scripts/demo-funding.ts for the rules).
 *
 *   node --env-file=<env file> --experimental-strip-types scripts/fund-demo-account.ts
 *
 * The env file holds the TARGET project's values: NEXT_PUBLIC_SUPABASE_URL,
 * SUPABASE_SERVICE_ROLE_KEY, NEXT_PUBLIC_JIMOCEX_DEMO_MODE=true,
 * JIMOCEX_DEMO_ACCOUNT_EMAIL and, for a supabase.co project,
 * JIMOCEX_DEMO_FUNDING_PROJECT_REF. Nothing connects until the guard passes.
 *
 * Exit status: 0 funded (or already funded); 10 refused, nothing written;
 * 1 failed — run it again: what was posted stays posted exactly once.
 */

const guard = checkFundingEnvironment(process.env);
if (!guard.ok) {
  console.error(`STOP: ${guard.reason}. Nothing was funded.`);
  process.exit(10);
}

const { target, email } = guard;
console.log(`Demo funding: ${target.environment} database at ${target.host}`);

const admin = createClient<Database>(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
});

const ZERO = parseMoney("0");

const deps: FundingDeps = {
  async findAccount(address) {
    const { data, error } = await admin.from("profiles").select("user_id, status").eq("email", address).limit(2);
    if (error) throw new Error(`reading profiles failed: ${error.code}`);
    if (!data || data.length === 0) return null;
    if (data.length > 1) throw new FundingRefused("more than one profile has that email; nothing was funded");
    return { userId: data[0]!.user_id, status: data[0]!.status };
  },

  async findAsset(symbol) {
    const { data, error } = await admin.from("assets").select("id, decimals, is_active").eq("symbol", symbol).maybeSingle();
    if (error) throw new Error(`reading asset ${symbol} failed: ${error.code}`);
    return data ? { assetId: data.id, decimals: data.decimals, isActive: data.is_active } : null;
  },

  async findEntry(dedupKey) {
    const { data, error } = await admin.from("ledger_entries").select("id").eq("dedup_key", dedupKey).maybeSingle();
    if (error) throw new Error(`reading the ledger failed: ${error.code}`);
    return data ? { entryId: data.id } : null;
  },

  async postOpeningBalance({ userId, assetId, amount, dedupKey, environment }) {
    const { data, error } = await admin.rpc(
      "ledger_post",
      moneyArgs("ledger_post", {
        p_user_id: userId,
        p_asset_id: assetId,
        p_entry_type: "ADJUSTMENT",
        p_amount: amount,
        p_available_delta: amount,
        p_locked_delta: ZERO,
        p_reference_type: "demo_funding",
        p_dedup_key: dedupKey,
        p_metadata: { purpose: "demo opening balance", environment },
      }),
    );
    if (error) {
      if (error.code === "23505") return { ok: false, reason: "DUPLICATE" };
      throw new Error(`ledger_post failed: ${error.code}`);
    }
    if (!data) throw new Error("ledger_post returned no entry id");
    return { ok: true, entryId: data };
  },

  async hasAuditRecord(entryId) {
    const { data, error } = await admin
      .from("audit_logs")
      .select("id")
      .eq("action", "demo.funding")
      .eq("entity_id", entryId)
      .limit(1);
    if (error) throw new Error(`reading audit_logs failed: ${error.code}`);
    return (data?.length ?? 0) > 0;
  },

  async recordAudit({ entryId, userId, symbol, amount, dedupKey, environment }) {
    const { error } = await admin.from("audit_logs").insert(
      moneyInsert("audit_logs", {
        action: "demo.funding",
        actor_type: "SYSTEM",
        entity_type: "ledger_entry",
        entity_id: entryId,
        metadata: { user_id: userId, asset: symbol, amount: toDecimalString(amount), dedup_key: dedupKey, environment },
      }),
    );
    if (error) throw new Error(`writing audit_logs failed: ${error.code}`);
  },
};

try {
  const { userId, lines } = await ensureDemoAccountFunded(deps, { email, environment: target.environment });
  for (const line of lines) {
    console.log(`  ${line.symbol.padEnd(5)} ${line.amount.padStart(8)}  ${line.outcome}  (ledger entry ${line.entryId})`);
  }

  const { data: wallets, error } = await admin
    .from("wallets")
    .select(moneySelect("wallets", "available_balance, locked_balance, asset:asset_id(symbol)"))
    .eq("user_id", userId)
    .overrideTypes<{ available_balance: string; locked_balance: string; asset: { symbol: string } | null }[], { merge: false }>();
  if (error) throw new Error(`reading wallets failed: ${error.code}`);
  console.log("Balances now (available / locked):");
  for (const w of wallets ?? []) {
    console.log(`  ${(w.asset?.symbol ?? "?").padEnd(5)} ${w.available_balance} / ${w.locked_balance}`);
  }
} catch (error) {
  if (error instanceof FundingRefused) {
    console.error(`STOP: ${error.message}`);
    process.exit(10);
  }
  console.error(`FAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

/**
 * Type-level tests for the re-typed schema (`../database`).
 *
 * Never executed. `npm run typecheck` compiles it, and every
 * `@ts-expect-error` below must find an error on the line that follows — so if
 * the schema ever starts ACCEPTING one of these writes, the directive becomes
 * unused and the typecheck fails. The lines without a directive must compile:
 * they are the sanctioned paths, and a schema that refused everything would
 * pass the first half on its own.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import { ZERO, parseMoney, toDatabase, toDecimalString, type DecimalString } from "@/lib/money";
import type { Database as Generated } from "@/lib/supabase/database.types";

import type { Database } from "../database";
import { moneyArgs, moneyInsert, moneyUpdate } from "../money-write";

declare const db: SupabaseClient<Database>;
const amount = parseMoney("1.5");
const user = "00000000-0000-4000-8000-000000000001";
const asset = "00000000-0000-4000-8000-000000000002";

export async function writes() {
  // @ts-expect-error a JavaScript number is not a money value
  await db.from("deposits").insert({ user_id: user, asset_id: asset, amount: 1.5 });
  // @ts-expect-error nor is an arbitrary string: only toDatabase() makes a DecimalString
  await db.from("deposits").insert({ user_id: user, asset_id: asset, amount: "1.5" });
  // @ts-expect-error nor a raw Money: supabase-js would send its 10^18-scaled digits
  await db.from("deposits").insert({ user_id: user, asset_id: asset, amount });
  // @ts-expect-error nor a DecimalString that skipped the column's range and scale check
  await db.from("fee_rules").update({ percentage: toDecimalString(parseMoney("0.1234565")) });

  await db.from("deposits").insert({ user_id: user, asset_id: asset, amount: toDatabase(amount) });
  await db.from("deposits").insert(moneyInsert("deposits", { user_id: user, asset_id: asset, amount }));
  await db.from("tier_limits").update(moneyUpdate("tier_limits", { max_amount: null }));
}

export async function ledgerOnly() {
  // @ts-expect-error a balance moves only through ledger_post
  await db.from("wallets").update({ available_balance: toDatabase(amount) });
  // @ts-expect-error a ledger row is written only by ledger_post
  await db.from("ledger_entries").insert({ user_id: user, asset_id: asset });
  // @ts-expect-error not even through the write helper
  moneyInsert("wallets", {});
}

export async function generatedColumns() {
  // @ts-expect-error net_amount is computed by PostgreSQL
  await db.from("withdrawals").update({ net_amount: toDatabase(amount) });
  // @ts-expect-error remaining_amount is computed by PostgreSQL
  await db.from("trading_orders").update({ remaining_amount: toDatabase(amount) });
}

export async function filters() {
  await db.from("trades").select("id").eq("amount", toDatabase(parseMoney("0.1")));
  // @ts-expect-error eq() is typed from the row, so a float is refused here
  await db.from("trades").select("id").eq("amount", 0.1);
  // gt/gte/lt/lte also have an untyped `(column: string, value: unknown)`
  // overload in postgrest-js, so the compiler cannot refuse a number there.
  // The static guard does: see the "filter" rule in scripts/money-guard.ts.
  await db.from("trades").select("id").gte("amount", toDatabase(parseMoney("0.1")));
}

export async function rpc() {
  const base = { p_user_id: user, p_asset_id: asset, p_entry_type: "DEPOSIT" as const };

  // @ts-expect-error ledger_post amounts are decimal strings, never numbers
  await db.rpc("ledger_post", { ...base, p_amount: 1, p_available_delta: 1, p_locked_delta: 0 });
  await db.rpc(
    "ledger_post",
    moneyArgs("ledger_post", { ...base, p_amount: amount, p_available_delta: amount, p_locked_delta: ZERO }),
  );

  const { data: total } = await db.rpc("limit_usage_total", {
    p_user_id: user,
    p_operation: "SWAP",
    p_quote_currency: "USD",
    p_since: new Date(0).toISOString(),
  });
  const exact: DecimalString | null = total;

  const { data: quote } = await db.rpc("consume_quote", { p_quote_id: user });
  const rate: DecimalString | undefined = quote?.[0]?.rate;
  // A session-owned quote has no user: the type must admit NULL.
  const owner: string | null | undefined = quote?.[0]?.user_id;

  const { data: drift } = await db.rpc("reconcile_wallets");
  // NULL for a ledger whose wallet row is missing.
  const walletSide: DecimalString | null | undefined = drift?.[0]?.wallet_available;
  // @ts-expect-error so it cannot be treated as always present
  const notNull: DecimalString | undefined = drift?.[0]?.wallet_available;

  return [exact, rate, owner, walletSide, notNull];
}

export async function jsonb() {
  // @ts-expect-error an amount inside a jsonb document is a decimal string, not a number
  await db.from("risk_events").insert({ subject_type: "swap", decision: "REVIEW", details: { amount: 1.5 } });
  await db.from("risk_events").insert({
    subject_type: "swap",
    decision: "REVIEW",
    details: { amount: toDecimalString(amount) },
  });
}

export async function reads() {
  // A literal select with ::text is typed as a string by supabase-js itself.
  const { data } = await db.from("wallets").select("available_balance::text").single();
  const balance: string | undefined = data?.available_balance;
  return balance;
}

/*
 * The generated file must describe the migrations in this repository. If it is
 * ever regenerated from a database that lacks 016/017, these turn back into
 * numbers and the typecheck fails, instead of the re-typing quietly papering
 * over a schema where those values really are JSON numbers.
 */
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type GeneratedFunctions = Generated["public"]["Functions"];

export const consumeQuoteReturnsText: Equal<GeneratedFunctions["consume_quote"]["Returns"][number]["rate"], string> = true;
export const reconcileReturnsText: Equal<GeneratedFunctions["reconcile_wallets"]["Returns"][number]["ledger_available"], string> = true;
export const usageTotalReturnsText: Equal<GeneratedFunctions["limit_usage_total"]["Returns"], string> = true;

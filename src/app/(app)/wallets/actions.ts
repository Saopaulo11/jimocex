"use server";

import { randomUUID } from "node:crypto";

import { revalidatePath } from "next/cache";

import { requireActiveUser } from "@/lib/auth/session";
import { moneySelect } from "@/lib/db/money-columns";
import { moneyInsert } from "@/lib/db/money-write";
import { fromDatabase, lessThan, parseAmountInput, parseMoney } from "@/lib/money";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

/**
 * Wallet Server Actions — the HTTP trust boundary for a withdrawal request.
 *
 * The browser sends only intent: the asset, the network, the destination and
 * the amount as the string the customer typed. It sends NO user id, NO wallet,
 * NO fee and NO status — identity comes from the verified session, the amount is
 * parsed to exact Money on the server, and the row is created at REQUESTED and
 * NEVER advanced to COMPLETED here. No payout provider is connected, so a
 * request is recorded for review; nothing is sent, and no ledger hold is placed
 * (the request does not move or reserve funds on its own).
 *
 * The insert goes through the service-role client because `withdrawals` has no
 * own-insert policy — the same boundary every write crosses. Money is written
 * through `toDatabase`, so no figure is sent as a float.
 */

export type WithdrawInput = {
  assetSymbol: string;
  network: string;
  destination: string;
  amountInput: string;
};

export type WithdrawResult =
  | { ok: true; withdrawalId: string; status: "REQUESTED" }
  | { ok: false; code: WithdrawErrorCode; message: string };

type WithdrawErrorCode =
  | "VALIDATION_FAILED"
  | "UNKNOWN_ASSET"
  | "UNKNOWN_NETWORK"
  | "INSUFFICIENT_BALANCE"
  | "INTERNAL";

const fail = (code: WithdrawErrorCode, message: string): WithdrawResult => ({ ok: false, code, message });

export async function requestWithdrawalAction(input: WithdrawInput): Promise<WithdrawResult> {
  const viewer = await requireActiveUser();
  const supabase = await createClient();

  const destination = input.destination?.trim() ?? "";
  if (destination.length < 4) {
    return fail("VALIDATION_FAILED", "Enter the destination address.");
  }

  // Resolve the asset and its network through the user-scoped client (public
  // reads), so the amount is parsed at the asset's own precision.
  const { data: asset } = await supabase
    .from("assets")
    .select("id, decimals, is_active")
    .eq("symbol", input.assetSymbol)
    .maybeSingle();
  if (!asset || !asset.is_active) return fail("UNKNOWN_ASSET", "That asset is not available for withdrawal.");

  const { data: network } = await supabase
    .from("asset_networks")
    .select("network, address_regex")
    .eq("asset_id", asset.id)
    .eq("network", input.network)
    .maybeSingle();
  if (!network) return fail("UNKNOWN_NETWORK", "That network is not available for this asset.");

  if (network.address_regex) {
    try {
      if (!new RegExp(network.address_regex).test(destination)) {
        return fail("VALIDATION_FAILED", "That destination address is not valid for the selected network.");
      }
    } catch {
      // A malformed stored pattern must not block the request; the provider
      // validates authoritatively anyway.
    }
  }

  const parsed = parseAmountInput(input.amountInput, { maxDecimals: asset.decimals });
  if (!parsed.ok) {
    return fail("VALIDATION_FAILED", amountProblem(parsed.problem));
  }
  const amount = parsed.value;

  // Soft balance check (no hold is placed): a request may not exceed what the
  // customer currently holds. The ledger remains the authority.
  const { data: wallet } = await supabase
    .from("wallets")
    .select(moneySelect("wallets", "available_balance"))
    .eq("asset_id", asset.id)
    .maybeSingle()
    .overrideTypes<{ available_balance: string }, { merge: false }>();
  const available = wallet ? fromDatabase(wallet.available_balance, "wallets.available_balance") : parseMoney("0");
  if (lessThan(available, amount)) {
    return fail("INSUFFICIENT_BALANCE", "The amount is more than your available balance.");
  }

  try {
    const admin = createAdminClient();
    const { data, error } = await admin
      .from("withdrawals")
      .insert(
        moneyInsert("withdrawals", {
          user_id: viewer.userId,
          asset_id: asset.id,
          network: input.network,
          amount,
          fee: parseMoney("0"),
          destination,
          idempotency_key: randomUUID(),
          status: "REQUESTED",
        }),
      )
      .select("id, status")
      .single();

    if (error || !data) return fail("INTERNAL", "The request could not be recorded. Please try again.");

    revalidatePath("/wallets/withdraw");
    revalidatePath("/wallets");
    return { ok: true, withdrawalId: data.id, status: "REQUESTED" };
  } catch {
    return fail("INTERNAL", "The request could not be recorded. Please try again.");
  }
}

function amountProblem(problem: string): string {
  switch (problem) {
    case "empty":
      return "Enter an amount.";
    case "too_many_decimals":
      return "That amount has more decimal places than this asset supports.";
    case "too_large":
      return "That amount is too large.";
    case "not_positive":
      return "Enter an amount greater than zero.";
    default:
      return "Enter a valid amount (digits and a decimal point only).";
  }
}

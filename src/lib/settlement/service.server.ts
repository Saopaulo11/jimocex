import "server-only";

import { moneySelect } from "@/lib/db/money-columns";
import { moneyArgs } from "@/lib/db/money-write";
import { fromDatabase } from "@/lib/money";
import { createAdminClient } from "@/lib/supabase/admin";

import { SettlementService } from "./service";
import type { ApplyFillInput, SettlementGateway, SettlementOrder } from "./types";

/**
 * The real wiring for the settlement service (Slice 6C).
 *
 * `service.ts` is a pure orchestrator over a `SettlementGateway`. This module is
 * the only place that gateway touches the outside world — the service-role
 * database — and it holds no decision logic. It is `server-only`, so it can
 * never reach the browser bundle, and the browser can never call `apply_fill`.
 *
 * Every money argument crosses through `moneyArgs("apply_fill", …)`, the same
 * boundary every money RPC uses, so no figure is sent as a float; `apply_fill`
 * (migration 020) remains the single atomic settlement operation. This module
 * writes no wallets and no ledger entries itself.
 *
 * NOTE: nothing calls this yet. No execution venue is connected, so no
 * `ExecutionFill` is ever produced in this deployment; a reserved LIMIT order
 * stays OPEN. This is the primitive a future execution orchestration will call
 * once a concrete LP adapter exists — it is deliberately not wired into the
 * Order Engine, and it never fabricates a fill.
 */

type Admin = ReturnType<typeof createAdminClient>;

function buildGateway(admin: Admin): SettlementGateway {
  return {
    async resolveOrderByExternalId(externalOrderId) {
      // The venue's order id was persisted to provider_order_id when the order
      // was submitted; this is the only way the internal order is identified.
      const { data, error } = await admin
        .from("trading_orders")
        .select(moneySelect("trading_orders", "id, side, status, amount, filled_amount"))
        .eq("provider_order_id", externalOrderId)
        .maybeSingle()
        .overrideTypes<
          { id: string; side: "BUY" | "SELL"; status: SettlementOrder["status"]; amount: string; filled_amount: string },
          { merge: false }
        >();
      if (error || !data) return null;
      return {
        orderId: data.id,
        side: data.side,
        status: data.status,
        amount: fromDatabase(data.amount, "trading_orders.amount"),
        filledAmount: fromDatabase(data.filled_amount, "trading_orders.filled_amount"),
      };
    },

    async listSettledFills(orderId) {
      // Read-only: the settled state a cumulative delta is derived from. A read
      // failure throws — settling without knowing what is settled is not an option.
      const { data, error } = await admin
        .from("trades")
        .select(moneySelect("trades", "provider_trade_id, amount, quote_amount, fee"))
        .or(`buy_order_id.eq.${orderId},sell_order_id.eq.${orderId}`)
        .overrideTypes<
          { provider_trade_id: string | null; amount: string; quote_amount: string; fee: string }[],
          { merge: false }
        >();
      if (error || !data) throw new Error("settled fills could not be read");
      return data.map((row) => ({
        // apply_fill always sets it; an empty id never matches a venue's.
        providerTradeId: row.provider_trade_id ?? "",
        base: fromDatabase(row.amount, "trades.amount"),
        quote: fromDatabase(row.quote_amount, "trades.quote_amount"),
        fee: fromDatabase(row.fee, "trades.fee"),
      }));
    },

    async resolveAssetId(symbol) {
      const { data, error } = await admin
        .from("assets")
        .select("id")
        .eq("symbol", symbol)
        .maybeSingle();
      if (error || !data) return null;
      return data.id;
    },

    async findTradeByProviderTradeId(providerTradeId) {
      const { data, error } = await admin
        .from("trades")
        .select("id")
        .eq("provider_trade_id", providerTradeId)
        .maybeSingle();
      if (error || !data) return null;
      return data.id;
    },

    async applyFill(input: ApplyFillInput) {
      const { data, error } = await admin.rpc(
        "apply_fill",
        moneyArgs("apply_fill", {
          p_order_id: input.orderId,
          p_provider_trade_id: input.providerTradeId,
          p_base_amount: input.baseAmount,
          p_quote_amount: input.quoteAmount,
          p_execution_price: input.executionPrice,
          p_fee_amount: input.feeAmount,
          p_fee_asset_id: input.feeAssetId,
          p_executed_at: input.executedAt.toISOString(),
        }),
      );
      if (error) return { ok: false, code: error.code, message: error.message };
      if (!data) return { ok: false, code: null, message: "apply_fill returned no trade id" };
      return { ok: true, tradeId: data };
    },
  };
}

/** The settlement service over a fresh service-role client (one per call). */
export function getSettlementService(): SettlementService {
  return new SettlementService(buildGateway(createAdminClient()));
}

export { SettlementService } from "./service";
export type { SettlementResult, SettlementFailure, SettlementFailureCode } from "./types";

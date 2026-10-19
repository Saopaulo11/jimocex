import "server-only";

import { moneySelect } from "@/lib/db/money-columns";
import { moneyArgs } from "@/lib/db/money-write";
import { fromDatabase, fromDatabaseNullable } from "@/lib/money";
import { createAdminClient } from "@/lib/supabase/admin";

import type { OrderLifecycleGateway } from "./coordinator";
import { phaseFromStatus } from "./lifecycle";
import type { OrderSide, OrderStatus, OrderType } from "./types";

/**
 * The database side of the coordinator's lifecycle port (Slice 14B) — one
 * service-role call per method, onto migration 022's primitives:
 *
 *   claimSubmission        → claim_order_for_submission   (atomic OPEN → SUBMITTED)
 *   recordExternalOrderId  → record_provider_order_id     (compare-and-set)
 *   finalizeAfterVenueEnd  → finalize_venue_cancellation  (venue-confirmed remainder release)
 *
 * It holds no decision logic and writes no table itself: every write is one of
 * those functions, which re-check everything atomically. `server-only`, so it
 * can never reach the browser bundle.
 *
 * NOT WIRED. Nothing imports this yet — no execution venue is connected, and
 * migration 022 is applied to no database. A failed call throws: the
 * coordinator then stops with the order's funds still reserved.
 */

type Admin = ReturnType<typeof createAdminClient>;

type OrderRow = {
  id: string;
  user_id: string;
  side: OrderSide;
  type: OrderType;
  status: OrderStatus;
  price: string | null;
  amount: string;
  filled_amount: string;
  locked_amount: string;
  provider_order_id: string | null;
  pair: { symbol: string } | null;
};

export function createLifecycleGateway(admin: Admin = createAdminClient()): OrderLifecycleGateway {
  return {
    async loadOrder(orderId) {
      const { data, error } = await admin
        .from("trading_orders")
        .select(
          moneySelect(
            "trading_orders",
            "id, user_id, side, type, status, price, amount, filled_amount, locked_amount, provider_order_id, pair:pair_id(symbol)",
          ),
        )
        .eq("id", orderId)
        .maybeSingle()
        .overrideTypes<OrderRow, { merge: false }>();
      if (error) throw new Error("the order could not be read");
      if (!data) return null;
      const phase = phaseFromStatus(data.status);
      // A status outside the lifecycle (PENDING) is never acted on.
      if (phase === null || !data.pair) throw new Error("the order is outside the execution lifecycle");
      return {
        orderId: data.id,
        userId: data.user_id,
        pair: data.pair.symbol,
        side: data.side,
        type: data.type,
        phase,
        price: fromDatabaseNullable(data.price, "trading_orders.price"),
        amount: fromDatabase(data.amount, "trading_orders.amount"),
        filledAmount: fromDatabase(data.filled_amount, "trading_orders.filled_amount"),
        lockedAmount: fromDatabase(data.locked_amount, "trading_orders.locked_amount"),
        externalOrderId: data.provider_order_id,
      };
    },

    async claimSubmission({ orderId, userId }) {
      const { data, error } = await admin.rpc("claim_order_for_submission", { p_user_id: userId, p_order_id: orderId });
      if (error) throw new Error("the submission claim failed");
      // The id of the order this caller moved, or null: someone else got there first.
      return data === orderId;
    },

    async recordExternalOrderId({ orderId, userId }, externalOrderId) {
      const { data, error } = await admin.rpc("record_provider_order_id", {
        p_user_id: userId,
        p_order_id: orderId,
        p_provider_order_id: externalOrderId,
      });
      if (error) throw new Error("the venue order id could not be recorded");
      if (data === "RECORDED" || data === "ALREADY_RECORDED" || data === "CONFLICT") return data;
      throw new Error("unexpected answer recording the venue order id");
    },

    async finalizeAfterVenueEnd(orderId, end) {
      const { data, error } = await admin.rpc(
        "finalize_venue_cancellation",
        moneyArgs("finalize_venue_cancellation", {
          p_order_id: orderId,
          p_provider_order_id: end.externalOrderId,
          p_venue_status: end.venueStatus,
          p_venue_filled_amount: end.venueFilled,
        }),
      );
      if (error) throw new Error("the venue-confirmed release failed");
      if (data === "FINALIZED" || data === "ALREADY_FINALIZED") return data;
      // TERMINAL, NOT_SUBMITTED, VENUE_ORDER_MISMATCH, FILLED_MISMATCH: nothing released.
      return "REFUSED";
    },
  };
}

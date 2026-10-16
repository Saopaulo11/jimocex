import { isPositive, parseMoney } from "../money.ts";
import type { ExecutionFill } from "../execution/types.ts";

import { classifyApplyFillError, mapExecutionFillToApplyFill } from "./types.ts";
import type { SettlementGateway, SettlementResult } from "./types.ts";

/**
 * Settlement service (Slice 6C) — the seam between a validated execution fill
 * and the atomic SQL `apply_fill`.
 *
 *   ExecutionProvider → ExecutionService → SettlementService → apply_fill → ledger
 *
 * Pure orchestration over an injected `SettlementGateway`, so it is tested with
 * a deterministic double and no database. It holds no credentials and moves no
 * money: `apply_fill` is the only financial operation, and the ledger is the
 * source of truth. The real gateway lives behind `server-only` in
 * `service.server.ts`.
 *
 * Order identity is resolved HERE from the fill's external order id — the
 * service never accepts an internal order id, a user id, a wallet, a fee or a
 * settlement amount from a caller. A fill whose external order id maps to no
 * internal order is ORDER_NOT_FOUND, not a chance to settle an arbitrary order.
 */
export class SettlementService {
  private readonly gateway: SettlementGateway;

  constructor(gateway: SettlementGateway) {
    this.gateway = gateway;
  }

  /**
   * Settles exactly ONE concrete fill. Idempotent: a fill whose
   * `externalFillId` is already a trade returns DUPLICATE and calls nothing.
   * A cumulative snapshot must be turned into a discrete fill (with its own
   * `externalFillId`) by the adapter first — see `deriveFillDelta`.
   */
  async settleFill(fill: ExecutionFill): Promise<SettlementResult> {
    try {
      const order = await this.gateway.resolveOrderByExternalId(fill.externalOrderId);
      if (!order) return classifyApplyFillError({ code: "23503", message: "unknown order" });

      // A fill whose side disagrees with the order is a provider inconsistency.
      if (order.side !== fill.side) {
        return {
          code: "INVALID_FILL",
          message: "The execution report is not a valid fill for this order.",
          retryable: false,
          reconcile: true,
        };
      }

      // Idempotency: a fill already settled returns its trade, touches nothing.
      const existing = await this.gateway.findTradeByProviderTradeId(fill.externalFillId);
      if (existing) return { code: "DUPLICATE", tradeId: existing };

      // Resolve the fee asset only when there is a fee; a zero fee has no asset.
      let feeAssetId: string | null = null;
      if (isPositive(parseMoney(fill.fee))) {
        feeAssetId = await this.gateway.resolveAssetId(fill.feeAsset);
        if (!feeAssetId) {
          return {
            code: "INVALID_FEE",
            message: "The fill's fee is not valid for this market.",
            retryable: false,
            reconcile: false,
          };
        }
      }

      const input = mapExecutionFillToApplyFill(fill, { orderId: order.orderId, feeAssetId });
      const applied = await this.gateway.applyFill(input);
      if (applied.ok) return { code: "SUCCESS", tradeId: applied.tradeId };
      return classifyApplyFillError(applied);
    } catch {
      // A gateway that throws (transport failure) is transient and retryable;
      // the raw error is never surfaced.
      return classifyApplyFillError({ code: null, message: null });
    }
  }
}

// Re-export the result taxonomy so a caller imports one module.
export type { SettlementResult, SettlementFailure, SettlementFailureCode } from "./types.ts";

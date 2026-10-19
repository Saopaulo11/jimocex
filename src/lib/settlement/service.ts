import { isPositive, parseMoney } from "../money.ts";
import type { ExecutionFill, ExecutionSnapshot } from "../execution/types.ts";

import { checkDiscreteFill, deriveCumulativeFill, type FillTarget } from "./fills.ts";
import { classifyApplyFillError, failureForFillProblem, mapExecutionFillToApplyFill } from "./types.ts";
import type { SettlementGateway, SettlementOrder, SettlementResult } from "./types.ts";

/**
 * Settlement service (Slice 6C, extended in 14A) — the seam between a venue's
 * execution report and the atomic SQL `apply_fill`.
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
 * Only an order that carries a venue order id can be found (and 022 lets one be
 * recorded only on a SUBMITTED order), and an OPEN order is refused outright,
 * as apply_fill refuses it — no OPEN → FILLED.
 *
 * Two entry points, one settlement path:
 *   * `settleFill`     — a discrete venue fill, settled under the venue's trade id;
 *   * `settleSnapshot` — a cumulative snapshot, from which the not-yet-settled
 *                        fill is derived against PERSISTED settled totals
 *                        (`deriveCumulativeFill`), then settled the same way.
 */
const TERMINAL_STATUSES: readonly SettlementOrder["status"][] = ["FILLED", "CANCELLED", "REJECTED", "EXPIRED"];
/** Never handed to a venue: apply_fill (022) refuses them, so settlement does first. */
const UNSUBMITTED_STATUSES: readonly SettlementOrder["status"][] = ["PENDING", "OPEN"];

function targetOf(order: SettlementOrder): FillTarget {
  return {
    side: order.side,
    amount: order.amount,
    filledAmount: order.filledAmount,
    terminal: TERMINAL_STATUSES.includes(order.status),
    submitted: !UNSUBMITTED_STATUSES.includes(order.status),
  };
}

export class SettlementService {
  private readonly gateway: SettlementGateway;

  constructor(gateway: SettlementGateway) {
    this.gateway = gateway;
  }

  /**
   * Settles exactly ONE concrete fill. Idempotent: a fill whose
   * `externalFillId` is already a trade returns DUPLICATE and calls nothing.
   * A cumulative snapshot goes through `settleSnapshot` instead.
   */
  async settleFill(fill: ExecutionFill): Promise<SettlementResult> {
    try {
      const order = await this.gateway.resolveOrderByExternalId(fill.externalOrderId);
      if (!order) return classifyApplyFillError({ code: "23503", message: "unknown order" });

      // A fill whose side disagrees with the order is a provider inconsistency.
      if (order.side !== fill.side) return failureForFillProblem("SIDE_MISMATCH");

      // Idempotency first, as apply_fill does: a replayed fill returns its trade
      // even once the order is terminal, and touches nothing.
      const existing = await this.gateway.findTradeByProviderTradeId(fill.externalFillId);
      if (existing) return { code: "DUPLICATE", tradeId: existing };

      const settled = await this.gateway.listSettledFills(order.orderId);
      const check = checkDiscreteFill(targetOf(order), fill, settled);
      if (!check.ok) return failureForFillProblem(check.problem);

      return await this.apply(order, fill);
    } catch {
      // A gateway that throws (transport failure) is transient and retryable;
      // the raw error is never surfaced.
      return classifyApplyFillError({ code: null, message: null });
    }
  }

  /**
   * Settles whatever a cumulative snapshot adds to the order's settled totals:
   * nothing (NOTHING_NEW) for a replayed or caught-up snapshot, a refusal for one
   * that runs backwards (STALE_SNAPSHOT) or past the order (OVER_FILL), else the
   * single derived fill — whose id makes a concurrent or repeated derivation from
   * the same settled state a DUPLICATE.
   */
  async settleSnapshot(snapshot: ExecutionSnapshot): Promise<SettlementResult> {
    try {
      const order = await this.gateway.resolveOrderByExternalId(snapshot.externalOrderId);
      if (!order) return classifyApplyFillError({ code: "23503", message: "unknown order" });

      const settled = await this.gateway.listSettledFills(order.orderId);
      const derived = deriveCumulativeFill(targetOf(order), snapshot, settled);
      if (derived.kind === "NOTHING_NEW") return { code: "NOTHING_NEW" };
      if (derived.kind === "REJECT") return failureForFillProblem(derived.problem);

      const existing = await this.gateway.findTradeByProviderTradeId(derived.fill.externalFillId);
      if (existing) return { code: "DUPLICATE", tradeId: existing };

      return await this.apply(order, derived.fill);
    } catch {
      return classifyApplyFillError({ code: null, message: null });
    }
  }

  /** The one place a fill reaches `apply_fill`. */
  private async apply(order: SettlementOrder, fill: ExecutionFill): Promise<SettlementResult> {
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
  }
}

// Re-export the result taxonomy so a caller imports one module.
export type { SettlementResult, SettlementFailure, SettlementFailureCode } from "./types.ts";

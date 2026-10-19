import { ZERO, isPositive, parseMoney, subtractMoney, toDecimalString, type Money } from "../money.ts";
import type { SettlementResult } from "../settlement/types.ts";

import {
  checkOrderRecord,
  classifyVenueStatus,
  decideFinalization,
  isTerminalPhase,
  type OrderRecord,
} from "./lifecycle.ts";
import type { ExecutionResult, ExecutionService } from "./service.ts";
import {
  venueClientOrderIdFor,
  type ExecutionFill,
  type ExecutionOrderAck,
  type ExecutionOrderRequest,
  type ExecutionOrderView,
  type ExecutionSnapshot,
  type ExternalOrderRef,
} from "./types.ts";

/**
 * Order execution coordinator (Slice 14A) — drives one internal order through
 * the provider boundary: submit, request a cancel, reconcile with the venue.
 * Pure orchestration over injected ports; no I/O of its own.
 *
 * NOT WIRED. Nothing in the application constructs this class: no venue is
 * connected. Its persistence port maps one to one onto migration 022's
 * primitives (`lifecycle-gateway.server.ts`) — claim_order_for_submission,
 * record_provider_order_id, finalize_venue_cancellation — which exist in the
 * repository but are applied to no database yet.
 *
 * What it guarantees:
 *   * a venue's answer moves no money. Acceptance is not a fill; a cancel the
 *     venue accepted releases nothing. Money moves only through settlement
 *     (`apply_fill`) and the remainder release, both behind ports, both
 *     validated against persisted state;
 *   * one venue order per internal order: an order is claimed (OPEN →
 *     SUBMITTED) before the venue is called, a claim lost to a concurrent submit
 *     or cancel calls nothing, and every request for the order carries the same
 *     venue reference (`venueClientOrderIdFor`);
 *   * an ambiguous answer (timeout, dropped connection, unknown status) is never
 *     read as success or rejection: the order stays SUBMITTED with its funds
 *     reserved until `reconcile` reads the venue's truth;
 *   * the remainder is released only when the venue says the order has ended AND
 *     every venue fill is settled — so the reservation behind an executed fill
 *     can never be handed back.
 */

/** The venue's final word on an order whose remainder may be released. */
export type VenueEnd = {
  /** The venue order the confirmation is about; null only when no venue ever acknowledged one. */
  externalOrderId: string | null;
  venueStatus: "CANCELLED" | "REJECTED" | "EXPIRED";
  /** The venue's FINAL cumulative filled base — compared, in the database, with what is settled. */
  venueFilled: Money;
};

/** The persisted-state port the coordinator needs (migration 022). Every write is atomic and idempotent. */
export interface OrderLifecycleGateway {
  loadOrder(orderId: string): Promise<OrderRecord | null>;
  /**
   * Atomic OPEN → SUBMITTED of this user's order, exclusive with the customer's
   * cancel: true only for the one caller that moved it (claim_order_for_submission).
   */
  claimSubmission(order: { orderId: string; userId: string }): Promise<boolean>;
  /** Compare-and-set of the venue's order id (record_provider_order_id). */
  recordExternalOrderId(
    order: { orderId: string; userId: string },
    externalOrderId: string,
  ): Promise<"RECORDED" | "ALREADY_RECORDED" | "CONFLICT">;
  /**
   * Releases what the order still holds and marks it CANCELLED — only while the
   * order is submitted, the confirmation names its venue order, and the venue's
   * final cumulative equals what is settled (finalize_venue_cancellation). It
   * takes no amount: the database releases whatever is still locked.
   */
  finalizeAfterVenueEnd(orderId: string, end: VenueEnd): Promise<"FINALIZED" | "ALREADY_FINALIZED" | "REFUSED">;
}

/** The settlement port (`SettlementService` satisfies it). */
export interface FillSettlement {
  settleFill(fill: ExecutionFill): Promise<SettlementResult>;
  settleSnapshot(snapshot: ExecutionSnapshot): Promise<SettlementResult>;
}

export type SubmitOutcome =
  /** The venue holds the order. `fillsReported`: its ack already mentions fills — settle them via reconcile, never from the ack. */
  | { kind: "SUBMITTED"; externalOrderId: string; fillsReported: boolean }
  | { kind: "ALREADY_SUBMITTED" }
  | { kind: "NOT_CONNECTED" }
  | { kind: "NOT_SUBMITTABLE"; reason: string }
  /** A concurrent submit or the customer's cancel moved the order first; the venue was not called. */
  | { kind: "CLAIM_LOST" }
  /** The venue refused it. Funds stay reserved; reconcile confirms with the venue before anything is released. */
  | { kind: "REJECTED_BY_VENUE" }
  /** The venue's state is not proven. Funds stay reserved; reconcile with the same venue reference. */
  | { kind: "UNRESOLVED"; reason: string }
  | { kind: "INCIDENT"; reason: string };

export type CancelOutcome =
  /** OPEN: no venue order exists — the order engine's own cancel applies. */
  | { kind: "NOT_SUBMITTED" }
  | { kind: "ALREADY_FILLED" }
  | { kind: "ALREADY_CANCELLED" }
  | { kind: "ALREADY_TERMINAL" }
  /** The venue accepted the request. Nothing is released: the order may still fill until the venue confirms. */
  | { kind: "CANCEL_REQUESTED" }
  /** The venue says the order ended: reconcile settles its fills, then releases the remainder. */
  | { kind: "VENUE_ENDED" }
  /** Too late — the venue filled it: reconcile settles the fills; nothing is released. */
  | { kind: "FILLED_AT_VENUE" }
  /** The venue refused to cancel; the order continues and nothing is released. */
  | { kind: "CANCEL_REJECTED" }
  | { kind: "UNRESOLVED"; reason: string }
  | { kind: "NOT_FOUND" }
  | { kind: "INCIDENT"; reason: string };

export type ReconcileOutcome =
  | { kind: "NOT_SUBMITTED" }
  | { kind: "TERMINAL" }
  | { kind: "NOT_FOUND" }
  /** The venue may still execute; `settled` fills were settled this pass. */
  | { kind: "IN_PROGRESS"; settled: number }
  | { kind: "FILLED"; settled: number }
  /** The venue ended the order; every fill is settled and the remainder was released. */
  | { kind: "RELEASED"; settled: number }
  /** The venue executed more than could be settled yet — nothing released. */
  | { kind: "PENDING_FILLS"; settled: number }
  /** The venue never received the order: it was resent under the same venue reference. */
  | { kind: "RESUBMITTED"; outcome: SubmitOutcome }
  | { kind: "UNRESOLVED"; reason: string }
  | { kind: "INCIDENT"; reason: string };

/**
 * The venue request for an order: identity and intent only. Null for anything a
 * venue must not receive — a MARKET order, or nothing left to fill.
 */
export function buildSubmitRequest(order: OrderRecord): ExecutionOrderRequest | null {
  if (order.type !== "LIMIT" || order.price === null) return null;
  const remaining = subtractMoney(order.amount, order.filledAmount);
  if (!isPositive(remaining)) return null;
  return {
    internalOrderId: order.orderId,
    clientOrderId: venueClientOrderIdFor(order.orderId),
    pair: order.pair,
    side: order.side,
    type: "LIMIT",
    price: toDecimalString(order.price),
    amount: toDecimalString(order.amount),
    remainingAmount: toDecimalString(remaining),
  };
}

/** How the venue is addressed for an order: its own id once known, else our reference. */
function venueRef(order: OrderRecord): ExternalOrderRef {
  return order.externalOrderId !== null
    ? { externalOrderId: order.externalOrderId }
    : { clientOrderId: venueClientOrderIdFor(order.orderId) };
}

/** A cumulative venue's totals as a snapshot, or null when the view lacks them. */
export function snapshotFromView(view: ExecutionOrderView, order: OrderRecord, observedAt: Date): ExecutionSnapshot | null {
  if (view.cumulativeQuote === undefined || view.cumulativeFee === undefined || view.feeAsset === undefined) return null;
  return {
    externalOrderId: view.externalOrderId,
    side: order.side,
    status: view.status,
    cumulativeBase: view.filledAmount,
    cumulativeQuote: view.cumulativeQuote,
    cumulativeFee: view.cumulativeFee,
    feeAsset: view.feeAsset,
    observedAt,
  };
}

function finalizationOutcome(result: "FINALIZED" | "ALREADY_FINALIZED" | "REFUSED", settled: number): ReconcileOutcome {
  switch (result) {
    case "FINALIZED":
      return { kind: "RELEASED", settled };
    case "ALREADY_FINALIZED":
      return { kind: "TERMINAL" };
    case "REFUSED":
      // The database found the order changed, or the venue's figure unsettled.
      return { kind: "UNRESOLVED", reason: "the database refused the release — reconcile again" };
  }
}

export class OrderExecutionCoordinator {
  private readonly execution: ExecutionService;
  private readonly gateway: OrderLifecycleGateway;
  private readonly settlement: FillSettlement;
  private readonly now: () => Date;

  constructor(deps: {
    execution: ExecutionService;
    gateway: OrderLifecycleGateway;
    settlement: FillSettlement;
    now?: () => Date;
  }) {
    this.execution = deps.execution;
    this.gateway = deps.gateway;
    this.settlement = deps.settlement;
    this.now = deps.now ?? (() => new Date());
  }

  /** Sends an OPEN order to the venue, at most once. */
  async submit(orderId: string): Promise<SubmitOutcome> {
    const order = await this.gateway.loadOrder(orderId);
    if (!order) return { kind: "NOT_SUBMITTABLE", reason: "unknown order" };
    const consistent = checkOrderRecord(order);
    if (!consistent.ok) return { kind: "INCIDENT", reason: consistent.problem };

    switch (order.phase) {
      case "SUBMITTED":
        return order.externalOrderId !== null
          ? { kind: "ALREADY_SUBMITTED" }
          : { kind: "UNRESOLVED", reason: "an earlier submission is unresolved — reconcile, do not resubmit" };
      case "PARTIALLY_FILLED":
        return { kind: "ALREADY_SUBMITTED" };
      case "OPEN":
        break;
      default:
        return { kind: "NOT_SUBMITTABLE", reason: `the order is ${order.phase}` };
    }

    const request = buildSubmitRequest(order);
    if (!request) return { kind: "NOT_SUBMITTABLE", reason: "only a LIMIT order with an unfilled amount can be submitted" };
    // Checked before the claim: a deployment with no venue never moves an order.
    if (!this.execution.isConfigured()) return { kind: "NOT_CONNECTED" };
    if (!(await this.gateway.claimSubmission(order))) return { kind: "CLAIM_LOST" };

    return this.afterSubmit(order, await this.execution.submitOrder(request));
  }

  /** Asks the venue to cancel. Releases nothing itself — `reconcile` does, once the venue confirms. */
  async requestCancel(orderId: string): Promise<CancelOutcome> {
    const order = await this.gateway.loadOrder(orderId);
    if (!order) return { kind: "NOT_FOUND" };
    const consistent = checkOrderRecord(order);
    if (!consistent.ok) return { kind: "INCIDENT", reason: consistent.problem };

    switch (order.phase) {
      case "OPEN":
        return { kind: "NOT_SUBMITTED" };
      case "FILLED":
        return { kind: "ALREADY_FILLED" };
      case "CANCELLED":
        return { kind: "ALREADY_CANCELLED" };
      case "REJECTED":
      case "EXPIRED":
        return { kind: "ALREADY_TERMINAL" };
      case "SUBMITTED":
      case "PARTIALLY_FILLED":
        break;
    }

    const result = await this.execution.cancelOrder(venueRef(order));
    if (!result.ok) {
      if (result.error.kind === "REJECTED") return { kind: "CANCEL_REJECTED" };
      return { kind: "UNRESOLVED", reason: `cancel ${result.error.kind}` };
    }
    switch (classifyVenueStatus(result.value.status)) {
      case "LIVE":
        return { kind: "CANCEL_REQUESTED" };
      case "FILLED":
        return { kind: "FILLED_AT_VENUE" };
      case "ENDED":
        return { kind: "VENUE_ENDED" };
      case "UNKNOWN":
        return { kind: "UNRESOLVED", reason: "the venue answered the cancel with an unknown status" };
    }
  }

  /**
   * Reads the venue's truth for a submitted order, settles every fill it reports
   * that is not settled yet, and — only if the venue says the order ended and
   * nothing it executed is left unsettled — releases the remainder.
   */
  async reconcile(orderId: string): Promise<ReconcileOutcome> {
    const order = await this.gateway.loadOrder(orderId);
    if (!order) return { kind: "NOT_FOUND" };
    const consistent = checkOrderRecord(order);
    if (!consistent.ok) return { kind: "INCIDENT", reason: consistent.problem };
    if (order.phase === "OPEN") return { kind: "NOT_SUBMITTED" };
    if (isTerminalPhase(order.phase)) return { kind: "TERMINAL" };

    const viewed = await this.execution.getOrder(venueRef(order));
    if (!viewed.ok) {
      if (viewed.error.kind === "UNKNOWN_ORDER" && !viewed.error.ambiguous) {
        if (order.externalOrderId !== null) return { kind: "INCIDENT", reason: "the venue no longer knows an order it acknowledged" };
        // The venue holds no order under our reference. Resend it under the SAME
        // reference — idempotent at the venue — rather than guessing either way.
        const request = buildSubmitRequest(order);
        if (!request) return { kind: "INCIDENT", reason: "a submitted order has nothing to resend" };
        const outcome = await this.afterSubmit(order, await this.execution.submitOrder(request));
        if (outcome.kind !== "REJECTED_BY_VENUE") return { kind: "RESUBMITTED", outcome };
        // No venue order exists and the venue refuses this very request: nothing
        // can execute under it, so the venue's cumulative is zero and the
        // (wholly unfilled) reservation may be released.
        const finalized = await this.gateway.finalizeAfterVenueEnd(order.orderId, {
          externalOrderId: null,
          venueStatus: "REJECTED",
          venueFilled: ZERO,
        });
        return finalizationOutcome(finalized, 0);
      }
      return { kind: "UNRESOLVED", reason: `venue read ${viewed.error.kind}` };
    }
    const view = viewed.value;

    if (order.externalOrderId === null) {
      const recorded = await this.gateway.recordExternalOrderId(order, view.externalOrderId);
      if (recorded === "CONFLICT") return { kind: "INCIDENT", reason: "the order already carries a different venue id" };
    } else if (view.externalOrderId !== order.externalOrderId) {
      return { kind: "INCIDENT", reason: "the venue answered for a different order" };
    }

    const settledNow = await this.settleReported(order, view);
    if (settledNow.kind !== "OK") return settledNow.outcome;
    const settled = settledNow.settled;

    // Decide on the state settlement just wrote, never on the earlier read.
    const after = await this.gateway.loadOrder(order.orderId);
    if (!after) return { kind: "INCIDENT", reason: "the order disappeared during reconciliation" };
    const afterOk = checkOrderRecord(after);
    if (!afterOk.ok) return { kind: "INCIDENT", reason: afterOk.problem };

    let venueFilled: Money;
    try {
      venueFilled = parseMoney(view.filledAmount);
    } catch {
      return { kind: "UNRESOLVED", reason: "the venue's filled amount is not an exact decimal" };
    }

    const decision = decideFinalization({
      phase: after.phase,
      amount: after.amount,
      internalFilled: after.filledAmount,
      venueStatus: view.status,
      venueFilled,
    });
    switch (decision.kind) {
      case "ALREADY_TERMINAL":
        return after.phase === "FILLED" ? { kind: "FILLED", settled } : { kind: "TERMINAL" };
      case "NOTHING_TO_RELEASE":
        return { kind: "FILLED", settled };
      case "NOT_ENDED":
        return { kind: "IN_PROGRESS", settled };
      case "SETTLE_MISSING_FILLS":
        return { kind: "PENDING_FILLS", settled };
      case "UNRESOLVED":
        return { kind: "UNRESOLVED", reason: "the venue reported an unknown status" };
      case "INCIDENT":
        return { kind: "INCIDENT", reason: decision.reason };
      case "RELEASE_REMAINDER": {
        if (view.status !== "CANCELLED" && view.status !== "REJECTED" && view.status !== "EXPIRED") {
          return { kind: "INCIDENT", reason: "a release was decided on a venue status that has not ended" };
        }
        // The VENUE's final cumulative goes to the database, which compares it
        // with what is settled itself — not the internal figure, which would make
        // that comparison a tautology.
        const finalized = await this.gateway.finalizeAfterVenueEnd(after.orderId, {
          externalOrderId: after.externalOrderId,
          venueStatus: view.status,
          venueFilled,
        });
        return finalizationOutcome(finalized, settled);
      }
    }
  }

  // -------------------------------------------------------------------------

  /** Interprets a placement answer. Never moves money; at most records the venue's id. */
  private async afterSubmit(order: OrderRecord, result: ExecutionResult<ExecutionOrderAck>): Promise<SubmitOutcome> {
    if (!result.ok) {
      if (result.error.kind === "REJECTED" && !result.error.ambiguous) return { kind: "REJECTED_BY_VENUE" };
      // Timeout, network, duplicate, rate limit, provider error: the venue may or
      // may not hold the order. Neither success nor rejection is assumed.
      return { kind: "UNRESOLVED", reason: `submit ${result.error.kind}` };
    }
    const ack = result.value;
    const venueClass = classifyVenueStatus(ack.status);
    if (venueClass === "UNKNOWN") return { kind: "UNRESOLVED", reason: "the venue acknowledged with an unknown status" };
    if (ack.status === "REJECTED") return { kind: "REJECTED_BY_VENUE" };
    if (ack.externalOrderId.trim() === "") return { kind: "UNRESOLVED", reason: "the venue acknowledged without an order id" };

    const recorded = await this.gateway.recordExternalOrderId(order, ack.externalOrderId);
    if (recorded === "CONFLICT") return { kind: "INCIDENT", reason: "the order already carries a different venue id" };
    if (venueClass === "ENDED") return { kind: "UNRESOLVED", reason: "the venue ended the order on acceptance — reconcile" };
    return {
      kind: "SUBMITTED",
      externalOrderId: ack.externalOrderId,
      fillsReported: ack.status === "PARTIALLY_FILLED" || ack.status === "FILLED",
    };
  }

  /** Settles what the venue reports, in the venue's one reporting mode. */
  private async settleReported(
    order: OrderRecord,
    view: ExecutionOrderView,
  ): Promise<{ kind: "OK"; settled: number } | { kind: "STOP"; outcome: ReconcileOutcome }> {
    const stop = (result: SettlementResult): { kind: "STOP"; outcome: ReconcileOutcome } => ({
      kind: "STOP",
      outcome:
        "reconcile" in result && result.reconcile
          ? { kind: "INCIDENT", reason: `settlement ${result.code}` }
          : { kind: "UNRESOLVED", reason: `settlement ${result.code}` },
    });

    if (this.execution.fillReporting() === "CUMULATIVE") {
      const snapshot = snapshotFromView(view, order, this.now());
      if (!snapshot) return { kind: "STOP", outcome: { kind: "UNRESOLVED", reason: "the venue reported no cumulative totals" } };
      const result = await this.settlement.settleSnapshot(snapshot);
      if (result.code === "SUCCESS") return { kind: "OK", settled: 1 };
      if (result.code === "NOTHING_NEW" || result.code === "DUPLICATE" || result.code === "STALE_SNAPSHOT") {
        return { kind: "OK", settled: 0 };
      }
      return stop(result);
    }

    const fills = await this.execution.getFills({ externalOrderId: view.externalOrderId });
    if (!fills.ok) return { kind: "STOP", outcome: { kind: "UNRESOLVED", reason: `venue fills ${fills.error.kind}` } };
    let settled = 0;
    for (const fill of fills.value) {
      const result = await this.settlement.settleFill(fill);
      if (result.code === "SUCCESS") settled += 1;
      else if (result.code !== "DUPLICATE") return stop(result);
    }
    return { kind: "OK", settled };
  }
}

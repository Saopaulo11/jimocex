import { isAppError, type ErrorCode } from "../errors.ts";
import { type Money } from "../money.ts";
import { computeFee, type ResolvedFeeRule } from "./fee-rules.ts";
import type { LimitDecision } from "./limit-rules.ts";
import {
  orderNotional,
  reserveForOrder,
  validateOrderIntent,
  type OrderIntent,
  type OrderProblem,
  type OrderSide,
  type OrderType,
  type PairSpec,
  type Reservation,
  type ValidatedOrder,
} from "./order-rules.ts";
import type { Database } from "@/lib/db/database";

/**
 * Order engine — the server's orchestration for placing and cancelling a LIMIT
 * order (spec §19). This module has NO I/O and no `server-only` import: every
 * outside effect is reached through the `OrderEngineDeps` ports below, so the
 * whole decision sequence is unit-testable without a database, a session or a
 * network. The real adapters are wired in `order-engine.server.ts`.
 *
 * ONE reservation path. `place_limit_order` (migration 018) inserts the order
 * row AND posts the HOLD in a single transaction. `reserveForOrder` here only
 * COMPUTES which asset and how much to lock; it posts nothing. The engine calls
 * `deps.placeOrder` exactly once, so there is exactly one atomic HOLD and no
 * second reservation anywhere.
 *
 * Nothing financial is trusted from the caller. The amount and price are exact
 * `Money` (the server action parses them with `parseAmountInput`, which refuses
 * a float); everything else — the pair's tradability, precision, min/max, the
 * tier limits, the fee, the reserved asset and amount — is resolved or computed
 * here from the server-side user, never taken from the request. The input
 * carries no fee, balance, lock amount, wallet or user id: there is no field
 * for the client to supply one.
 */

export type OrderStatus = Database["public"]["Enums"]["order_status"];

/** The business failures the engine reports; a strict subset of ErrorCode. */
export type OrderErrorCode = Extract<
  ErrorCode,
  | "UNAUTHENTICATED"
  | "EMAIL_NOT_VERIFIED"
  | "ACCOUNT_SUSPENDED"
  | "ACCOUNT_CLOSED"
  | "VALIDATION_FAILED"
  | "TRADING_DISABLED"
  | "LIMIT_EXCEEDED"
  | "LIMIT_BELOW_MINIMUM"
  | "KYC_REQUIRED"
  | "LIMIT_CHECK_UNAVAILABLE"
  | "INSUFFICIENT_BALANCE"
  | "INTERNAL"
>;

export type PlaceLimitOrderInput = {
  pairSymbol: string;
  side: OrderSide;
  /** MARKET is accepted here only to be refused honestly: no execution venue. */
  type: OrderType;
  amount: Money;
  price: Money | null;
  /** Idempotency key (spec §20). A retry with the same key returns the original order. */
  clientOrderId?: string | null;
};

/** A `trading_pairs` row resolved to Money and carrying the ids the RPC needs. */
export type ResolvedPair = PairSpec & {
  pairId: string;
  baseAssetId: string;
  quoteAssetId: string;
};

/** What the atomic place RPC reports back to the engine. */
export type PlaceRpcResult =
  | { ok: true; orderId: string }
  | { ok: false; reason: "INSUFFICIENT_BALANCE" | "TRADING_DISABLED" };

export type AuthorizedUser = {
  userId: string;
  tierCode: string;
  status: Database["public"]["Enums"]["account_status"];
};

/**
 * The outside world, as ports. Each real adapter (order-engine.server.ts)
 * performs its own authorization/trust checks; the engine never passes a
 * client-chosen user id or wallet to any of them — `authorize()` is the only
 * source of the user id, and it comes from the verified session.
 */
export type OrderEngineDeps = {
  /** The verified, active, email-confirmed user — or throws AppError. */
  authorize(): Promise<AuthorizedUser>;
  loadPair(symbol: string): Promise<ResolvedPair | null>;
  checkLimits(args: { userId: string; assetSymbol: string; amount: Money }): Promise<LimitDecision>;
  resolveFeeRule(args: { quoteAssetId: string; tierCode: string }): Promise<ResolvedFeeRule>;
  placeOrder(params: {
    userId: string;
    pairId: string;
    side: OrderSide;
    price: Money;
    amount: Money;
    lockAssetId: string;
    lockAmount: Money;
    clientOrderId: string | null;
    fee: Money;
  }): Promise<PlaceRpcResult>;
  readOrder(orderId: string): Promise<RecordedOrder | null>;
  cancelOrderRpc(userId: string, orderId: string): Promise<boolean>;
};

/**
 * What the database recorded for a placed order — its status and what it holds
 * right now. On a first-wins replay the placed order is the ORIGINAL one, so
 * these are the figures to report, not the ones this request computed.
 */
export type RecordedOrder = {
  status: OrderStatus;
  /** Symbol of the asset the order locks; null if the row names none. */
  lockedAsset: string | null;
  /** How much of `lockedAsset` the order holds now (zero once it is terminal). */
  lockedAmount: Money;
};

export type PlaceResult =
  | { ok: true; orderId: string; status: OrderStatus; reservedAsset: string; reservedAmount: Money }
  | { ok: false; code: OrderErrorCode; message: string };

export type CancelResult =
  | { ok: true; orderId: string; status: "CANCELLED" }
  | { ok: false; code: OrderErrorCode; message: string }
  // A normal, non-leaking outcome: the order is terminal, unknown, or not the
  // caller's. The database returns false for all three without saying which, so
  // this result does the same — it never reveals another user's order.
  | { ok: false; code: "NOT_CANCELLABLE"; message: string };

/** The server-computed figures a form shows before the customer commits. */
export type OrderPreview = {
  /** price × amount, in the quote asset. */
  notional: Money;
  /** The fee computed from the user's tier rule, in the quote asset. */
  fee: Money;
  /** Which asset the order would lock — the base (SELL) or the quote (BUY). */
  reservedAsset: string;
  /** How much of `reservedAsset` would be held. */
  reservedAmount: Money;
};

export type PreviewResult =
  | { ok: true; preview: OrderPreview }
  | { ok: false; code: OrderErrorCode; message: string };

const fail = (code: OrderErrorCode): { ok: false; code: OrderErrorCode; message: string } => ({
  ok: false,
  code,
  message: messageFor(code),
});

function messageFor(code: OrderErrorCode): string {
  switch (code) {
    case "UNAUTHENTICATED": return "Please sign in to continue.";
    case "EMAIL_NOT_VERIFIED": return "Please verify your email address to continue.";
    case "ACCOUNT_SUSPENDED": return "This account cannot place orders. Please contact support.";
    case "ACCOUNT_CLOSED": return "This account is closed.";
    case "TRADING_DISABLED": return "Trading is not available for this market.";
    case "LIMIT_EXCEEDED": return "This amount exceeds your current limit.";
    case "LIMIT_BELOW_MINIMUM": return "This amount is below the minimum for this operation.";
    case "KYC_REQUIRED": return "Additional verification is required for this amount.";
    case "LIMIT_CHECK_UNAVAILABLE": return "We cannot check your limits right now. Please try again shortly.";
    case "INSUFFICIENT_BALANCE": return "Insufficient balance for this order.";
    case "VALIDATION_FAILED": return "Please check the order details and try again.";
    case "INTERNAL": return "Something went wrong. Please try again.";
  }
}

/** A validation problem that is really "not supported yet" gets its own message. */
const PROBLEM_MESSAGE: Partial<Record<OrderProblem, string>> = {
  MARKET_UNSUPPORTED: "Market orders are not available yet — place a limit order with a price.",
  BELOW_MIN: "This order is below the minimum size for this market.",
  ABOVE_MAX: "This order is above the maximum size for this market.",
};

/**
 * Shapes a thrown value into a typed failure. An AppError whose code the engine
 * reports keeps its own public message (never its internal detail); any other
 * AppError code, and every non-AppError, collapses to INTERNAL so a raw error —
 * a database message, a column name, a stack — can never reach the caller.
 */
function authError(error: unknown): { ok: false; code: OrderErrorCode; message: string } {
  if (isAppError(error) && isOrderErrorCode(error.code)) {
    return { ok: false, code: error.code, message: error.publicMessage };
  }
  if (!isAppError(error)) console.error("[order-engine] unexpected error", error);
  return fail("INTERNAL");
}

/**
 * The ErrorCodes the engine is allowed to report. Typed as OrderErrorCode[], so
 * adding a code here that is not part of OrderErrorCode fails to compile and the
 * list cannot drift from the type. A code outside it (FORBIDDEN, TIER_TOO_LOW,
 * PROVIDER_UNAVAILABLE, …) is treated as INTERNAL rather than surfaced.
 */
const REPORTABLE_CODES: readonly OrderErrorCode[] = [
  "UNAUTHENTICATED",
  "EMAIL_NOT_VERIFIED",
  "ACCOUNT_SUSPENDED",
  "ACCOUNT_CLOSED",
  "VALIDATION_FAILED",
  "TRADING_DISABLED",
  "LIMIT_EXCEEDED",
  "LIMIT_BELOW_MINIMUM",
  "KYC_REQUIRED",
  "LIMIT_CHECK_UNAVAILABLE",
  "INSUFFICIENT_BALANCE",
  "INTERNAL",
];

function isOrderErrorCode(code: ErrorCode): code is OrderErrorCode {
  return (REPORTABLE_CODES as readonly ErrorCode[]).includes(code);
}

type Fail = { ok: false; code: OrderErrorCode; message: string };

/** The validated order plus the server-computed fee and reserve, ready to place. */
type ComputedPlacement = {
  pair: ResolvedPair;
  order: ValidatedOrder;
  notional: Money;
  fee: Money;
  reservation: Reservation;
  lockAssetId: string;
};

/**
 * The shared spine of `placeLimitOrder` and `previewOrder`: resolve the pair,
 * validate the intent server-side, then recompute the fee and the reserve. It
 * reserves nothing and touches no money — so a preview can run it to show what
 * placement will do, and placement runs the very same code, which is what keeps
 * the quoted fee/reserve and the reserved fee/reserve from ever disagreeing.
 * The tier-limit check and the atomic HOLD live only in `placeLimitOrder`.
 */
async function computePlacement(
  deps: OrderEngineDeps,
  user: AuthorizedUser,
  input: PlaceLimitOrderInput,
): Promise<{ ok: true; value: ComputedPlacement } | { ok: false; failure: Fail }> {
  const pair = await deps.loadPair(input.pairSymbol);
  if (!pair) {
    return { ok: false, failure: { ok: false, code: "VALIDATION_FAILED", message: "This market was not found." } };
  }

  const intent: OrderIntent = { side: input.side, type: input.type, amount: input.amount, price: input.price };
  const validation = validateOrderIntent(intent, pair);
  if (!validation.ok) {
    if (validation.problem === "TRADING_DISABLED") return { ok: false, failure: fail("TRADING_DISABLED") };
    const message = PROBLEM_MESSAGE[validation.problem] ?? messageFor("VALIDATION_FAILED");
    return { ok: false, failure: { ok: false, code: "VALIDATION_FAILED", message } };
  }
  const order = validation.order;

  // Fee: resolved from the database by the user's tier and computed on the
  // server. There is no client fee to ignore — the input has no such field.
  const rule = await deps.resolveFeeRule({ quoteAssetId: pair.quoteAssetId, tierCode: user.tierCode });
  const notional = orderNotional(order);
  const fee = computeFee(notional, rule);

  const reservation = reserveForOrder(order, fee);
  const lockAssetId = reservation.lockAsset === "BASE" ? pair.baseAssetId : pair.quoteAssetId;

  return { ok: true, value: { pair, order, notional, fee, reservation, lockAssetId } };
}

/**
 * Places a LIMIT order: authorize → resolve/validate/price the order → tier
 * limits → ONE atomic place-and-hold RPC → read back what was recorded. Returns a typed
 * result; it never throws for an expected business failure and never surfaces a
 * raw database error.
 */
export async function placeLimitOrder(
  deps: OrderEngineDeps,
  input: PlaceLimitOrderInput,
): Promise<PlaceResult> {
  let user: AuthorizedUser;
  try {
    user = await deps.authorize();
  } catch (error) {
    return authError(error);
  }

  try {
    const computed = await computePlacement(deps, user, input);
    if (!computed.ok) return computed.failure;
    const { pair, order, reservation, lockAssetId, fee } = computed.value;

    // Tier limits, valued server-side on the base quantity. Checked before the
    // single atomic placement; the engine never trusts a client-sent limit.
    const decision = await deps.checkLimits({
      userId: user.userId,
      assetSymbol: pair.baseAsset,
      amount: order.amount,
    });
    const limitFailure = limitDecisionToCode(decision);
    if (limitFailure) return fail(limitFailure);

    // The single atomic order-and-HOLD path.
    const placed = await deps.placeOrder({
      userId: user.userId,
      pairId: pair.pairId,
      side: order.side,
      price: order.price,
      amount: order.amount,
      lockAssetId,
      lockAmount: reservation.lockAmount,
      clientOrderId: input.clientOrderId ?? null,
      fee,
    });
    if (!placed.ok) return fail(placed.reason);

    // Report what the database recorded, not what this request asked for. A
    // retry with the same clientOrderId returns the ORIGINAL order (first wins),
    // whose reserve can differ from this request's — echoing this request's
    // figures would tell the customer an amount was held that never was.
    const recorded = await deps.readOrder(placed.orderId);
    if (recorded) {
      return {
        ok: true,
        orderId: placed.orderId,
        status: recorded.status,
        reservedAsset: recorded.lockedAsset ?? (reservation.lockAsset === "BASE" ? pair.baseAsset : pair.quoteAsset),
        reservedAmount: recorded.lockedAmount,
      };
    }
    return {
      ok: true,
      orderId: placed.orderId,
      status: "OPEN",
      reservedAsset: reservation.lockAsset === "BASE" ? pair.baseAsset : pair.quoteAsset,
      reservedAmount: reservation.lockAmount,
    };
  } catch (error) {
    return authError(error);
  }
}

/**
 * Computes the server-side fee and reserve for an order WITHOUT placing it, so
 * the form can show what will be charged and held before the customer commits
 * (spec §19, §26). It runs the same pair/validation/fee/reserve code as
 * `placeLimitOrder` — the preview cannot disagree with the placement — but
 * reserves nothing. It deliberately omits the tier-limit check: limits are
 * enforced at placement, where exceeding one returns LIMIT_EXCEEDED.
 */
export async function previewOrder(
  deps: OrderEngineDeps,
  input: PlaceLimitOrderInput,
): Promise<PreviewResult> {
  let user: AuthorizedUser;
  try {
    user = await deps.authorize();
  } catch (error) {
    return authError(error);
  }

  try {
    const computed = await computePlacement(deps, user, input);
    if (!computed.ok) return computed.failure;
    const { pair, reservation, notional, fee } = computed.value;
    const reservedAsset = reservation.lockAsset === "BASE" ? pair.baseAsset : pair.quoteAsset;
    return { ok: true, preview: { notional, fee, reservedAsset, reservedAmount: reservation.lockAmount } };
  } catch (error) {
    return authError(error);
  }
}

/** Cancels the caller's own order and releases its hold (one atomic RPC). */
export async function cancelOrder(deps: OrderEngineDeps, input: { orderId: string }): Promise<CancelResult> {
  let user: AuthorizedUser;
  try {
    user = await deps.authorize();
  } catch (error) {
    const mapped = authError(error);
    return mapped;
  }

  try {
    // The user id comes from the verified session, never the request, so the
    // RPC can only ever act on the caller's own order. It returns false for a
    // terminal, unknown or foreign order alike — reported without distinction.
    const cancelled = await deps.cancelOrderRpc(user.userId, input.orderId);
    if (!cancelled) {
      return { ok: false, code: "NOT_CANCELLABLE", message: "This order cannot be cancelled." };
    }
    return { ok: true, orderId: input.orderId, status: "CANCELLED" };
  } catch (error) {
    return authError(error);
  }
}

/** Maps a limit decision to a failure code, or null when the operation may proceed. */
function limitDecisionToCode(decision: LimitDecision): OrderErrorCode | null {
  switch (decision.decision) {
    case "ALLOW":
      return null;
    case "REQUIRE_KYC":
      return "KYC_REQUIRED";
    case "UNAVAILABLE":
      return "LIMIT_CHECK_UNAVAILABLE";
    case "BLOCK":
      return /below the minimum|minimum for this operation/.test(decision.reason)
        ? "LIMIT_BELOW_MINIMUM"
        : "LIMIT_EXCEEDED";
  }
}

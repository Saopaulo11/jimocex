"use server";

import { toDecimalString } from "@/lib/money";
import {
  cancelOrder as cancelOrderServer,
  placeLimitOrder as placeLimitOrderServer,
  previewLimitOrder as previewLimitOrderServer,
  type OrderErrorCode,
} from "@/lib/engines/order-engine.server";
import { parseOrderAmounts } from "@/lib/trade/order-input";
import type { OrderSideValue, OrderStatusValue, OrderTypeValue } from "@/lib/trade/types";

/**
 * Trade Server Actions (spec §19, §31) — the HTTP trust boundary.
 *
 * The browser reaches the order engine only through these three actions, and it
 * sends ONLY the user's intent: the pair, the side, the type, the price and
 * amount as the strings the customer typed, and an idempotency key. It sends no
 * user id, no wallet, no fee, no reserve amount, no tier, no status — there is
 * no parameter here to carry one, and each is established server-side from the
 * verified session by `order-engine.server.ts`.
 *
 * The amounts are parsed into exact `Money` HERE, on the server, with
 * `parseAmountInput` (which refuses a float, a sign, grouping or a locale
 * comma). The engine then re-validates precision, min/max, fee and reserve
 * against the pair — so a parse that is too lenient changes nothing: the
 * authoritative checks are the engine's.
 *
 * Every result is a safe, typed view. Money crosses back as a decimal string,
 * and a failure carries only a customer-facing code and message — never a SQL
 * error, a stack, or an internal detail.
 */

export type TradeActionInput = {
  pairSymbol: string;
  side: OrderSideValue;
  type: OrderTypeValue;
  /** Raw strings exactly as typed; parsed on the server. */
  priceInput: string;
  amountInput: string;
  /** Idempotency key (spec §20); a retry of one action reuses the same value. */
  clientOrderId?: string | null;
};

type Failure = { ok: false; code: OrderErrorCode; message: string };

export type PreviewActionResult =
  | { ok: true; notional: string; fee: string; reservedAsset: string; reservedAmount: string }
  | Failure;

export type PlaceActionResult =
  | { ok: true; orderId: string; status: OrderStatusValue; reservedAsset: string; reservedAmount: string }
  | Failure;

export type CancelActionResult =
  | { ok: true; orderId: string; status: "CANCELLED" }
  | { ok: false; code: OrderErrorCode | "NOT_CANCELLABLE"; message: string };

const validationFail = (message: string): Failure => ({ ok: false, code: "VALIDATION_FAILED", message });

/** Server-computed fee and reserve for the entered order, without placing it. */
export async function previewLimitOrderAction(input: TradeActionInput): Promise<PreviewActionResult> {
  const parsed = parseOrderAmounts(input);
  if (!parsed.ok) return validationFail(parsed.message);

  const result = await previewLimitOrderServer({
    pairSymbol: input.pairSymbol,
    side: input.side,
    type: input.type,
    amount: parsed.amount,
    price: parsed.price,
    clientOrderId: input.clientOrderId ?? null,
  });

  if (!result.ok) return result;
  return {
    ok: true,
    notional: toDecimalString(result.preview.notional),
    fee: toDecimalString(result.preview.fee),
    reservedAsset: result.preview.reservedAsset,
    reservedAmount: toDecimalString(result.preview.reservedAmount),
  };
}

/** Places a LIMIT order through the atomic engine path. */
export async function placeLimitOrderAction(input: TradeActionInput): Promise<PlaceActionResult> {
  const parsed = parseOrderAmounts(input);
  if (!parsed.ok) return validationFail(parsed.message);

  const result = await placeLimitOrderServer({
    pairSymbol: input.pairSymbol,
    side: input.side,
    type: input.type,
    amount: parsed.amount,
    price: parsed.price,
    clientOrderId: input.clientOrderId ?? null,
  });

  if (!result.ok) return result;
  return {
    ok: true,
    orderId: result.orderId,
    status: result.status,
    reservedAsset: result.reservedAsset,
    reservedAmount: toDecimalString(result.reservedAmount),
  };
}

/** Cancels one of the caller's own orders and releases its hold. */
export async function cancelOrderAction(orderId: string): Promise<CancelActionResult> {
  if (typeof orderId !== "string" || orderId.trim() === "") {
    return { ok: false, code: "NOT_CANCELLABLE", message: "This order cannot be cancelled." };
  }
  return cancelOrderServer({ orderId });
}

import {
  addMoney,
  formatMoney,
  greaterThan,
  hasAtMostDecimals,
  isPositive,
  lessThan,
  multiplyMoney,
  type Money,
} from "../money.ts";
import type { Database } from "@/lib/db/database";

/**
 * Order-placement decision logic, with no I/O (spec §19).
 *
 * The part that decides whether an order may be created and how much of which
 * asset it must reserve — pure, so it is testable without a database, a market
 * data feed or an execution provider. The DB-backed caller (an order Server
 * Action) resolves the pair and the fee, calls `validateOrderIntent` and
 * `reserveForOrder` here, then posts the HOLD through `ledger_post()` and
 * inserts the `trading_orders` row.
 *
 * The money import is relative because `node --test` runs this file directly.
 *
 * SCOPE (honest): only LIMIT orders are supported. A MARKET order cannot be
 * priced or executed while no market-data and no execution provider is
 * connected, so it is refused here rather than accepted and left hanging — the
 * UI shows that market/instant execution needs a connected provider. A LIMIT
 * order carries the customer's own price, so it can be validated and its funds
 * reserved with no external input; it simply cannot FILL until an execution
 * provider is connected, which the order's OPEN status reflects (it is never
 * reported as filled).
 */

export type OrderSide = Database["public"]["Enums"]["order_side"];
export type OrderType = Database["public"]["Enums"]["order_type"];

/** The pair's configuration, resolved to Money. Mirrors `trading_pairs`. */
export type PairSpec = {
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  tradingEnabled: boolean;
  pricePrecision: number;
  amountPrecision: number;
  minOrderSize: Money;
  /** NULL in the schema means "no maximum". */
  maxOrderSize: Money | null;
};

/** What the customer asked for. `price` is null for a MARKET order. */
export type OrderIntent = {
  side: OrderSide;
  type: OrderType;
  amount: Money;
  price: Money | null;
};

/** Stable reasons an order is refused, for the caller to map to a message. */
export type OrderProblem =
  | "TRADING_DISABLED"
  | "MARKET_UNSUPPORTED"
  | "PRICE_REQUIRED"
  | "PRICE_NOT_ALLOWED"
  | "PRICE_NOT_POSITIVE"
  | "PRICE_PRECISION"
  | "AMOUNT_NOT_POSITIVE"
  | "AMOUNT_PRECISION"
  | "BELOW_MIN"
  | "ABOVE_MAX";

export type ValidatedOrder = {
  side: OrderSide;
  type: Extract<OrderType, "LIMIT">;
  amount: Money;
  price: Money;
};

export type OrderValidation =
  | { ok: true; order: ValidatedOrder }
  | { ok: false; problem: OrderProblem };

/**
 * Validates an order intent against the pair. Server-side and total: every
 * figure is re-checked here even though the form checks some of them, because
 * a client value is never trusted (spec §10, §15, §19).
 */
export function validateOrderIntent(intent: OrderIntent, pair: PairSpec): OrderValidation {
  if (!pair.tradingEnabled) return { ok: false, problem: "TRADING_DISABLED" };

  // MARKET needs a price from somewhere (a feed or the book) and an execution
  // venue to fill against; neither is connected. Refuse it rather than accept
  // an order that could never be priced or filled.
  if (intent.type === "MARKET") return { ok: false, problem: "MARKET_UNSUPPORTED" };

  if (intent.price === null) return { ok: false, problem: "PRICE_REQUIRED" };
  if (!isPositive(intent.price)) return { ok: false, problem: "PRICE_NOT_POSITIVE" };
  if (!hasAtMostDecimals(intent.price, pair.pricePrecision)) return { ok: false, problem: "PRICE_PRECISION" };

  if (!isPositive(intent.amount)) return { ok: false, problem: "AMOUNT_NOT_POSITIVE" };
  if (!hasAtMostDecimals(intent.amount, pair.amountPrecision)) return { ok: false, problem: "AMOUNT_PRECISION" };
  if (lessThan(intent.amount, pair.minOrderSize)) return { ok: false, problem: "BELOW_MIN" };
  if (pair.maxOrderSize !== null && greaterThan(intent.amount, pair.maxOrderSize)) {
    return { ok: false, problem: "ABOVE_MAX" };
  }

  return { ok: true, order: { side: intent.side, type: "LIMIT", amount: intent.amount, price: intent.price } };
}

/** The notional of a LIMIT order in the quote asset: price × amount. */
export function orderNotional(order: ValidatedOrder): Money {
  return multiplyMoney(order.price, order.amount, "up");
}

export type Reservation = {
  /** Which asset is locked — the base (a sell) or the quote (a buy). */
  lockAsset: "BASE" | "QUOTE";
  lockAmount: Money;
  /** price × amount, in the quote asset. */
  notional: Money;
};

/**
 * What a validated order must reserve, given the fee the FeeEngine computed on
 * the notional (in the quote asset).
 *
 *   BUY  → lock QUOTE = notional + fee. The buyer must cover the cost and the
 *          fee up front; the base arrives on a fill.
 *   SELL → lock BASE = amount. The seller locks the asset being sold; the fee
 *          is taken from the quote proceeds at settlement, so no extra base is
 *          reserved now.
 *
 * Reserving up front is what makes `ledger_post` HOLD exact: the locked figure
 * is the most the order can ever consume, so a fill or a cancel only ever
 * RELEASEs from a bucket that already holds enough.
 */
export function reserveForOrder(order: ValidatedOrder, feeInQuote: Money): Reservation {
  const notional = orderNotional(order);
  if (order.side === "BUY") {
    return { lockAsset: "QUOTE", lockAmount: addMoney(notional, feeInQuote), notional };
  }
  return { lockAsset: "BASE", lockAmount: order.amount, notional };
}

/** A human-readable summary for logging/audit. Never used for arithmetic. */
export function describeReservation(pair: PairSpec, reservation: Reservation): string {
  const asset = reservation.lockAsset === "BASE" ? pair.baseAsset : pair.quoteAsset;
  return `${formatMoney(reservation.lockAmount)} ${asset}`;
}

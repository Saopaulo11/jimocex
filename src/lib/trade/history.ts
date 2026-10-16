import "server-only";

import { moneySelect } from "@/lib/db/money-columns";
import { fromDatabase, fromDatabaseNullable, toDecimalString } from "@/lib/money";
import { createClient } from "@/lib/supabase/server";

import type { OrderSideValue, OrderStatusValue, OrderTypeValue } from "./types";

/**
 * The current user's order and trade history (spec §19, §31).
 *
 * Every read goes through the USER-scoped client, so RLS (`trading_orders_own_read`,
 * `trades_own_read`) restricts every row to the caller. There is no user id
 * parameter and no way to ask for someone else's rows. Money is read through
 * `moneySelect` (which casts to text) and parsed with `fromDatabase`, so a
 * dropped cast throws here naming the column rather than handing the UI a
 * rounded number. This module reads history; it never computes a figure.
 */

/** Non-terminal statuses — an order still resting with funds held. */
const OPEN_STATUSES: readonly OrderStatusValue[] = ["PENDING", "OPEN", "PARTIALLY_FILLED"];

export type OrderRow = {
  id: string;
  pairSymbol: string;
  baseSymbol: string;
  quoteSymbol: string;
  side: OrderSideValue;
  type: OrderTypeValue;
  price: string | null;
  amount: string;
  filled: string;
  remaining: string;
  status: OrderStatusValue;
  createdAt: string;
  updatedAt: string;
  pricePrecision: number;
  amountPrecision: number;
};

export type TradeRow = {
  id: string;
  pairSymbol: string;
  baseSymbol: string;
  quoteSymbol: string;
  /** The caller's side, derived from which order of the trade is theirs under RLS. */
  side: OrderSideValue | null;
  price: string;
  amount: string;
  quoteAmount: string;
  fee: string;
  feeAsset: string | null;
  settledAt: string | null;
  createdAt: string;
  pricePrecision: number;
  amountPrecision: number;
};

export type OrderDetail = OrderRow & {
  clientOrderId: string | null;
  providerOrderId: string | null;
  averagePrice: string | null;
  rejectReason: string | null;
  lockedAsset: string | null;
  lockedAmount: string;
  trades: TradeRow[];
};

type RawOrder = {
  id: string;
  side: OrderSideValue;
  type: OrderTypeValue;
  price: string | null;
  amount: string;
  filled_amount: string;
  remaining_amount: string;
  status: OrderStatusValue;
  created_at: string;
  updated_at: string;
  pair: {
    symbol: string;
    price_precision: number;
    amount_precision: number;
    base: { symbol: string } | null;
    quote: { symbol: string } | null;
  } | null;
};

function toOrderRow(row: RawOrder): OrderRow | null {
  const base = row.pair?.base?.symbol;
  const quote = row.pair?.quote?.symbol;
  if (!row.pair || !base || !quote) return null;
  return {
    id: row.id,
    pairSymbol: row.pair.symbol,
    baseSymbol: base,
    quoteSymbol: quote,
    side: row.side,
    type: row.type,
    price: row.price === null ? null : toDecimalString(fromDatabase(row.price, "trading_orders.price")),
    amount: toDecimalString(fromDatabase(row.amount, "trading_orders.amount")),
    filled: toDecimalString(fromDatabase(row.filled_amount, "trading_orders.filled_amount")),
    remaining: toDecimalString(fromDatabase(row.remaining_amount, "trading_orders.remaining_amount")),
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    pricePrecision: row.pair.price_precision,
    amountPrecision: row.pair.amount_precision,
  };
}

function mapOrders(data: RawOrder[] | null): OrderRow[] {
  if (!data) return [];
  return data.flatMap((row) => {
    const mapped = toOrderRow(row);
    return mapped ? [mapped] : [];
  });
}

/** The caller's most recent orders, any status, newest first. */
export async function getRecentOrders(limit = 5): Promise<OrderRow[]> {
  try {
    const supabase = await createClient();
    const { data } = await supabase
      .from("trading_orders")
      .select(moneySelect("trading_orders", "id, side, type, price, amount, filled_amount, remaining_amount, status, created_at, updated_at, pair:pair_id(symbol, price_precision, amount_precision, base:base_asset_id(symbol), quote:quote_asset_id(symbol))"))
      .order("created_at", { ascending: false })
      .limit(limit)
      .overrideTypes<RawOrder[], { merge: false }>();
    return mapOrders(data);
  } catch {
    return [];
  }
}

/** The caller's terminal (no longer resting) orders, newest first. */
export async function getOrderHistory(limit = 100): Promise<OrderRow[]> {
  try {
    const supabase = await createClient();
    const { data } = await supabase
      .from("trading_orders")
      .select(moneySelect("trading_orders", "id, side, type, price, amount, filled_amount, remaining_amount, status, created_at, updated_at, pair:pair_id(symbol, price_precision, amount_precision, base:base_asset_id(symbol), quote:quote_asset_id(symbol))"))
      .not("status", "in", `(${OPEN_STATUSES.join(",")})`)
      .order("created_at", { ascending: false })
      .limit(limit)
      .overrideTypes<RawOrder[], { merge: false }>();
    return mapOrders(data);
  } catch {
    return [];
  }
}

type RawTrade = {
  id: string;
  price: string;
  amount: string;
  quote_amount: string;
  fee: string;
  settled_at: string | null;
  created_at: string;
  pair: {
    symbol: string;
    price_precision: number;
    amount_precision: number;
    base: { symbol: string } | null;
    quote: { symbol: string } | null;
  } | null;
  fee_asset: { symbol: string } | null;
  // Under RLS, only the caller's own order embeds non-null — that reveals their side.
  buy_order: { id: string; side: OrderSideValue } | null;
  sell_order: { id: string; side: OrderSideValue } | null;
};

function toTradeRow(row: RawTrade): TradeRow | null {
  const base = row.pair?.base?.symbol;
  const quote = row.pair?.quote?.symbol;
  if (!row.pair || !base || !quote) return null;
  const side: OrderSideValue | null = row.buy_order ? "BUY" : row.sell_order ? "SELL" : null;
  return {
    id: row.id,
    pairSymbol: row.pair.symbol,
    baseSymbol: base,
    quoteSymbol: quote,
    side,
    price: toDecimalString(fromDatabase(row.price, "trades.price")),
    amount: toDecimalString(fromDatabase(row.amount, "trades.amount")),
    quoteAmount: toDecimalString(fromDatabase(row.quote_amount, "trades.quote_amount")),
    fee: toDecimalString(fromDatabase(row.fee, "trades.fee")),
    feeAsset: row.fee_asset?.symbol ?? null,
    settledAt: row.settled_at,
    createdAt: row.created_at,
    pricePrecision: row.pair.price_precision,
    amountPrecision: row.pair.amount_precision,
  };
}

/** The caller's trades (buyer or seller), newest first. Empty until fills exist. */
export async function getTradeHistory(limit = 100): Promise<TradeRow[]> {
  try {
    const supabase = await createClient();
    const { data, error } = await supabase
      .from("trades")
      .select(moneySelect("trades", "id, price, amount, quote_amount, fee, settled_at, created_at, pair:pair_id(symbol, price_precision, amount_precision, base:base_asset_id(symbol), quote:quote_asset_id(symbol)), fee_asset:fee_asset_id(symbol), buy_order:buy_order_id(id, side), sell_order:sell_order_id(id, side)"))
      .order("created_at", { ascending: false })
      .limit(limit)
      .overrideTypes<RawTrade[], { merge: false }>();
    if (error || !data) return [];
    return data.flatMap((row) => {
      const mapped = toTradeRow(row);
      return mapped ? [mapped] : [];
    });
  } catch {
    return [];
  }
}

type RawOrderDetail = RawOrder & {
  average_price: string | null;
  client_order_id: string | null;
  provider_order_id: string | null;
  reject_reason: string | null;
  locked_amount: string;
  locked: { symbol: string } | null;
};

/** One of the caller's orders by id, with its trades. Null when not theirs / not found. */
export async function getOrderById(id: string): Promise<OrderDetail | null> {
  try {
    const supabase = await createClient();
    const { data, error } = await supabase
      .from("trading_orders")
      .select(moneySelect("trading_orders", "id, side, type, price, amount, filled_amount, remaining_amount, average_price, status, client_order_id, provider_order_id, reject_reason, locked_amount, created_at, updated_at, pair:pair_id(symbol, price_precision, amount_precision, base:base_asset_id(symbol), quote:quote_asset_id(symbol)), locked:locked_asset_id(symbol)"))
      .eq("id", id)
      .maybeSingle()
      .overrideTypes<RawOrderDetail, { merge: false }>();
    if (error || !data) return null;

    const base = data.pair?.base?.symbol;
    const quote = data.pair?.quote?.symbol;
    if (!data.pair || !base || !quote) return null;

    const trades = await tradesForOrder(id);

    return {
      id: data.id,
      pairSymbol: data.pair.symbol,
      baseSymbol: base,
      quoteSymbol: quote,
      side: data.side,
      type: data.type,
      price: data.price === null ? null : toDecimalString(fromDatabase(data.price, "trading_orders.price")),
      amount: toDecimalString(fromDatabase(data.amount, "trading_orders.amount")),
      filled: toDecimalString(fromDatabase(data.filled_amount, "trading_orders.filled_amount")),
      remaining: toDecimalString(fromDatabase(data.remaining_amount, "trading_orders.remaining_amount")),
      status: data.status,
      createdAt: data.created_at,
      updatedAt: data.updated_at,
      pricePrecision: data.pair.price_precision,
      amountPrecision: data.pair.amount_precision,
      clientOrderId: data.client_order_id,
      providerOrderId: data.provider_order_id,
      averagePrice:
        data.average_price === null
          ? null
          : toDecimalString(fromDatabaseNullable(data.average_price, "trading_orders.average_price")!),
      rejectReason: data.reject_reason,
      lockedAsset: data.locked?.symbol ?? null,
      lockedAmount: toDecimalString(fromDatabase(data.locked_amount, "trading_orders.locked_amount")),
      trades,
    };
  } catch {
    return null;
  }
}

async function tradesForOrder(orderId: string): Promise<TradeRow[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("trades")
    .select(moneySelect("trades", "id, price, amount, quote_amount, fee, settled_at, created_at, pair:pair_id(symbol, price_precision, amount_precision, base:base_asset_id(symbol), quote:quote_asset_id(symbol)), fee_asset:fee_asset_id(symbol), buy_order:buy_order_id(id, side), sell_order:sell_order_id(id, side)"))
    .or(`buy_order_id.eq.${orderId},sell_order_id.eq.${orderId}`)
    .order("created_at", { ascending: false })
    .overrideTypes<RawTrade[], { merge: false }>();
  if (error || !data) return [];
  return data.flatMap((row) => {
    const mapped = toTradeRow(row);
    return mapped ? [mapped] : [];
  });
}

export { OPEN_STATUSES };

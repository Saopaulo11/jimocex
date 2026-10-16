import type { Database } from "@/lib/db/database";

/**
 * Trade view types shared between the server reads (`account.ts`, `actions.ts`)
 * and the client panels (`OrderForm`, `OpenOrders`).
 *
 * Separate from the server modules because those are `server-only` and must
 * never reach the browser bundle. Everything here is types plus plain strings:
 * every money value crosses the server→client boundary as an exact decimal
 * string (the `@/lib/money` DecimalString convention), never a float and never
 * a bigint, and the client re-parses it with `parseMoney` to render it.
 */

export type OrderSideValue = Database["public"]["Enums"]["order_side"];
export type OrderTypeValue = Database["public"]["Enums"]["order_type"];
export type OrderStatusValue = Database["public"]["Enums"]["order_status"];

/** One asset's balance, from the ledger-backed `wallets` projection. */
export type PairBalance = {
  symbol: string;
  /** The asset's own display precision (`assets.decimals`). */
  decimals: number;
  /** Exact decimal strings — parse with `parseMoney` before rendering. */
  available: string;
  locked: string;
};

/** A non-terminal order of the current user, for the Open Orders panel. */
export type OpenOrderView = {
  id: string;
  pairSymbol: string;
  side: OrderSideValue;
  type: OrderTypeValue;
  /** Exact decimal string, or null for a MARKET order. */
  price: string | null;
  amount: string;
  status: OrderStatusValue;
  /** ISO timestamp. */
  createdAt: string;
  pricePrecision: number;
  amountPrecision: number;
  baseSymbol: string;
  quoteSymbol: string;
};

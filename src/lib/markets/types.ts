import type { Database } from "@/lib/db/database";
import type { DecimalString } from "@/lib/money";

/**
 * Market shapes shared between the server and the client.
 *
 * Separate from `pairs.ts` because that module is `server-only`: it reaches the
 * database and must never reach the browser bundle. A client component needs
 * these types to render a market, and importing them from the server module
 * would drag the whole data layer across the boundary — which is exactly what
 * the build caught when this file did not exist.
 *
 * Nothing here touches a secret, a connection or a provider. Types and a static
 * list of categories only, so it is safe on both sides.
 */

export type PairType = Database["public"]["Enums"]["pair_type"];

export type Market = {
  symbol: string;
  base: string;
  quote: string;
  type: PairType;
  tradingEnabled: boolean;
  swapEnabled: boolean;
  pricePrecision: number;
  amountPrecision: number;
  /** Exact decimal from trading_pairs.min_order_size — never a float. See @/lib/money. */
  minOrderSize: DecimalString;
};

export type MarketsResult = {
  markets: Market[];
  /** False when the pair list itself could not be read. */
  configured: boolean;
  /** True only when a market data provider can actually quote prices. */
  pricesAvailable: boolean;
};

export const MARKET_CATEGORIES: { id: "ALL" | PairType; label: string }[] = [
  { id: "ALL", label: "All" },
  { id: "CRYPTO", label: "Crypto" },
  { id: "CRYPTO_FIAT", label: "Crypto / Fiat" },
  { id: "FX", label: "FX" },
];

/**
 * A market ticker as it crosses to the client: exact decimal strings (or null
 * when unknown), never floats. Keyed by pair symbol on the page.
 */
export type MarketTicker = {
  price: string;
  changePercent24h: string | null;
  high24h: string | null;
  low24h: string | null;
  volume24h: string | null;
};

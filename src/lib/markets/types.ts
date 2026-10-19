import type { Database } from "@/lib/db/database";
import type { DecimalString } from "@/lib/money";
import type { CandleInterval, MarketDataKind } from "@/lib/providers/market-data/types";

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

/** A plain (client-safe) price level — decimal strings, never floats. */
export type BookLevel = { price: string; amount: string };

/**
 * Everything the trading terminal shows from the market-data source, for one
 * selected pair. Each section is independent: a failed candle request leaves the
 * chart "unavailable" without blanking the price or the book. All figures are
 * exact decimal strings. It is display data only — nothing here reaches the
 * order engine.
 */
export type TerminalMarketData = {
  /** The pair this describes (the poller checks it before using a response). */
  pair: string | null;
  /** Keyed by pair symbol — for the market list. May cover only some pairs. */
  tickers: Record<string, MarketTicker>;
  /** Null when the selected pair's price could not be had. */
  selectedTicker: MarketTicker | null;
  /** Close prices for the selected pair's chart; empty when unavailable. */
  chartCloses: string[];
  chartInterval: CandleInterval;
  /** Null when the order book could not be had. */
  book: { bids: BookLevel[]; asks: BookLevel[] } | null;
  /** A provider that can quote at all is selected (demo or market data). */
  available: boolean;
  /** The figures are PROTOTYPE demo data, not a real feed. */
  demo: boolean;
  kind: MarketDataKind;
  /** The source covers the selected pair (false: "not covered", not "temporarily unavailable"). */
  pairSupported: boolean;
  /** When the source says the selected price is from (ISO 8601), or null. */
  asOf: string | null;
};

/** How often the trading terminal refreshes market data while the tab is visible. */
export const MARKET_DATA_REFRESH_MS = 15_000;

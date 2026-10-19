import "server-only";

import type { DecimalString } from "@/lib/money";

/**
 * Market data provider contract (spec §13).
 *
 * The application talks only to this interface, so a crypto exchange feed, an
 * FX provider or an aggregator can be introduced without a single change in a
 * component, a route or an engine.
 *
 * The contract has one rule that matters more than the rest: a provider that
 * cannot answer must SAY SO. It may not interpolate, extrapolate, fall back to
 * a stale figure without labelling it, or return a plausible-looking number.
 * Downstream, a missing rate becomes a refusal to act — which is correct, and
 * is why the honest failure has to survive the whole way up.
 */

export type Ticker = {
  /** Canonical pair symbol, e.g. "BTC-USDT". */
  pair: string;
  price: DecimalString;
  /** Absolute change over 24h, in the quote asset. Null when unknown. */
  change24h: DecimalString | null;
  /** Change over 24h in percentage points: "2.41" means 2.41%. Null when unknown. */
  changePercent24h: DecimalString | null;
  high24h: DecimalString | null;
  low24h: DecimalString | null;
  volume24h: DecimalString | null;
  /** Best bid / best ask at `asOf`, when the source reports them. Null when unknown. */
  bid: DecimalString | null;
  ask: DecimalString | null;
  /** When the upstream says this data is from — not when we fetched it. */
  asOf: Date;
  source: string;
};

export type OrderBookLevel = { price: DecimalString; amount: DecimalString };

export type OrderBook = {
  pair: string;
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
  asOf: Date;
  source: string;
};

export type Candle = {
  openTime: Date;
  open: DecimalString;
  high: DecimalString;
  low: DecimalString;
  close: DecimalString;
  volume: DecimalString;
};

export type PublicTrade = {
  price: DecimalString;
  amount: DecimalString;
  side: "BUY" | "SELL";
  executedAt: Date;
};

export type CandleInterval = "1m" | "5m" | "15m" | "1h" | "4h" | "1d" | "1w";

/**
 * What kind of source is behind a provider — so a surface can label its figures
 * honestly without inspecting the provider's class.
 *
 *   * "unavailable" — no source; every call refuses. Show "unavailable".
 *   * "demo"        — a deterministic PROTOTYPE source. The numbers are not a
 *                     market; every surface that shows them must say "Demo data".
 *   * "live"        — a real market feed (the public `binance` adapter ships in
 *                     this repo). Its figures are real but informational: a
 *                     surface labels them "Market data", never "live" or
 *                     real-time, because they are polled, not streamed.
 */
export type MarketDataKind = "unavailable" | "demo" | "live";

/**
 * Prices are DecimalStrings, never JavaScript numbers — and never a plain
 * `string` either, because `String(json.price)` is a string that has already
 * been through a float.
 *
 * `number` is a float: 0.1 + 0.2 is not 0.3, and a price that round-trips
 * through one has silently lost precision before any arithmetic happens. An
 * adapter reads the upstream body with `parseJsonExact()`, which keeps every
 * number's exact digits, and checks each figure with `asDecimalString()`. Both
 * live in @/lib/money; there is no other way to produce a DecimalString from
 * outside data.
 */
export interface MarketDataProvider {
  readonly name: string;
  /** What kind of source this is — drives the honest "Demo data" / "unavailable" label. */
  readonly kind: MarketDataKind;
  /** False when the adapter has no credentials or no upstream configured. */
  isConfigured(): boolean;
  /**
   * Whether this source covers the pair at all. False means "this source has
   * nothing for the pair" (show "not covered"), as opposed to a call that failed
   * just now (show "temporarily unavailable"). Answers without a network call.
   */
  supportsPair(pair: string): boolean;

  getTicker(pair: string): Promise<Ticker>;
  getTickers(pairs?: string[]): Promise<Ticker[]>;
  getOrderBook(pair: string, depth?: number): Promise<OrderBook>;
  getCandles(pair: string, interval: CandleInterval, limit?: number): Promise<Candle[]>;
  getRecentTrades(pair: string, limit?: number): Promise<PublicTrade[]>;
}

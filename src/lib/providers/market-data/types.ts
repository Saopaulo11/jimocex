import "server-only";

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
  price: string;
  /** Absolute change over 24h, in the quote asset. Null when unknown. */
  change24h: string | null;
  /** Percentage change over 24h. Null when unknown. */
  changePercent24h: string | null;
  high24h: string | null;
  low24h: string | null;
  volume24h: string | null;
  /** When the upstream says this data is from — not when we fetched it. */
  asOf: Date;
  source: string;
};

export type OrderBookLevel = { price: string; amount: string };

export type OrderBook = {
  pair: string;
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
  asOf: Date;
  source: string;
};

export type Candle = {
  openTime: Date;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
};

export type PublicTrade = {
  price: string;
  amount: string;
  side: "BUY" | "SELL";
  executedAt: Date;
};

export type CandleInterval = "1m" | "5m" | "15m" | "1h" | "4h" | "1d" | "1w";

/**
 * Prices are strings, never JavaScript numbers.
 *
 * `number` is a float: 0.1 + 0.2 is not 0.3, and a price that round-trips
 * through one has silently lost precision before any arithmetic happens. The
 * database stores numeric(38,18); the wire format that preserves it is a
 * decimal string.
 */
export interface MarketDataProvider {
  readonly name: string;
  /** False when the adapter has no credentials or no upstream configured. */
  isConfigured(): boolean;

  getTicker(pair: string): Promise<Ticker>;
  getTickers(pairs?: string[]): Promise<Ticker[]>;
  getOrderBook(pair: string, depth?: number): Promise<OrderBook>;
  getCandles(pair: string, interval: CandleInterval, limit?: number): Promise<Candle[]>;
  getRecentTrades(pair: string, limit?: number): Promise<PublicTrade[]>;
}

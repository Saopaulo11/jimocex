import "server-only";

import { getMarketDataProvider, type Candle, type CandleInterval, type Ticker } from "@/lib/providers/market-data";
import type { MarketTicker } from "@/lib/markets/types";

/**
 * The one server-side place a page asks for prices.
 *
 * It never throws: a provider that refuses (none connected) becomes
 * `available: false` and an empty map, so a page renders an honest
 * "unavailable" instead of failing. `demo` is true when the figures come from
 * the deterministic prototype source — every surface that shows them must say
 * "Demo data". Keeping this in one module means a page never touches the
 * provider directly and the honesty label is computed one way.
 */

export type MarketTickers = {
  /** Keyed by pair symbol. Empty when no provider can quote. */
  tickers: Map<string, Ticker>;
  /** True when some provider can quote at all (demo or live). */
  available: boolean;
  /** True when the figures are PROTOTYPE demo data, not a real feed. */
  demo: boolean;
};

export async function getTickers(pairs?: string[]): Promise<MarketTickers> {
  const provider = getMarketDataProvider();
  const demo = provider.kind === "demo";
  if (provider.kind === "unavailable") return { tickers: new Map(), available: false, demo };
  try {
    const list = await provider.getTickers(pairs);
    return { tickers: new Map(list.map((t) => [t.pair, t])), available: true, demo };
  } catch {
    return { tickers: new Map(), available: false, demo };
  }
}

export type SingleTicker = {
  ticker: Ticker | null;
  available: boolean;
  demo: boolean;
};

export async function getTicker(pair: string): Promise<SingleTicker> {
  const provider = getMarketDataProvider();
  const demo = provider.kind === "demo";
  if (provider.kind === "unavailable") return { ticker: null, available: false, demo };
  try {
    return { ticker: await provider.getTicker(pair), available: true, demo };
  } catch {
    return { ticker: null, available: false, demo };
  }
}

export type Candles = { candles: Candle[]; available: boolean; demo: boolean };

export async function getCandles(pair: string, interval: CandleInterval = "1d", limit = 60): Promise<Candles> {
  const provider = getMarketDataProvider();
  const demo = provider.kind === "demo";
  if (provider.kind === "unavailable") return { candles: [], available: false, demo };
  try {
    return { candles: await provider.getCandles(pair, interval, limit), available: true, demo };
  } catch {
    return { candles: [], available: false, demo };
  }
}

/** A plain (client-safe) price level — decimal strings, never floats. */
export type BookLevel = { price: string; amount: string };

/**
 * Everything the trading terminal needs from the market-data source, assembled
 * once so the `/trade` and `/trade/[pair]` pages stay identical. All figures are
 * exact decimal strings; `demo` is true when they are the prototype source, so
 * the terminal labels them "Demo data" and never passes them off as live.
 */
export type TerminalMarketData = {
  /** Keyed by pair symbol — for the market list. */
  tickers: Record<string, MarketTicker>;
  selectedTicker: MarketTicker | null;
  /** Close prices for the selected pair's chart. */
  chartCloses: string[];
  book: { bids: BookLevel[]; asks: BookLevel[] } | null;
  available: boolean;
  demo: boolean;
};

const toMarketTicker = (t: Ticker): MarketTicker => ({
  price: t.price,
  changePercent24h: t.changePercent24h,
  high24h: t.high24h,
  low24h: t.low24h,
  volume24h: t.volume24h,
});

export async function getTerminalMarketData(selected: string | null): Promise<TerminalMarketData> {
  const provider = getMarketDataProvider();
  const demo = provider.kind === "demo";
  const empty: TerminalMarketData = { tickers: {}, selectedTicker: null, chartCloses: [], book: null, available: false, demo };
  if (provider.kind === "unavailable") return empty;

  try {
    const tickers: Record<string, MarketTicker> = {};
    for (const t of await provider.getTickers()) tickers[t.pair] = toMarketTicker(t);

    let selectedTicker: MarketTicker | null = null;
    let chartCloses: string[] = [];
    let book: { bids: BookLevel[]; asks: BookLevel[] } | null = null;

    if (selected) {
      selectedTicker = tickers[selected] ?? toMarketTicker(await provider.getTicker(selected));
      const candles = await provider.getCandles(selected, "1d", 48);
      chartCloses = candles.map((c) => c.close as string);
      const b = await provider.getOrderBook(selected, 9);
      book = {
        bids: b.bids.map((l) => ({ price: l.price as string, amount: l.amount as string })),
        asks: b.asks.map((l) => ({ price: l.price as string, amount: l.amount as string })),
      };
    }
    return { tickers, selectedTicker, chartCloses, book, available: true, demo };
  } catch {
    return empty;
  }
}

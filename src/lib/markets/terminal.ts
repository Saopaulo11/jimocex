import type { CandleInterval, MarketDataProvider, Ticker } from "../providers/market-data/types";
import type { BookLevel, MarketTicker, TerminalMarketData } from "./types";

/**
 * Assembles the trading terminal's market data from a provider — the pure half
 * of `getTerminalMarketData` (ticker.ts), with the provider passed in so the
 * per-section rules are unit-tested without a server or a network.
 *
 * The market list, the selected price, the chart and the book are fetched
 * independently: one failing leaves that section empty ("unavailable") without
 * blanking the others, and nothing is ever filled in from another source. A
 * pair the source does not cover is not requested at all.
 */

/** The terminal's chart: one candle per day, the last 48 days. */
export const TERMINAL_CHART_INTERVAL: CandleInterval = "1d";
export const TERMINAL_CHART_CANDLES = 48;
export const TERMINAL_BOOK_DEPTH = 9;

export type FailureNote = (what: string, error: unknown) => void;

const toMarketTicker = (t: Ticker): MarketTicker => ({
  price: t.price,
  changePercent24h: t.changePercent24h,
  high24h: t.high24h,
  low24h: t.low24h,
  volume24h: t.volume24h,
});

export async function buildTerminalMarketData(
  provider: MarketDataProvider,
  selected: string | null,
  onFailure: FailureNote = () => {},
): Promise<TerminalMarketData> {
  /** The value, or null when the source refused — each section on its own. */
  const section = async <T>(what: string, load: () => Promise<T>): Promise<T | null> => {
    try {
      return await load();
    } catch (error) {
      onFailure(what, error);
      return null;
    }
  };

  const kind = provider.kind;
  const pairSupported = selected !== null && provider.supportsPair(selected);
  const result: TerminalMarketData = {
    pair: selected,
    tickers: {},
    selectedTicker: null,
    chartCloses: [],
    chartInterval: TERMINAL_CHART_INTERVAL,
    book: null,
    available: kind !== "unavailable",
    demo: kind === "demo",
    kind,
    pairSupported,
    asOf: null,
  };
  if (kind === "unavailable") return result;

  const list = await section("tickers", () => provider.getTickers());
  const listed = new Map((list ?? []).map((t) => [t.pair, t]));
  for (const [pair, t] of listed) result.tickers[pair] = toMarketTicker(t);

  if (selected === null || !pairSupported) return result;

  const [ticker, candles, book] = await Promise.all([
    listed.get(selected) ?? section(`ticker ${selected}`, () => provider.getTicker(selected)),
    section(`candles ${selected}`, () => provider.getCandles(selected, TERMINAL_CHART_INTERVAL, TERMINAL_CHART_CANDLES)),
    section(`order book ${selected}`, () => provider.getOrderBook(selected, TERMINAL_BOOK_DEPTH)),
  ]);

  if (ticker) {
    result.selectedTicker = toMarketTicker(ticker);
    result.asOf = ticker.asOf.toISOString();
  }
  if (candles) result.chartCloses = candles.map((c) => c.close as string);
  if (book) {
    const plain = (l: { price: string; amount: string }): BookLevel => ({ price: l.price, amount: l.amount });
    result.book = { bids: book.bids.map(plain), asks: book.asks.map(plain) };
  }
  return result;
}

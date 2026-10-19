import "server-only";

import { isAppError } from "@/lib/errors";
import {
  getMarketDataProvider,
  type Candle,
  type CandleInterval,
  type MarketDataKind,
  type Ticker,
} from "@/lib/providers/market-data";
import { buildTerminalMarketData } from "@/lib/markets/terminal";
import type { TerminalMarketData } from "@/lib/markets/types";

/**
 * The one server-side place a page asks for prices.
 *
 * It never throws: a provider that refuses (none connected, or the source
 * failed) becomes `available: false` or an empty section, so a page renders an
 * honest "unavailable" instead of failing — and never a substitute figure.
 * `demo` is true when the figures come from the deterministic prototype source
 * — every surface that shows them must say "Demo data". Keeping this in one
 * module means a page never touches the provider directly and the honesty label
 * is computed one way.
 *
 * Market data here is display data. Nothing in this module is read by the order
 * engine, the ledger or settlement.
 */

export type MarketTickers = {
  /** Keyed by pair symbol. Empty when no provider can quote. May cover only some pairs. */
  tickers: Map<string, Ticker>;
  /** True when some provider could quote at all (demo or market data). */
  available: boolean;
  /** True when the figures are PROTOTYPE demo data, not a real feed. */
  demo: boolean;
  /** Which kind of source is selected — "live" and not available means it failed just now. */
  kind: MarketDataKind;
};

/** Logs why a source refused, server-side only. The detail names no secret. */
function noteFailure(what: string, error: unknown): void {
  const detail = isAppError(error) ? (error.detail ?? error.code) : error instanceof Error ? error.name : "error";
  console.warn(`[market-data] ${what} unavailable: ${detail}`);
}

export async function getTickers(pairs?: string[]): Promise<MarketTickers> {
  const provider = getMarketDataProvider();
  const { kind } = provider;
  const demo = kind === "demo";
  if (kind === "unavailable") return { tickers: new Map(), available: false, demo, kind };
  try {
    const list = await provider.getTickers(pairs);
    return { tickers: new Map(list.map((t) => [t.pair, t])), available: true, demo, kind };
  } catch (error) {
    noteFailure("tickers", error);
    return { tickers: new Map(), available: false, demo, kind };
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
  if (provider.kind === "unavailable" || !provider.supportsPair(pair)) return { ticker: null, available: false, demo };
  try {
    return { ticker: await provider.getTicker(pair), available: true, demo };
  } catch (error) {
    noteFailure(`ticker ${pair}`, error);
    return { ticker: null, available: false, demo };
  }
}

export type Candles = { candles: Candle[]; available: boolean; demo: boolean };

export async function getCandles(pair: string, interval: CandleInterval = "1d", limit = 60): Promise<Candles> {
  const provider = getMarketDataProvider();
  const demo = provider.kind === "demo";
  if (provider.kind === "unavailable" || !provider.supportsPair(pair)) return { candles: [], available: false, demo };
  try {
    return { candles: await provider.getCandles(pair, interval, limit), available: true, demo };
  } catch (error) {
    noteFailure(`candles ${pair}`, error);
    return { candles: [], available: false, demo };
  }
}

export type { BookLevel, TerminalMarketData } from "@/lib/markets/types";

/**
 * Everything the trading terminal needs from the market-data source, assembled
 * once so the `/trade` and `/trade/[pair]` pages — and the terminal's periodic
 * refresh — stay identical. The rules (each section independent, uncovered pairs
 * not requested) live in `./terminal`, which is unit-tested.
 */
export async function getTerminalMarketData(selected: string | null): Promise<TerminalMarketData> {
  return buildTerminalMarketData(getMarketDataProvider(), selected, noteFailure);
}

export type MarketDataStatus = {
  kind: MarketDataKind;
  /** Short status label, e.g. for a status page row. */
  status: string;
  tone: "neutral" | "warning" | "info";
  note: string;
};

/**
 * The honest one-line description of the selected market-data source, for the
 * status and operator pages. It does not call the source, so it describes the
 * configuration; a failing source still shows "unavailable" on every price.
 */
export function marketDataStatus(): MarketDataStatus {
  const { kind } = getMarketDataProvider();
  if (kind === "live") {
    return {
      kind,
      status: "Public market data",
      tone: "info",
      note: "Prices, candles and order books come from a public market-data source, refreshed periodically. They are for information only and are not executable quotes; if the source cannot be reached, prices show as unavailable.",
    };
  }
  if (kind === "demo") {
    return {
      kind,
      status: "Demo data",
      tone: "warning",
      note: "No real market-data feed is selected. Prices shown are deterministic demo values, labelled as such.",
    };
  }
  return {
    kind,
    status: "Not connected",
    tone: "neutral",
    note: "No market-data source is connected, so prices are shown as unavailable.",
  };
}

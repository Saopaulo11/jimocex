import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { BinancePublicMarketDataProvider } from "../../providers/market-data/binance.ts";
import { PrototypeMarketDataProvider } from "../../providers/market-data/prototype.ts";
import type { Candle, MarketDataProvider, OrderBook, Ticker } from "../../providers/market-data/types";
import { buildTerminalMarketData, TERMINAL_BOOK_DEPTH, TERMINAL_CHART_CANDLES } from "../terminal.ts";

/**
 * Terminal market-data assembly (Slice 13A): each section stands on its own, a
 * pair the source does not cover is never requested, and a failure leaves its
 * section empty — never filled from another source.
 */

const TICKER: Ticker = {
  pair: "BTC-USDT",
  price: "65432.1" as Ticker["price"],
  change24h: null,
  changePercent24h: "-1.851" as Ticker["price"],
  high24h: null,
  low24h: null,
  volume24h: null,
  bid: null,
  ask: null,
  asOf: new Date("2026-10-18T12:00:00.000Z"),
  source: "test",
};

const BOOK: OrderBook = {
  pair: "BTC-USDT",
  bids: [{ price: "65432" as Ticker["price"], amount: "1" as Ticker["price"] }],
  asks: [{ price: "65433" as Ticker["price"], amount: "2" as Ticker["price"] }],
  asOf: new Date("2026-10-18T12:00:00.000Z"),
  source: "test",
};

const CANDLES: Candle[] = [
  { openTime: new Date(0), open: "1" as Candle["open"], high: "2" as Candle["open"], low: "1" as Candle["open"], close: "2" as Candle["open"], volume: "1" as Candle["open"] },
  { openTime: new Date(1), open: "2" as Candle["open"], high: "3" as Candle["open"], low: "2" as Candle["open"], close: "3" as Candle["open"], volume: "1" as Candle["open"] },
];

const refuse = async (): Promise<never> => {
  throw new Error("upstream refused");
};

/** A live provider whose sections can be made to fail one at a time; records what was asked. */
function stub(overrides: Partial<Pick<MarketDataProvider, "getTickers" | "getTicker" | "getCandles" | "getOrderBook">> = {}) {
  const asked: string[] = [];
  const provider: MarketDataProvider = {
    name: "stub",
    kind: "live",
    isConfigured: () => true,
    supportsPair: (pair) => pair === "BTC-USDT",
    getTickers: overrides.getTickers ?? (async () => [TICKER]),
    getTicker: async (pair) => {
      asked.push(`ticker ${pair}`);
      return (overrides.getTicker ?? (async () => TICKER))(pair);
    },
    getCandles: async (pair, interval, limit) => {
      asked.push(`candles ${pair} ${interval} ${String(limit)}`);
      return (overrides.getCandles ?? (async () => CANDLES))(pair, interval, limit);
    },
    getOrderBook: async (pair, depth) => {
      asked.push(`book ${pair} ${String(depth)}`);
      return (overrides.getOrderBook ?? (async () => BOOK))(pair, depth);
    },
    getRecentTrades: async () => [],
  };
  return { provider, asked };
}

describe("a covered pair", () => {
  test("every section filled, labelled as market data (not demo)", async () => {
    const { provider, asked } = stub();
    const data = await buildTerminalMarketData(provider, "BTC-USDT");
    assert.equal(data.kind, "live");
    assert.equal(data.demo, false);
    assert.equal(data.available, true);
    assert.equal(data.pairSupported, true);
    assert.equal(data.selectedTicker?.price, "65432.1");
    assert.equal(data.asOf, "2026-10-18T12:00:00.000Z");
    assert.deepEqual(data.chartCloses, ["2", "3"]);
    assert.deepEqual(data.book?.bids, [{ price: "65432", amount: "1" }]);
    // The selected price comes from the list when it is there: no second ticker call.
    assert.deepEqual(asked, [`candles BTC-USDT 1d ${TERMINAL_CHART_CANDLES}`, `book BTC-USDT ${TERMINAL_BOOK_DEPTH}`]);
  });
});

describe("each section fails on its own", () => {
  test("a failed chart leaves the price and the book", async () => {
    const { provider } = stub({ getCandles: refuse });
    const data = await buildTerminalMarketData(provider, "BTC-USDT");
    assert.deepEqual(data.chartCloses, []);
    assert.equal(data.selectedTicker?.price, "65432.1");
    assert.ok(data.book);
  });

  test("a failed book leaves the price and the chart", async () => {
    const { provider } = stub({ getOrderBook: refuse });
    const data = await buildTerminalMarketData(provider, "BTC-USDT");
    assert.equal(data.book, null);
    assert.equal(data.chartCloses.length, 2);
  });

  test("a failed list still prices the selected pair on its own", async () => {
    const { provider, asked } = stub({ getTickers: refuse });
    const data = await buildTerminalMarketData(provider, "BTC-USDT");
    assert.deepEqual(data.tickers, {});
    assert.equal(data.selectedTicker?.price, "65432.1");
    assert.ok(asked.includes("ticker BTC-USDT"));
  });

  test("everything failing shows nothing — no figure from anywhere else", async () => {
    const { provider } = stub({ getTickers: refuse, getTicker: refuse, getCandles: refuse, getOrderBook: refuse });
    const failures: string[] = [];
    const data = await buildTerminalMarketData(provider, "BTC-USDT", (what) => failures.push(what));
    assert.deepEqual(
      { tickers: data.tickers, selectedTicker: data.selectedTicker, chartCloses: data.chartCloses, book: data.book, asOf: data.asOf, demo: data.demo },
      { tickers: {}, selectedTicker: null, chartCloses: [], book: null, asOf: null, demo: false },
    );
    assert.deepEqual(failures.sort(), ["candles BTC-USDT", "order book BTC-USDT", "ticker BTC-USDT", "tickers"]);
  });

  test("a real adapter whose upstream is down refuses every section (no demo figures)", async () => {
    const provider = new BinancePublicMarketDataProvider({
      fetch: async () => new Response("down", { status: 503 }),
    });
    const data = await buildTerminalMarketData(provider, "BTC-USDT");
    assert.equal(data.kind, "live");
    assert.equal(data.selectedTicker, null);
    assert.deepEqual(data.chartCloses, []);
    assert.equal(data.book, null);
    assert.deepEqual(data.tickers, {});
  });
});

describe("a pair the source does not cover", () => {
  test("is not requested, and is reported as not covered", async () => {
    const { provider, asked } = stub();
    const data = await buildTerminalMarketData(provider, "EUR-USD");
    assert.equal(data.pairSupported, false);
    assert.equal(data.selectedTicker, null);
    assert.equal(data.book, null);
    assert.deepEqual(asked, []);
    // The market list is still shown for the pairs that are covered.
    assert.equal(data.tickers["BTC-USDT"]?.price, "65432.1");
  });
});

describe("other kinds", () => {
  test("the demo source is labelled demo", async () => {
    const data = await buildTerminalMarketData(new PrototypeMarketDataProvider(() => new Date("2026-10-18T12:00:00Z")), "BTC-USDT");
    assert.equal(data.kind, "demo");
    assert.equal(data.demo, true);
  });

  test("no provider means nothing is asked and nothing is shown", async () => {
    const { provider, asked } = stub();
    const data = await buildTerminalMarketData({ ...provider, kind: "unavailable" }, "BTC-USDT");
    assert.equal(data.available, false);
    assert.equal(data.selectedTicker, null);
    assert.deepEqual(asked, []);
  });
});

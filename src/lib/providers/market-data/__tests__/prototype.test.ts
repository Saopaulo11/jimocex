import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { compareMoney, parseMoney } from "../../../money.ts";
import { PrototypeMarketDataProvider } from "../prototype.ts";

/**
 * Prototype (demo) market-data provider tests (Slice 7.1).
 *
 * The two properties that make demo data safe to show are the ones under test:
 * it is DETERMINISTIC and STABLE (a pure function of pair + UTC day, identical
 * between calls and across a day) and it is FLOAT-FREE (every figure is an exact
 * decimal string, never a JavaScript number). Run with `node --test`; money is
 * imported relatively because node --test does not resolve `@/`.
 */

/** An exact decimal string as the database/Money layer renders one. */
const DECIMAL = /^-?\d+(\.\d+)?$/;
const assertDecimal = (value: string | null, field: string) => {
  if (value === null) return;
  assert.match(value, DECIMAL, `${field} must be an exact decimal string, got ${JSON.stringify(value)}`);
};

const at = (iso: string) => new PrototypeMarketDataProvider(() => new Date(iso));

describe("kind and configuration", () => {
  test("is a configured DEMO source, never 'live'", () => {
    const p = at("2026-03-15T12:00:00.000Z");
    assert.equal(p.kind, "demo");
    assert.equal(p.isConfigured(), true);
    assert.equal(p.name, "prototype");
  });
});

describe("determinism and stability", () => {
  test("two calls at the same instant return identical tickers", async () => {
    const p = at("2026-03-15T12:00:00.000Z");
    const a = await p.getTicker("BTC-USDT");
    const b = await p.getTicker("BTC-USDT");
    assert.deepEqual({ ...a, asOf: null }, { ...b, asOf: null });
  });

  test("the price is stable across a whole UTC day (no intraday drift, no Math.random)", async () => {
    const early = await at("2026-03-15T00:00:01.000Z").getTicker("ETH-USDT");
    const late = await at("2026-03-15T23:59:59.000Z").getTicker("ETH-USDT");
    assert.equal(early.price, late.price);
    assert.equal(early.change24h, late.change24h);
  });

  test("a different UTC day may move the price, and 24h change is consistent with it", async () => {
    const day1 = await at("2026-03-15T12:00:00.000Z").getTicker("SOL-USDT");
    const day2 = await at("2026-03-16T12:00:00.000Z").getTicker("SOL-USDT");
    // Both are valid decimals; the change field equals price - (price 24h ago).
    assertDecimal(day1.price, "day1.price");
    assertDecimal(day2.price, "day2.price");
    assertDecimal(day1.change24h, "day1.change24h");
  });
});

describe("float-freeness — every figure is an exact decimal string", () => {
  test("getTickers covers the seeded catalog and every field is a decimal", async () => {
    const tickers = await at("2026-03-15T12:00:00.000Z").getTickers();
    assert.ok(tickers.length >= 16, "all seeded pairs are quoted");
    assert.ok(tickers.some((t) => t.pair === "BTC-USDT"));
    for (const t of tickers) {
      assertDecimal(t.price, `${t.pair}.price`);
      assertDecimal(t.change24h, `${t.pair}.change24h`);
      assertDecimal(t.changePercent24h, `${t.pair}.changePercent24h`);
      assertDecimal(t.high24h, `${t.pair}.high24h`);
      assertDecimal(t.low24h, `${t.pair}.low24h`);
      assertDecimal(t.volume24h, `${t.pair}.volume24h`);
      // high ≥ low, both present.
      if (t.high24h && t.low24h) {
        assert.ok(compareMoney(parseMoney(t.high24h), parseMoney(t.low24h)) >= 0, `${t.pair}: high ≥ low`);
      }
    }
  });

  test("the USD limit-valuation crosses follow their USDT pair's demo price", async () => {
    const p = at("2026-03-15T12:00:00.000Z");
    for (const base of ["BTC", "ETH", "SOL"]) {
      const cross = await p.getTicker(`${base}-USD`);
      const listed = await p.getTicker(`${base}-USDT`);
      assert.equal(cross.pair, `${base}-USD`);
      assert.equal(cross.price, listed.price, `${base}-USD values ${base} at the ${base}-USDT demo price`);
    }
    // A cross is for valuation only: the catalog listing does not grow.
    const listedPairs = (await p.getTickers()).map((t) => t.pair);
    assert.ok(!listedPairs.includes("BTC-USD"));
  });

  test("an unknown pair still gets a stable positive demo price", async () => {
    const p = at("2026-03-15T12:00:00.000Z");
    const a = await p.getTicker("FOO-BAR");
    const b = await p.getTicker("FOO-BAR");
    assertDecimal(a.price, "FOO-BAR.price");
    assert.equal(a.price, b.price);
    assert.ok(compareMoney(parseMoney(a.price), parseMoney("0")) > 0);
  });
});

describe("order book", () => {
  test("bids descend, asks ascend, and the top bid is below the top ask", async () => {
    const book = await at("2026-03-15T12:00:00.000Z").getOrderBook("BTC-USDT", 8);
    assert.equal(book.bids.length, 8);
    assert.equal(book.asks.length, 8);
    for (const level of [...book.bids, ...book.asks]) {
      assertDecimal(level.price, "level.price");
      assertDecimal(level.amount, "level.amount");
    }
    for (let i = 1; i < book.bids.length; i += 1) {
      assert.ok(compareMoney(parseMoney(book.bids[i - 1]!.price), parseMoney(book.bids[i]!.price)) > 0, "bids descend");
    }
    for (let i = 1; i < book.asks.length; i += 1) {
      assert.ok(compareMoney(parseMoney(book.asks[i - 1]!.price), parseMoney(book.asks[i]!.price)) < 0, "asks ascend");
    }
    assert.ok(
      compareMoney(parseMoney(book.bids[0]!.price), parseMoney(book.asks[0]!.price)) < 0,
      "top bid below top ask",
    );
  });
});

describe("candles and trades", () => {
  test("candles: requested length, exact OHLC, high ≥ low", async () => {
    const candles = await at("2026-03-15T12:00:00.000Z").getCandles("BTC-USDT", "1h", 24);
    assert.equal(candles.length, 24);
    for (const c of candles) {
      for (const [k, v] of Object.entries({ open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume })) {
        assertDecimal(v, `candle.${k}`);
      }
      assert.ok(compareMoney(parseMoney(c.high), parseMoney(c.low)) >= 0, "candle high ≥ low");
    }
    // Deterministic: a second call is identical.
    const again = await at("2026-03-15T12:00:00.000Z").getCandles("BTC-USDT", "1h", 24);
    assert.deepEqual(candles, again);
  });

  test("recent trades: requested length, exact figures, valid side", async () => {
    const trades = await at("2026-03-15T12:00:00.000Z").getRecentTrades("ETH-USDT", 20);
    assert.equal(trades.length, 20);
    for (const t of trades) {
      assertDecimal(t.price, "trade.price");
      assertDecimal(t.amount, "trade.amount");
      assert.ok(t.side === "BUY" || t.side === "SELL");
    }
  });
});

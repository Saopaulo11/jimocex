import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { AppError } from "../../../errors.ts";
import {
  BinancePublicMarketDataProvider,
  MARKET_DATA_BASE_URL,
  MAX_BOOK_DEPTH,
  MAX_CANDLES,
  normalizeCandles,
  normalizeOrderBook,
  normalizeTicker,
  sourceSymbolFor,
} from "../binance.ts";

/**
 * Public market-data adapter tests (Slice 13A).
 *
 * Every HTTP response is mocked: the suite never touches the network, so it does
 * not depend on Binance being online. What is under test is the honesty of the
 * adapter — exact figures in, exact figures out, and a refusal
 * (MARKET_DATA_UNAVAILABLE) for anything it cannot vouch for, never a substitute.
 */

/* --------------------------------------------------------------- fixtures */

const TICKER_BTC = {
  symbol: "BTCUSDT",
  priceChange: "-1234.56000000",
  priceChangePercent: "-1.851",
  weightedAvgPrice: "65900.12000000",
  prevClosePrice: "66666.66000000",
  lastPrice: "65432.10000000",
  lastQty: "0.00100000",
  bidPrice: "65432.09000000",
  bidQty: "1.20000000",
  askPrice: "65432.10000000",
  askQty: "0.50000000",
  openPrice: "66666.66000000",
  highPrice: "67000.00000000",
  lowPrice: "65000.00000000",
  volume: "12345.67800000",
  quoteVolume: "812345678.12000000",
  openTime: 1792123200000,
  closeTime: 1792209599999,
  firstId: 1,
  lastId: 2,
  count: 2,
};

const tickerFor = (symbol: string, lastPrice: string, priceChangePercent: string) => ({
  ...TICKER_BTC,
  symbol,
  lastPrice,
  priceChangePercent,
  highPrice: lastPrice,
  lowPrice: lastPrice,
  bidPrice: lastPrice,
  askPrice: lastPrice,
});

const KLINES = [
  [1792022400000, "64000.00000000", "66000.00000000", "63500.00000000", "65500.00000000", "1000.50000000", 1792108799999, "0", 10, "0", "0", "0"],
  [1792108800000, "65500.00000000", "67000.00000000", "65000.00000000", "66666.66000000", "900.00000000", 1792195199999, "0", 10, "0", "0", "0"],
  [1792195200000, "66666.66000000", "66700.00000000", "65000.00000000", "65432.10000000", "123.40000000", 1792281599999, "0", 10, "0", "0", "0"],
];

const levels = (start: number, step: number, n: number) =>
  Array.from({ length: n }, (_, i) => [`${start + step * i}.50000000`, `${i + 1}.25000000`]);

const DEPTH = { lastUpdateId: 42, bids: levels(65430, -1, 10), asks: levels(65431, 1, 10) };

/* ------------------------------------------------------------ fake fetch */

type Call = { url: URL; init: RequestInit };

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" }, ...init });

function harness(handler: (url: URL, init: RequestInit) => Response | Promise<Response>, timeoutMs?: number) {
  const calls: Call[] = [];
  let now = 1_800_000_000_000;
  const provider = new BinancePublicMarketDataProvider({
    fetch: async (input, init) => {
      const url = new URL(input);
      calls.push({ url, init });
      return handler(url, init);
    },
    now: () => now,
    timeoutMs,
  });
  return {
    provider,
    calls,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

/** A route table keyed by path, like the real API. */
function upstream(routes: Record<string, (url: URL) => Response>) {
  return (url: URL) => {
    const route = routes[url.pathname];
    if (!route) return new Response("not found", { status: 404 });
    return route(url);
  };
}

const okRoutes = upstream({
  "/api/v3/ticker/24hr": (url) => {
    const symbols = url.searchParams.get("symbols");
    if (symbols) {
      const list = JSON.parse(symbols) as string[];
      const all: Record<string, unknown> = {
        BTCUSDT: TICKER_BTC,
        ETHUSDT: tickerFor("ETHUSDT", "3210.98000000", "2.500"),
        SOLUSDT: tickerFor("SOLUSDT", "151.23000000", "0.000"),
      };
      return json(list.map((s) => all[s]).filter(Boolean));
    }
    const symbol = url.searchParams.get("symbol");
    if (symbol === "BTCUSDT") return json(TICKER_BTC);
    if (symbol === "ETHUSDT") return json(tickerFor("ETHUSDT", "3210.98000000", "2.500"));
    if (symbol === "SOLUSDT") return json(tickerFor("SOLUSDT", "151.23000000", "0.000"));
    return json({ code: -1121, msg: "Invalid symbol." }, { status: 400 });
  },
  "/api/v3/klines": () => json(KLINES),
  "/api/v3/depth": () => json(DEPTH),
  "/api/v3/trades": () =>
    json([
      { id: 1, price: "65400.00000000", qty: "0.01000000", quoteQty: "654", time: 1792209500000, isBuyerMaker: true, isBestMatch: true },
      { id: 2, price: "65410.00000000", qty: "0.02000000", quoteQty: "1308.2", time: 1792209560000, isBuyerMaker: false, isBestMatch: true },
    ]),
});

async function refusal(promise: Promise<unknown>, detail?: RegExp): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof AppError, `expected an AppError, got ${String(error)}`);
    assert.equal(error.code, "MARKET_DATA_UNAVAILABLE");
    if (detail) assert.match(error.detail ?? "", detail);
    return error;
  }
  assert.fail("expected MARKET_DATA_UNAVAILABLE, but the call resolved");
}

/** Every request any test made must be a GET to the fixed public host, on a market-data path. */
const MARKET_DATA_PATHS = new Set(["/api/v3/ticker/24hr", "/api/v3/klines", "/api/v3/depth", "/api/v3/trades"]);
function assertReadOnly(calls: Call[]) {
  for (const { url, init } of calls) {
    assert.equal(url.origin, MARKET_DATA_BASE_URL);
    assert.ok(MARKET_DATA_PATHS.has(url.pathname), `unexpected path ${url.pathname}`);
    assert.equal(init.method, "GET");
    assert.equal(init.body, undefined);
    assert.ok(init.signal, "every request carries a timeout signal");
  }
}

/* ------------------------------------------------------------------ tests */

describe("identity", () => {
  test("is a configured live source named binance, on the market-data-only host", () => {
    const { provider } = harness(okRoutes);
    assert.equal(provider.name, "binance");
    assert.equal(provider.kind, "live");
    assert.equal(provider.isConfigured(), true);
    assert.equal(MARKET_DATA_BASE_URL, "https://data-api.binance.vision");
  });
});

describe("pair mapping", () => {
  test("BTC-USDT → BTCUSDT", () => assert.equal(sourceSymbolFor("BTC-USDT"), "BTCUSDT"));
  test("ETH-USDT → ETHUSDT", () => assert.equal(sourceSymbolFor("ETH-USDT"), "ETHUSDT"));
  test("SOL-USDT → SOLUSDT", () => assert.equal(sourceSymbolFor("SOL-USDT"), "SOLUSDT"));

  test("nothing else is mapped or guessed", () => {
    const { provider } = harness(okRoutes);
    for (const pair of ["EUR-USD", "BTC-BRL", "TRX-USDT", "USDT-RUB", "btc-usdt", "BTCUSDT", "__proto__", "constructor", ""]) {
      assert.equal(sourceSymbolFor(pair), null, pair);
      assert.equal(provider.supportsPair(pair), false, pair);
    }
    for (const pair of ["BTC-USDT", "ETH-USDT", "SOL-USDT"]) assert.equal(provider.supportsPair(pair), true, pair);
  });

  test("ETH-USDT and SOL-USDT request their own symbols", async () => {
    const { provider, calls } = harness(okRoutes);
    assert.equal((await provider.getTicker("ETH-USDT")).price, "3210.98");
    assert.equal((await provider.getTicker("SOL-USDT")).price, "151.23");
    assert.deepEqual(calls.map((c) => c.url.searchParams.get("symbol")), ["ETHUSDT", "SOLUSDT"]);
    assertReadOnly(calls);
  });

  test("the LimitEngine's <base>-USD valuation uses the USDT pair's real price, labelled with the asked pair", async () => {
    const { provider, calls } = harness(okRoutes);
    const t = await provider.getTicker("BTC-USD");
    assert.equal(t.pair, "BTC-USD");
    assert.equal(t.price, "65432.1");
    assert.equal(calls[0]!.url.searchParams.get("symbol"), "BTCUSDT");
  });
});

describe("ticker normalisation", () => {
  test("every figure is the source's exact decimal, canonicalised", async () => {
    const { provider, calls } = harness(okRoutes);
    const t = await provider.getTicker("BTC-USDT");
    assert.deepEqual(
      { ...t, asOf: t.asOf.toISOString() },
      {
        pair: "BTC-USDT",
        price: "65432.1",
        change24h: "-1234.56",
        changePercent24h: "-1.851",
        high24h: "67000",
        low24h: "65000",
        volume24h: "12345.678",
        bid: "65432.09",
        ask: "65432.1",
        asOf: new Date(1792209599999).toISOString(),
        source: "binance",
      },
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url.pathname, "/api/v3/ticker/24hr");
    assert.equal(calls[0]!.url.searchParams.get("symbol"), "BTCUSDT");
    assertReadOnly(calls);
  });

  test("a zero bid/ask (empty book) is unknown, not zero", () => {
    const t = normalizeTicker({ ...TICKER_BTC, bidPrice: "0.00000000", askPrice: "0.00000000" }, "BTC-USDT", "BTCUSDT");
    assert.equal(t.bid, null);
    assert.equal(t.ask, null);
  });

  test("a ticker for another symbol is refused", () => {
    assert.throws(() => normalizeTicker(TICKER_BTC, "ETH-USDT", "ETHUSDT"), /not ETHUSDT/);
  });

  test("several tickers in one request; a pair the response lacks is left out, not invented", async () => {
    const partial = upstream({
      "/api/v3/ticker/24hr": () => json([TICKER_BTC, { ...tickerFor("ETHUSDT", "-5", "1") }]),
    });
    const { provider, calls } = harness(partial);
    const list = await provider.getTickers();
    assert.deepEqual(list.map((t) => [t.pair, t.price]), [["BTC-USDT", "65432.1"]]);
    assert.deepEqual(JSON.parse(calls[0]!.url.searchParams.get("symbols")!), ["BTCUSDT", "ETHUSDT", "SOLUSDT"]);
    assertReadOnly(calls);
  });
});

describe("24h change", () => {
  test("negative, positive and zero changes pass through exactly", async () => {
    const { provider } = harness(okRoutes);
    const list = await provider.getTickers();
    assert.deepEqual(
      list.map((t) => [t.pair, t.changePercent24h]),
      [["BTC-USDT", "-1.851"], ["ETH-USDT", "2.5"], ["SOL-USDT", "0"]],
    );
  });

  test("a missing change is unknown (null), never computed", () => {
    const { priceChangePercent: _p, priceChange: _c, ...withoutChange } = TICKER_BTC;
    const t = normalizeTicker(withoutChange, "BTC-USDT", "BTCUSDT");
    assert.equal(t.changePercent24h, null);
    assert.equal(t.change24h, null);
  });

  test("a change sent as a JSON number is refused", () => {
    assert.throws(() => normalizeTicker({ ...TICKER_BTC, priceChangePercent: -1.851 }, "BTC-USDT", "BTCUSDT"), /JavaScript number/);
  });
});

describe("candles", () => {
  test("klines become exact candles, oldest first", async () => {
    const { provider, calls } = harness(okRoutes);
    const candles = await provider.getCandles("BTC-USDT", "1d", 3);
    assert.equal(candles.length, 3);
    assert.deepEqual(
      { ...candles[2]!, openTime: candles[2]!.openTime.toISOString() },
      { openTime: new Date(1792195200000).toISOString(), open: "66666.66", high: "66700", low: "65000", close: "65432.1", volume: "123.4" },
    );
    assert.equal(calls[0]!.url.pathname, "/api/v3/klines");
    assert.equal(calls[0]!.url.searchParams.get("symbol"), "BTCUSDT");
    assert.equal(calls[0]!.url.searchParams.get("interval"), "1d");
    assert.equal(calls[0]!.url.searchParams.get("limit"), "3");
    assertReadOnly(calls);
  });

  test("only the newest `limit` are kept", () => {
    assert.deepEqual(normalizeCandles(KLINES, 2).map((c) => c.close), ["66666.66", "65432.1"]);
  });

  test("the count is bounded", async () => {
    const { provider, calls } = harness(okRoutes);
    await provider.getCandles("BTC-USDT", "1d", 100_000);
    assert.equal(calls[0]!.url.searchParams.get("limit"), String(MAX_CANDLES));
  });

  test("out-of-order, inverted or numeric candles are refused", () => {
    assert.throws(() => normalizeCandles([KLINES[1], KLINES[0]], 10), /ascending/);
    const inverted = [...KLINES[0]!];
    inverted[2] = "1.00000000";
    assert.throws(() => normalizeCandles([inverted], 10), /high is below low|outside high\/low/);
    const numeric = [...KLINES[0]!];
    numeric[4] = 65500;
    assert.throws(() => normalizeCandles([numeric], 10), /JavaScript number/);
  });
});

describe("order book", () => {
  test("depth becomes exact levels, best first, trimmed to the depth asked", async () => {
    const { provider, calls } = harness(okRoutes);
    const book = await provider.getOrderBook("BTC-USDT", 9);
    assert.equal(book.bids.length, 9);
    assert.equal(book.asks.length, 9);
    assert.deepEqual(book.bids[0], { price: "65430.5", amount: "1.25" });
    assert.deepEqual(book.asks[0], { price: "65431.5", amount: "1.25" });
    assert.equal(book.source, "binance");
    // 9 levels are asked for with the smallest limit the API accepts that covers them.
    assert.equal(calls[0]!.url.searchParams.get("limit"), "10");
    assertReadOnly(calls);
  });

  test("the depth is bounded", async () => {
    const { provider, calls } = harness(okRoutes);
    await provider.getOrderBook("BTC-USDT", 10_000);
    assert.equal(calls[0]!.url.searchParams.get("limit"), String(MAX_BOOK_DEPTH));
  });

  test("a crossed, unordered or empty-quantity book is refused", () => {
    assert.throws(() => normalizeOrderBook({ bids: [["100.0", "1"]], asks: [["99.0", "1"]] }, 10), /crossed/);
    assert.throws(() => normalizeOrderBook({ bids: [["99.0", "1"], ["100.0", "1"]], asks: [] }, 10), /price order/);
    assert.throws(() => normalizeOrderBook({ bids: [["99.0", "0"]], asks: [] }, 10), /positive/);
    assert.throws(() => normalizeOrderBook({ bids: "none", asks: [] }, 10), /not an array/);
  });
});

describe("recent trades", () => {
  test("public trades are exact, newest first, with the taker's side", async () => {
    const { provider, calls } = harness(okRoutes);
    const trades = await provider.getRecentTrades("BTC-USDT", 2);
    assert.deepEqual(
      trades.map((t) => [t.price, t.amount, t.side]),
      [["65410", "0.02", "BUY"], ["65400", "0.01", "SELL"]],
    );
    assertReadOnly(calls);
  });
});

describe("malformed responses are refused, never shown", () => {
  const cases: [string, () => Response][] = [
    ["a body that is not JSON", () => new Response("<html>oops</html>", { status: 200 })],
    ["a price sent as a JSON number", () => new Response(JSON.stringify(TICKER_BTC).replace('"65432.10000000"', "65432.1"), { status: 200 })],
    ["a price that is not a decimal", () => json({ ...TICKER_BTC, lastPrice: "abc" })],
    ["a price in exponent notation", () => json({ ...TICKER_BTC, lastPrice: "6.5e4" })],
    ["a negative price", () => json({ ...TICKER_BTC, lastPrice: "-1" })],
    ["a zero price", () => json({ ...TICKER_BTC, lastPrice: "0.00000000" })],
    ["high below low", () => json({ ...TICKER_BTC, highPrice: "1", lowPrice: "2" })],
    ["a timestamp that is not an integer", () => json({ ...TICKER_BTC, closeTime: "yesterday" })],
    ["an array instead of an object", () => json([TICKER_BTC])],
  ];
  for (const [name, respond] of cases) {
    test(name, async () => {
      const { provider } = harness(() => respond());
      await refusal(provider.getTicker("BTC-USDT"), /malformed|not JSON/);
    });
  }

  test("a response declaring more than the size cap is refused unread", async () => {
    const { provider } = harness(() => new Response("[]", { status: 200, headers: { "content-length": "2000000" } }));
    await refusal(provider.getCandles("BTC-USDT", "1d", 10), /too large/);
  });

  test("klines that are not an array are refused", async () => {
    const { provider } = harness(() => json({ klines: KLINES }));
    await refusal(provider.getCandles("BTC-USDT", "1d", 10), /malformed klines/);
  });
});

describe("timeouts and HTTP errors", () => {
  test("a request that does not answer in time is refused", async () => {
    const { provider } = harness(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal!.addEventListener("abort", () => reject(init.signal!.reason));
        }),
      20,
    );
    await refusal(provider.getTicker("BTC-USDT"), /timed out/);
  });

  test("a network failure is refused", async () => {
    const { provider } = harness(() => {
      throw new TypeError("fetch failed");
    });
    await refusal(provider.getTicker("BTC-USDT"), /request failed/);
  });

  for (const status of [400, 404, 500, 502, 503]) {
    test(`HTTP ${status} is refused`, async () => {
      const { provider } = harness(() => json({ code: -1, msg: "error" }, { status }));
      await refusal(provider.getTicker("BTC-USDT"), new RegExp(`HTTP ${status}`));
    });
  }

  test("a rate limit (429) is honoured: no further call until Retry-After has passed", async () => {
    let limited = true;
    const h = harness((url) => (limited ? json({ code: -1003 }, { status: 429, headers: { "retry-after": "30" } }) : okRoutes(url)));
    await refusal(h.provider.getTicker("BTC-USDT"), /HTTP 429/);
    limited = false;
    h.advance(10_000); // past the 5 s failure memory, inside the 30 s cool-down
    await refusal(h.provider.getTicker("BTC-USDT"), /cooling down/);
    assert.equal(h.calls.length, 1, "no request is sent while cooling down");
    h.advance(21_000);
    assert.equal((await h.provider.getTicker("BTC-USDT")).price, "65432.1");
    assert.equal(h.calls.length, 2);
  });

  test("access refused (451) backs off for minutes, not seconds", async () => {
    const h = harness(() => json({ code: 0, msg: "restricted location" }, { status: 451 }));
    await refusal(h.provider.getTicker("BTC-USDT"), /HTTP 451/);
    h.advance(60_000);
    await refusal(h.provider.getOrderBook("BTC-USDT", 5), /cooling down/);
    assert.equal(h.calls.length, 1);
  });
});

describe("unsupported pairs", () => {
  test("a pair the source does not cover is refused without any request", async () => {
    const { provider, calls } = harness(okRoutes);
    await refusal(provider.getTicker("EUR-USD"), /no source symbol/);
    await refusal(provider.getOrderBook("BTC-BRL"), /no source symbol/);
    await refusal(provider.getCandles("TRX-USDT", "1d"), /no source symbol/);
    await refusal(provider.getRecentTrades("USDT-RUB"), /no source symbol/);
    assert.deepEqual(await provider.getTickers(["EUR-USD", "GBP-USD"]), []);
    assert.equal(calls.length, 0);
  });

  test("a list asks only for the covered pairs", async () => {
    const { provider, calls } = harness(okRoutes);
    const list = await provider.getTickers(["EUR-USD", "BTC-USDT", "BTC-USDT"]);
    assert.deepEqual(list.map((t) => t.pair), ["BTC-USDT"]);
    assert.deepEqual(JSON.parse(calls[0]!.url.searchParams.get("symbols")!), ["BTCUSDT"]);
  });

  test("an interval the source does not offer is refused without a request", async () => {
    const { provider, calls } = harness(okRoutes);
    await refusal(provider.getCandles("BTC-USDT", "3d" as never), /interval/);
    assert.equal(calls.length, 0);
  });
});

describe("caching and request merging", () => {
  test("concurrent identical requests share one upstream call; the result is reused within its TTL", async () => {
    const h = harness(okRoutes);
    const [a, b] = await Promise.all([h.provider.getTicker("BTC-USDT"), h.provider.getTicker("BTC-USDT")]);
    assert.equal(a.price, b.price);
    assert.equal(h.calls.length, 1);
    h.advance(5_000);
    await h.provider.getTicker("BTC-USDT");
    assert.equal(h.calls.length, 1, "within the 10 s ticker TTL");
    h.advance(6_000);
    await h.provider.getTicker("BTC-USDT");
    assert.equal(h.calls.length, 2, "after the TTL");
  });

  test("a failure is remembered briefly, so a broken upstream is not called on every render", async () => {
    let failing = true;
    const h = harness((url) => (failing ? json({}, { status: 500 }) : okRoutes(url)));
    await refusal(h.provider.getTicker("BTC-USDT"));
    failing = false;
    await refusal(h.provider.getTicker("BTC-USDT"));
    assert.equal(h.calls.length, 1);
    h.advance(6_000);
    assert.equal((await h.provider.getTicker("BTC-USDT")).price, "65432.1");
    assert.equal(h.calls.length, 2);
  });
});

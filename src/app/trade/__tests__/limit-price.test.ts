import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";

import { AppError } from "../../../lib/errors.ts";
import { parseMoney, type Money } from "../../../lib/money.ts";
import type { ResolvedFeeRule } from "../../../lib/engines/fee-rules.ts";
import { previewOrder, type OrderEngineDeps, type ResolvedPair } from "../../../lib/engines/order-engine.ts";
import { buildTerminalMarketData } from "../../../lib/markets/terminal.ts";
import type { TerminalMarketData } from "../../../lib/markets/types.ts";
import {
  BinancePublicMarketDataProvider,
  MARKET_DATA_BASE_URL,
  USD_VALUATION_CROSSES,
} from "../../../lib/providers/market-data/binance.ts";
import { PrototypeMarketDataProvider } from "../../../lib/providers/market-data/prototype.ts";
import type { MarketDataProvider } from "../../../lib/providers/market-data/types.ts";
import { parseOrderAmounts } from "../../../lib/trade/order-input.ts";
import { limitPriceText, referencePriceFor, seedLimitPrice } from "../limit-price.ts";

/**
 * The LIMIT form's starting Price (Slice 13C).
 *
 * The form's Price starts from the same market-data seam the terminal header
 * reads — provider → buildTerminalMarketData → referencePriceFor →
 * limitPriceText — and only fills an empty field the customer has not edited.
 * These tests drive that path with the real public adapter on a fake upstream
 * (no network), then hand the filled text to the server's own parser and
 * preview, which stay the authority. The React wiring (OrderForm, TradeTerminal)
 * has no DOM under node --test, so what it must contain is checked statically.
 * Imports are relative because node --test does not resolve `@/`.
 */

/* ------------------------------------------------------------- fixtures */

const PRECISION = { "BTC-USDT": 2, "ETH-USDT": 2, "SOL-USDT": 3 } as const; // trading_pairs seed (011)

const binanceTicker = (symbol: string, lastPrice: unknown) => ({
  symbol,
  priceChange: "656.31000000",
  priceChangePercent: "0.806",
  weightedAvgPrice: lastPrice,
  prevClosePrice: lastPrice,
  lastPrice,
  lastQty: "0.00100000",
  bidPrice: lastPrice,
  bidQty: "1.00000000",
  askPrice: lastPrice,
  askQty: "1.00000000",
  openPrice: lastPrice,
  highPrice: lastPrice,
  lowPrice: lastPrice,
  volume: "12345.67800000",
  quoteVolume: "812345678.12000000",
  openTime: 1792123200000,
  closeTime: 1792209599999,
  firstId: 1,
  lastId: 2,
  count: 2,
});

const LAST_PRICES: Record<string, unknown> = {
  BTCUSDT: "82118.45000000",
  ETHUSDT: "3012.57000000",
  SOLUSDT: "142.35000000",
};

/**
 * The real public adapter on a fake upstream: tickers only (the chart and book
 * 404, so they fail on their own and prove the price does not depend on them).
 * Records every URL asked for.
 */
function publicSource(prices: Record<string, unknown> = LAST_PRICES, status = 200) {
  const urls: URL[] = [];
  const provider = new BinancePublicMarketDataProvider({
    fetch: async (input) => {
      const url = new URL(input);
      urls.push(url);
      if (status !== 200) return new Response("down", { status });
      if (url.pathname !== "/api/v3/ticker/24hr") return new Response("not found", { status: 404 });
      const body = (symbol: string) => binanceTicker(symbol, prices[symbol]);
      const list = url.searchParams.get("symbols");
      const payload = list ? (JSON.parse(list) as string[]).map(body) : body(url.searchParams.get("symbol") ?? "");
      return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
    },
    now: () => 1_800_000_000_000,
  });
  return { provider, urls };
}

const quiet = () => {};

/** What the form's Price field shows when it opens for `pair` — the same expression OrderForm's state starts from. */
async function openingPrice(pair: keyof typeof PRECISION, source = publicSource()) {
  const market = await buildTerminalMarketData(source.provider, pair, quiet);
  const reference = referencePriceFor(market, pair);
  return { market, reference, text: limitPriceText(reference, PRECISION[pair]) ?? "" };
}

const SRC = path.resolve(import.meta.dirname, "../../..");
const read = (rel: string) => readFileSync(path.join(SRC, rel), "utf8");
const stripComments = (code: string) => code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'])\/\/.*$/gm, "$1");

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return name === "__tests__" ? [] : files(full);
    return /\.(ts|tsx)$/.test(name) ? [full] : [];
  });
}

/** Runtime (non-type) import specifiers of a source file. */
function runtimeImports(code: string): string[] {
  const found: string[] = [];
  for (const m of stripComments(code).matchAll(/^\s*import\s+(type\s+)?[^"']*?from\s+["']([^"']+)["']/gm)) {
    if (!m[1]) found.push(m[2]!);
  }
  return found;
}

/* ----------------------------------------------------- A, B, C: opening */

describe("A–C: the form opens at the pair's market price", () => {
  for (const [pair, expected] of [
    ["BTC-USDT", "82118.45"],
    ["ETH-USDT", "3012.57"],
    ["SOL-USDT", "142.350"],
  ] as const) {
    test(`${pair} → ${expected}`, async () => {
      const { market, reference, text } = await openingPrice(pair);
      // The very figure the header's "Last price" renders, from the same data.
      assert.equal(reference, market.selectedTicker?.price);
      assert.equal(text, expected);
      // At the pair's own precision, so the form's own check accepts it as typed.
      assert.equal(text.split(".")[1]?.length, PRECISION[pair]);
    });
  }

  test("extra source digits are truncated, never rounded up", () => {
    assert.equal(limitPriceText("82118.45999999", 2), "82118.45");
    assert.equal(limitPriceText("142.3509", 3), "142.350");
    assert.equal(limitPriceText("100", 2), "100.00");
  });
});

/* ------------------------------------------- D, E: refreshes never overwrite */

describe("D: a market-data refresh never overwrites the Price", () => {
  const precision = 2;

  test("a filled, unedited price is not replaced by a newer one", () => {
    assert.equal(seedLimitPrice({ edited: false, current: "82118.45", reference: "82200.00000000", pricePrecision: precision }), null);
  });

  test("a price the customer typed is never replaced", () => {
    assert.equal(seedLimitPrice({ edited: true, current: "80000", reference: "82200.00000000", pricePrecision: precision }), null);
  });

  test("a field the customer cleared stays cleared", () => {
    assert.equal(seedLimitPrice({ edited: true, current: "", reference: "82200.00000000", pricePrecision: precision }), null);
    assert.equal(seedLimitPrice({ edited: true, current: "0", reference: "82200.00000000", pricePrecision: precision }), null);
  });

  test("a failed refresh (no price) leaves the field as it is", () => {
    assert.equal(seedLimitPrice({ edited: false, current: "82118.45", reference: null, pricePrecision: precision }), null);
    assert.equal(seedLimitPrice({ edited: true, current: "80000", reference: null, pricePrecision: precision }), null);
  });

  test("an empty, unedited field is filled once a price arrives — then left alone", () => {
    // The page opened while the source was down: nothing to fill, nothing invented.
    let current = limitPriceText(null, precision) ?? "";
    assert.equal(current, "");
    // The next refresh brings a price: the field fills, exactly once.
    const filled = seedLimitPrice({ edited: false, current, reference: "82118.45000000", pricePrecision: precision });
    assert.equal(filled, "82118.45");
    current = filled ?? current;
    assert.equal(seedLimitPrice({ edited: false, current, reference: "82118.45000000", pricePrecision: precision }), null);
    assert.equal(seedLimitPrice({ edited: false, current, reference: "83000.00000000", pricePrecision: precision }), null);
  });

  test("a zero in an unedited field is no price, so it is filled", () => {
    assert.equal(seedLimitPrice({ edited: false, current: "0.00", reference: "82118.45", pricePrecision: precision }), "82118.45");
  });

  test("OrderForm marks the field edited on every keystroke and seeds only through seedLimitPrice", () => {
    const code = stripComments(read("app/trade/OrderForm.tsx"));
    assert.match(code, /setPriceText\(event\.target\.value\);\s*setPriceEdited\(true\);/);
    assert.match(code, /const seededPrice = seedLimitPrice\(\{\s*edited: priceEdited,\s*current: priceText,\s*reference: referencePrice,/);
    assert.match(code, /if \(seededPrice !== null\) setPriceText\(seededPrice\);/);
    // Every later write of the Price: the seed, a keystroke, the post-placement reset.
    const writes = [...code.matchAll(/setPriceText\(([^)]*)\)/g)].map((m) => m[1]);
    assert.deepEqual(writes.sort(), ['""', "event.target.value", "seededPrice"].sort());
  });
});

describe("E: a market-data refresh never touches the Amount", () => {
  test("the Amount is written only by the customer and by the reset after a placement", () => {
    const code = stripComments(read("app/trade/OrderForm.tsx"));
    assert.match(code, /const \[amountText, setAmountText\] = useState\(""\);/);
    const writes = [...code.matchAll(/setAmountText\(([^)]*)\)/g)].map((m) => m[1]);
    assert.deepEqual(writes.sort(), ['""', "event.target.value"].sort());
  });

  test("the seed has no Amount input or output", () => {
    const seeded = seedLimitPrice({ edited: false, current: "", reference: "82118.45", pricePrecision: 2 });
    assert.equal(typeof seeded, "string");
  });
});

/* ----------------------------------------------------- F: pair change */

describe("F: another pair starts a fresh form at that pair's price", () => {
  test("the terminal keys the form by pair and passes that pair's reference", () => {
    const code = stripComments(read("app/trade/TradeTerminal.tsx"));
    assert.match(code, /<OrderForm\s+key=\{selected\.symbol\}/);
    assert.match(code, /referencePrice=\{referencePriceFor\(market, selected\.symbol\)\}/);
  });

  test("each pair opens at its own price and precision", async () => {
    assert.equal((await openingPrice("BTC-USDT")).text, "82118.45");
    assert.equal((await openingPrice("SOL-USDT")).text, "142.350");
  });

  test("data for a different pair never fills this pair's form", async () => {
    const btc = await buildTerminalMarketData(publicSource().provider, "BTC-USDT", quiet);
    assert.equal(referencePriceFor(btc, "BTC-USDT"), "82118.45");
    assert.equal(referencePriceFor(btc, "ETH-USDT"), null);
  });
});

/* -------------------------------------------- G: invalid data → no price */

describe("G: invalid market data never becomes a price", () => {
  const BAD: unknown[] = [
    null,
    undefined,
    "",
    " 82118.45",
    "82118.45 ",
    "-82118.45",
    "+82118.45",
    "8.211845e4",
    "NaN",
    "Infinity",
    "82,118.45",
    "82118,45",
    "0x10",
    ".5",
    "5.",
    "0",
    "0.00000000",
    "0.001", // truncates to 0.00 at precision 2
    `1${"0".repeat(25)}`, // beyond numeric(38,18)
    82118.45,
    82118n,
    {},
  ];
  for (const value of BAD) {
    test(`${typeof value === "string" ? JSON.stringify(value) : String(value)} → no price`, () => {
      assert.equal(limitPriceText(value, 2), null);
      if (typeof value === "string" || value === null) {
        assert.equal(seedLimitPrice({ edited: false, current: "", reference: value, pricePrecision: 2 }), null);
      }
    });
  }

  test("an invalid precision gives no price", () => {
    for (const precision of [-1, 2.5, 19]) assert.equal(limitPriceText("82118.45", precision), null);
  });

  test("an upstream JSON number in the price is refused at the adapter — the form stays empty", async () => {
    const { text, market } = await openingPrice("BTC-USDT", publicSource({ ...LAST_PRICES, BTCUSDT: 82118.45 }));
    assert.equal(market.selectedTicker, null);
    assert.equal(text, "");
  });

  test("an upstream zero price leaves the form empty", async () => {
    const { text } = await openingPrice("BTC-USDT", publicSource({ ...LAST_PRICES, BTCUSDT: "0.00000000" }));
    assert.equal(text, "");
  });

  test("the source being down leaves the form empty — no substitute figure", async () => {
    const { text, reference } = await openingPrice("BTC-USDT", publicSource(LAST_PRICES, 503));
    assert.equal(reference, null);
    assert.equal(text, "");
  });

  test("a market that is not available gives no reference, whatever it carries", () => {
    const stale = {
      pair: "BTC-USDT",
      kind: "live" as const,
      available: false,
      pairSupported: true,
      selectedTicker: { price: "82118.45", changePercent24h: null, high24h: null, low24h: null, volume24h: null },
    };
    assert.equal(referencePriceFor(stale, "BTC-USDT"), null);
  });
});

/* -------------------------------------------- H: unsupported pairs */

describe("H: a pair the source does not cover gets no price", () => {
  for (const pair of ["TRX-USDT", "USDC-USDT", "BTC-BRL"]) {
    test(pair, async () => {
      const source = publicSource();
      const market = await buildTerminalMarketData(source.provider, pair, quiet);
      assert.equal(market.pairSupported, false);
      assert.equal(referencePriceFor(market, pair), null);
      assert.equal(limitPriceText(referencePriceFor(market, pair), 2), null);
      // Not even asked for: the only request is the list of covered pairs.
      assert.ok(source.urls.every((u) => u.searchParams.get("symbol") === null));
    });
  }

  test("not covered means no reference even if a ticker were present", () => {
    const market = {
      pair: "TRX-USDT",
      kind: "live" as const,
      available: true,
      pairSupported: false,
      selectedTicker: { price: "0.25", changePercent24h: null, high24h: null, low24h: null, volume24h: null },
    };
    assert.equal(referencePriceFor(market, "TRX-USDT"), null);
  });

  test("demo figures and no provider never fill a real order form", async () => {
    const demo = await buildTerminalMarketData(new PrototypeMarketDataProvider(() => new Date("2026-10-19T12:00:00Z")), "BTC-USDT", quiet);
    assert.equal(demo.kind, "demo");
    assert.ok(demo.selectedTicker, "the demo source does quote the pair");
    assert.equal(referencePriceFor(demo, "BTC-USDT"), null);

    // No provider selected (the shape of UnavailableMarketDataProvider): every read refuses.
    const refuse = async (): Promise<never> => {
      throw new AppError("MARKET_DATA_UNAVAILABLE");
    };
    const unavailable: MarketDataProvider = {
      name: "unavailable",
      kind: "unavailable",
      isConfigured: () => false,
      supportsPair: () => false,
      getTickers: refuse,
      getTicker: refuse,
      getCandles: refuse,
      getOrderBook: refuse,
      getRecentTrades: refuse,
    };
    const none = await buildTerminalMarketData(unavailable, "BTC-USDT", quiet);
    assert.equal(referencePriceFor(none, "BTC-USDT"), null);
  });
});

/* --------------------------------- I, J: the server previews and decides */

const m = (v: string): Money => parseMoney(v);

const resolvedPair = (symbol: keyof typeof PRECISION): ResolvedPair => {
  const [base, quote] = symbol.split("-") as [string, string];
  return {
    symbol,
    baseAsset: base,
    quoteAsset: quote,
    tradingEnabled: true,
    pricePrecision: PRECISION[symbol],
    amountPrecision: symbol === "SOL-USDT" ? 6 : 8,
    minOrderSize: m(symbol === "BTC-USDT" ? "0.0001" : symbol === "ETH-USDT" ? "0.001" : "0.01"),
    maxOrderSize: null,
    pairId: `pair-${base}`,
    baseAssetId: `asset-${base}`,
    quoteAssetId: `asset-${quote}`,
  };
};

const TRADE_FEE: ResolvedFeeRule = { percentage: m("0.2"), fixedFee: m("0"), minFee: null, maxFee: null };

function serverDeps(symbol: keyof typeof PRECISION, fee: ResolvedFeeRule = TRADE_FEE): OrderEngineDeps {
  const refuse = async (): Promise<never> => {
    throw new AppError("INTERNAL");
  };
  return {
    authorize: async () => ({ userId: "user-1", tierCode: "TIER_0", status: "ACTIVE" }),
    loadPair: async () => resolvedPair(symbol),
    checkLimits: refuse,
    resolveFeeRule: async () => fee,
    placeOrder: refuse,
    readOrder: refuse,
    cancelOrderRpc: refuse,
  };
}

/** The filled price and a typed amount, through the server action's parser and the engine's preview. */
async function serverPreview(symbol: keyof typeof PRECISION, priceInput: string, amountInput: string, fee?: ResolvedFeeRule) {
  const parsed = parseOrderAmounts({ type: "LIMIT", priceInput, amountInput });
  assert.ok(parsed.ok, `the server parser refused ${priceInput}`);
  return previewOrder(serverDeps(symbol, fee), {
    pairSymbol: symbol,
    side: "BUY",
    type: "LIMIT",
    price: parsed.price,
    amount: parsed.amount,
    clientOrderId: null,
  });
}

describe("I: the filled price previews like a typed one", () => {
  for (const [pair, amount, notional, fee, reserved] of [
    ["BTC-USDT", "0.001", "82.11845", "0.1642369", "82.2826869"],
    ["ETH-USDT", "0.01", "30.1257", "0.0602514", "30.1859514"],
    ["SOL-USDT", "0.5", "71.175", "0.14235", "71.31735"],
  ] as const) {
    test(`${pair}: server-computed value, fee and reserve`, async () => {
      const { text } = await openingPrice(pair);
      const result = await serverPreview(pair, text, amount);
      if (!result.ok) assert.fail(`${result.code}: ${result.message}`);
      assert.equal(result.preview.notional, m(notional));
      assert.equal(result.preview.fee, m(fee));
      assert.equal(result.preview.reservedAsset, "USDT");
      assert.equal(result.preview.reservedAmount, m(reserved));
    });
  }
});

describe("J: the server stays authoritative", () => {
  test("an edited price is re-validated on the server against the pair's precision", async () => {
    const result = await serverPreview("BTC-USDT", "82118.456", "0.001");
    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.code, "VALIDATION_FAILED");
  });

  test("the fee comes from the server's rule, not the form", async () => {
    const result = await serverPreview("BTC-USDT", "82118.45", "0.001", { ...TRADE_FEE, percentage: m("0.5") });
    assert.ok(result.ok);
    assert.equal(result.preview.fee, m("0.41059225"));
  });

  test("the form can send intent only — no fee, reserve, balance, tier or user", () => {
    const actions = stripComments(read("app/trade/actions.ts"));
    const body = /export type TradeActionInput = \{([\s\S]*?)\n\};/.exec(actions)?.[1] ?? "";
    const keys = [...body.matchAll(/^\s*(\w+)\??:/gm)].map((k) => k[1]).sort();
    assert.deepEqual(keys, ["amountInput", "clientOrderId", "pairSymbol", "priceInput", "side", "type"]);
  });

  test("no server or money-moving code reads the form's reference price", () => {
    const dirs = ["lib/engines", "lib/settlement", "lib/execution", "lib/trade", "lib/wallets", "lib/db", "app/api"];
    const list = [...dirs.flatMap((d) => files(path.join(SRC, d))), path.join(SRC, "app/trade/actions.ts")];
    for (const file of list) {
      assert.doesNotMatch(readFileSync(file, "utf8"), /limit-price/, `${path.relative(SRC, file)} imports limit-price`);
    }
  });

  test("limit valuation keeps BTC/ETH/SOL-USD → the USDT pair (1 USDT taken as 1 USD), with no FX conversion", async () => {
    assert.deepEqual([...USD_VALUATION_CROSSES], [
      ["BTC-USD", "BTC-USDT"],
      ["ETH-USD", "ETH-USDT"],
      ["SOL-USD", "SOL-USDT"],
    ]);
    const source = publicSource();
    const ticker = await source.provider.getTicker("BTC-USD");
    assert.equal(ticker.price, "82118.45");
    assert.equal(source.urls.at(-1)?.searchParams.get("symbol"), "BTCUSDT");
    await assert.rejects(source.provider.getTicker("BTC-EUR"));
    await assert.rejects(source.provider.getTicker("USDT-USD"));
  });
});

/* ------------------------------------- K, L: one source, server-side only */

describe("K: the browser never calls Binance", () => {
  const clientFiles = [...files(path.join(SRC, "app")), ...files(path.join(SRC, "components"))].filter((f) =>
    /^\s*["']use client["']/.test(readFileSync(f, "utf8")),
  );

  test("there are client components to check", () => assert.ok(clientFiles.length > 5));

  for (const file of clientFiles) {
    test(path.relative(SRC, file), () => {
      const code = stripComments(readFileSync(file, "utf8"));
      assert.doesNotMatch(code, /binance/i);
      assert.ok(!code.includes(new URL(MARKET_DATA_BASE_URL).host));
      for (const spec of runtimeImports(code)) {
        assert.doesNotMatch(spec, /providers\/market-data|markets\/ticker|markets\/terminal/, `imports ${spec}`);
      }
      // A client fetch may only reach this app's own API.
      for (const call of code.matchAll(/\bfetch\(\s*([`"'])([^`"']*)/g)) {
        assert.ok(call[2]!.startsWith("/api/"), `fetches ${call[2]}`);
      }
    });
  }
});

describe("L: the market-data seam is the form's only price source", () => {
  test("the helper imports only the money module (and types)", () => {
    const code = read("app/trade/limit-price.ts");
    assert.deepEqual(runtimeImports(code), ["../../lib/money.ts"]);
    assert.ok(!/\bfetch\(/.test(stripComments(code)));
  });

  test("the reference is read from the terminal's market data, which the header also renders", () => {
    const terminal = stripComments(read("app/trade/TradeTerminal.tsx"));
    assert.match(terminal, /const market = useTerminalMarketData\(initialMarket\);/);
    assert.match(terminal, /const ticker = market\.selectedTicker;/);
    assert.match(terminal, /referencePriceFor\(market, selected\.symbol\)/);
  });

  test("OrderForm has no other price source", () => {
    const form = stripComments(read("app/trade/OrderForm.tsx"));
    for (const spec of runtimeImports(form)) {
      assert.doesNotMatch(spec, /market-data|markets\/|useTerminalMarketData/, `imports ${spec}`);
    }
    assert.ok(!/\bfetch\(/.test(form));
  });

  test("only public market data is a reference", () => {
    const base: Pick<TerminalMarketData, "pair" | "available" | "pairSupported" | "selectedTicker"> = {
      pair: "BTC-USDT",
      available: true,
      pairSupported: true,
      selectedTicker: { price: "82118.45", changePercent24h: null, high24h: null, low24h: null, volume24h: null },
    };
    assert.equal(referencePriceFor({ ...base, kind: "live" }, "BTC-USDT"), "82118.45");
    assert.equal(referencePriceFor({ ...base, kind: "demo" }, "BTC-USDT"), null);
    assert.equal(referencePriceFor({ ...base, kind: "unavailable" }, "BTC-USDT"), null);
  });
});

/* ------------------------------------- M: nothing below the form changed */

describe("M: execution, settlement and the ledger do not see the form's price", () => {
  test("the helper names no write path", () => {
    const code = stripComments(read("app/trade/limit-price.ts"));
    for (const word of [".rpc(", ".insert(", ".update(", ".upsert(", "place_limit_order", "apply_fill", "ledger_post", "createAdminClient", "Action("]) {
      assert.ok(!code.includes(word), `limit-price.ts contains ${word}`);
    }
  });

  test("what the form submits is still only the Price text — filled or typed", () => {
    const form = stripComments(read("app/trade/OrderForm.tsx"));
    const calls = [...form.matchAll(/(?:place|preview)LimitOrderAction\(\{([\s\S]*?)\}\)/g)].map((c) => c[1]!.replace(/\s+/g, " ").trim());
    assert.equal(calls.length, 2);
    for (const call of calls) {
      assert.match(call, /priceInput: priceText,/);
      assert.doesNotMatch(call, /referencePrice|seed/);
    }
  });
});

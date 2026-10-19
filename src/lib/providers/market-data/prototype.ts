import {
  absMoney,
  addMoney,
  divideMoney,
  isZero,
  maxMoney,
  minMoney,
  moneyFromUnits,
  multiplyMoney,
  parseMoney,
  percentageOf,
  subtractMoney,
  toDecimalString,
  type DecimalString,
  type Money,
} from "../../money.ts";

import type {
  Candle,
  CandleInterval,
  MarketDataKind,
  MarketDataProvider,
  OrderBook,
  OrderBookLevel,
  PublicTrade,
  Ticker,
} from "./types";

/**
 * A DETERMINISTIC PROTOTYPE market-data source (sanctioned demo data).
 *
 * ---------------------------------------------------------------------------
 * What this is — and is not
 * ---------------------------------------------------------------------------
 *
 * This is NOT a market feed and the numbers are NOT real. It is a prototype
 * source so the product has something to show on every price-bearing surface
 * while no real feed is connected. `kind` is "demo", and every surface that
 * renders these figures says "Demo data" — a demo price must never be mistaken
 * for a market one.
 *
 * Two rules make it safe to show:
 *   1. DETERMINISTIC and STABLE. A pair's figures are a pure function of the
 *      pair symbol and the current UTC day — no `Math.random()`, the same for
 *      every viewer, moving once a day.
 *   2. FLOAT-FREE. Every money figure is computed through the `@/lib/money`
 *      helpers (exact `Money`) and crosses out as a `DecimalString`. The only
 *      raw integer arithmetic here is the hash and the integer "unit counts"
 *      that build a scaled amount — never an operation on a `Money` value.
 *
 * It still may not move money: it only quotes. The engines refuse MARKET
 * execution and settlement needs a real `ExecutionFill`; a demo price changes
 * neither.
 */

type SeedPair = {
  /** Demo mid price as an exact decimal string — the day-0 anchor. */
  mid: string;
  /** Pair price precision (matches trading_pairs) — used to size the tick. */
  pricePrecision: number;
};

const SEED: Record<string, SeedPair> = {
  "BTC-USDT": { mid: "62140.00", pricePrecision: 2 },
  "ETH-USDT": { mid: "2985.00", pricePrecision: 2 },
  "SOL-USDT": { mid: "146.200", pricePrecision: 3 },
  "TRX-USDT": { mid: "0.12850", pricePrecision: 5 },
  "USDC-USDT": { mid: "1.0001", pricePrecision: 4 },
  "BTC-BRL": { mid: "335560.00", pricePrecision: 2 },
  "ETH-BRL": { mid: "16120.00", pricePrecision: 2 },
  "USDT-BRL": { mid: "5.4020", pricePrecision: 4 },
  "USDT-RUB": { mid: "92.5000", pricePrecision: 4 },
  "BTC-RUB": { mid: "5747900.00", pricePrecision: 2 },
  "USD-BRL": { mid: "5.4000", pricePrecision: 4 },
  "EUR-USD": { mid: "1.08500", pricePrecision: 5 },
  "EUR-BRL": { mid: "5.8600", pricePrecision: 4 },
  "GBP-USD": { mid: "1.27100", pricePrecision: 5 },
  "USD-RUB": { mid: "92.5000", pricePrecision: 4 },
  "EUR-RUB": { mid: "100.3000", pricePrecision: 4 },
};

/**
 * Limit-valuation crosses. The LimitEngine values a trade in its limit currency
 * (USD) by asking for `<base>-USD`, a pair this catalog does not list, which
 * would otherwise get the synthesised unknown-pair price below — a BTC order
 * checked against a "BTC" worth a few hundred. For the demo trading set each
 * cross follows its USDT pair's demo price exactly (demo valuation treats 1 USDT
 * as 1 USD), so a limit is checked against the figure the terminal shows. They
 * are quotable through `getTicker` only; `getTickers()` still lists the catalog.
 */
const USD_VALUATION_CROSSES: Record<string, string> = {
  "BTC-USD": "BTC-USDT",
  "ETH-USD": "ETH-USDT",
  "SOL-USD": "SOL-USDT",
};

const FALLBACK_PRICE_PRECISION = 4;
const SOURCE = "jimocex-prototype";
const ONE_E15 = 10n ** 15n;
const ONE_E16 = 10n ** 16n;

/** FNV-1a over the string, masked to 64 bits. Pure, stable, no floats, no money. */
function hash(input: string): bigint {
  let h = 1469598103934665603n;
  for (let i = 0; i < input.length; i += 1) {
    h ^= BigInt(input.charCodeAt(i));
    h = (h * 1099511628211n) & 0xffffffffffffffffn;
  }
  return h;
}

/** A deterministic non-negative integer in [0, modulo) from a seed string (not money). */
function pick(seed: string, modulo: bigint): bigint {
  return hash(seed) % modulo;
}

/**
 * A signed percent as `Money` (1% === parseMoney("1")) in roughly [-band, band],
 * in 0.01% steps. The arithmetic is on the integer step count, not on a Money.
 */
function signedPercent(seed: string, band: number): Money {
  const steps = BigInt(band * 100 * 2 + 1);
  const centered = pick(seed, steps) - BigInt(band * 100); // hundredths of a percent
  return (centered * ONE_E16) as Money;
}

/** An unsigned percent as `Money` in [0, band], for a span width that is never negative. */
function unsignedPercent(seed: string, band: number): Money {
  const hundredths = pick(seed, BigInt(band * 100 + 1));
  return (hundredths * ONE_E16) as Money;
}

/** The anchor mid for a pair: the seed, or a stable synthesis for an unknown pair. */
function anchorMid(pair: string): Money {
  const seed = SEED[pair];
  if (seed) return parseMoney(seed.mid);
  // Unknown pair: a stable positive mid in [0.5, 500.5), built from an integer count.
  const thousandths = pick(`mid|${pair}`, 500_000n) + 500n;
  return (thousandths * ONE_E15) as Money;
}

function pricePrecisionFor(pair: string): number {
  return SEED[pair]?.pricePrecision ?? FALLBACK_PRICE_PRECISION;
}

/** The tick (one price-precision unit) as a `Money`-shaped scaled integer. */
function tickFor(pair: string): bigint {
  return 10n ** BigInt(18 - pricePrecisionFor(pair));
}

/** YYYY-MM-DD in UTC — the granularity at which a demo price changes. */
function utcDay(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/** A pair's demo price on a given UTC day: the anchor nudged by a daily ±4% walk. */
function priceOnDay(pair: string, day: string): Money {
  const mid = anchorMid(pair);
  return addMoney(mid, percentageOf(mid, signedPercent(`px|${pair}|${day}`, 4), "half-up"));
}

/** The previous UTC day as YYYY-MM-DD. */
function previousDay(day: string): string {
  const d = new Date(`${day}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return utcDay(d);
}

/** A deterministic positive size as a DecimalString (0.01 .. ~50, to 2 dp). */
function sizeFor(seed: string): DecimalString {
  const hundredths = pick(seed, 5000n) + 1n;
  return toDecimalString((hundredths * ONE_E16) as Money);
}

const INTERVAL_MS: Record<CandleInterval, number> = {
  "1m": 60_000,
  "5m": 5 * 60_000,
  "15m": 15 * 60_000,
  "1h": 60 * 60_000,
  "4h": 4 * 60 * 60_000,
  "1d": 24 * 60 * 60_000,
  "1w": 7 * 24 * 60 * 60_000,
};

export class PrototypeMarketDataProvider implements MarketDataProvider {
  readonly name = "prototype";
  readonly kind: MarketDataKind = "demo";

  private readonly now: () => Date;

  constructor(now: () => Date = () => new Date()) {
    this.now = now;
  }

  isConfigured(): boolean {
    return true;
  }

  /** The demo source synthesises a stable figure for any pair it is asked about. */
  supportsPair(_pair: string): boolean {
    return true;
  }

  async getTicker(pair: string): Promise<Ticker> {
    const cross = USD_VALUATION_CROSSES[pair];
    if (cross) return { ...this.tickerFor(cross, this.now()), pair };
    return this.tickerFor(pair, this.now());
  }

  async getTickers(pairs?: string[]): Promise<Ticker[]> {
    const at = this.now();
    const symbols = pairs && pairs.length > 0 ? pairs : Object.keys(SEED);
    return symbols.map((pair) => this.tickerFor(pair, at));
  }

  async getOrderBook(pair: string, depth = 12): Promise<OrderBook> {
    const at = this.now();
    const price = priceOnDay(pair, utcDay(at));
    const tick = tickFor(pair);

    const bids: OrderBookLevel[] = [];
    const asks: OrderBookLevel[] = [];
    for (let level = 1; level <= depth; level += 1) {
      const step = (tick * BigInt(level)) as Money;
      bids.push({ price: toDecimalString(subtractMoney(price, step)), amount: sizeFor(`bid|${pair}|${level}`) });
      asks.push({ price: toDecimalString(addMoney(price, step)), amount: sizeFor(`ask|${pair}|${level}`) });
    }
    return { pair, bids, asks, asOf: at, source: SOURCE };
  }

  async getCandles(pair: string, interval: CandleInterval, limit = 60): Promise<Candle[]> {
    const at = this.now();
    const step = INTERVAL_MS[interval];
    const endBucket = Math.floor(at.getTime() / step);

    const candles: Candle[] = [];
    let previousClose: Money | null = null;
    for (let i = limit - 1; i >= 0; i -= 1) {
      const bucket = endBucket - i;
      const openTime = new Date(bucket * step);
      const base = priceOnDay(pair, utcDay(openTime));
      const close = addMoney(base, percentageOf(base, signedPercent(`c|${pair}|${interval}|${bucket}`, 2), "half-up"));
      const open = previousClose ?? close;
      const wick = absMoney(percentageOf(close, signedPercent(`w|${pair}|${interval}|${bucket}`, 1), "half-up"));
      const high = addMoney(maxMoney(open, close), wick);
      const low = subtractMoney(minMoney(open, close), wick);
      candles.push({
        openTime,
        open: toDecimalString(open),
        high: toDecimalString(high),
        low: toDecimalString(low),
        close: toDecimalString(close),
        volume: sizeFor(`cv|${pair}|${interval}|${bucket}`),
      });
      previousClose = close;
    }
    return candles;
  }

  async getRecentTrades(pair: string, limit = 30): Promise<PublicTrade[]> {
    const at = this.now();
    const price = priceOnDay(pair, utcDay(at));
    const tick = tickFor(pair);

    const trades: PublicTrade[] = [];
    for (let i = 0; i < limit; i += 1) {
      const jitter = pick(`t|${pair}|${i}`, 7n) - 3n; // -3..+3 ticks
      const tradePrice = addMoney(price, (tick * jitter) as Money);
      trades.push({
        price: toDecimalString(tradePrice),
        amount: sizeFor(`ts|${pair}|${i}`),
        side: pick(`td|${pair}|${i}`, 2n) === 0n ? "BUY" : "SELL",
        executedAt: new Date(at.getTime() - i * 20_000),
      });
    }
    return trades;
  }

  private tickerFor(pair: string, at: Date): Ticker {
    const today = utcDay(at);
    const price = priceOnDay(pair, today);
    const reference = priceOnDay(pair, previousDay(today));

    const change = subtractMoney(price, reference);
    const changePercent = isZero(reference)
      ? null
      : toDecimalString(multiplyMoney(divideMoney(change, reference), parseMoney("100")));

    const spanHigh = percentageOf(price, unsignedPercent(`hi|${pair}|${today}`, 2), "half-up");
    const spanLow = percentageOf(price, unsignedPercent(`lo|${pair}|${today}`, 2), "half-up");
    const high = addMoney(maxMoney(price, reference), spanHigh);
    const low = subtractMoney(minMoney(price, reference), spanLow);

    return {
      pair,
      price: toDecimalString(price),
      change24h: toDecimalString(change),
      changePercent24h: changePercent,
      high24h: toDecimalString(high),
      low24h: toDecimalString(low),
      volume24h: this.volumeFor(pair, today),
      // The demo source quotes a single price; it does not invent a spread.
      bid: null,
      ask: null,
      asOf: at,
      source: SOURCE,
    };
  }

  /** A deterministic 24h volume in the base asset, to whole units. */
  private volumeFor(pair: string, day: string): DecimalString {
    const units = pick(`vol|${pair}|${day}`, 9_000n) + 1_000n;
    return toDecimalString(moneyFromUnits(units));
  }
}

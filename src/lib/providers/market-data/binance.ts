import { AppError } from "../../errors.ts";
import {
  asDecimalString,
  compareMoney,
  isNegative,
  isPositive,
  isZero,
  parseMoney,
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
 * Real market data from Binance's PUBLIC, read-only market-data API.
 *
 * ---------------------------------------------------------------------------
 * What this is — and is not
 * ---------------------------------------------------------------------------
 *
 * Display data only. It quotes a ticker, daily candles, an order-book snapshot
 * and recent public trades for the pairs mapped below. It has no credentials,
 * calls no account or trading endpoint, and is wired to nothing that moves
 * money: the order engine, the ledger and settlement never read it. A price it
 * returns is information, not an executable quote, and the book is not
 * liquidity — execution is a separate provider (`@/lib/execution`) that does not
 * exist yet.
 *
 * Honest failure, never a substitute figure. A timeout, an HTTP error, a rate
 * limit, a malformed or unexpected body, or a pair it does not map all end in
 * MARKET_DATA_UNAVAILABLE. Nothing falls back to the demo source or to a stale
 * value: the caller shows "unavailable", and the LimitEngine refuses an
 * operation it cannot value.
 *
 * Exact. Binance sends every price and quantity as a JSON string, so a plain
 * JSON.parse keeps them exact; each is then checked with asDecimalString(),
 * which refuses a JavaScript number outright. The only JSON numbers read are
 * epoch-millisecond timestamps, checked to be safe integers.
 *
 * Bounded. One trusted host fixed here (never from a request or the
 * environment), GET only, a timeout on every call, a cap on the response size,
 * on candles, book levels and trades, and a small per-instance cache that also
 * merges concurrent identical requests. After a 418/429 (rate limit) or a
 * 403/451 (access refused) it stops calling for a cool-down instead of retrying.
 */

/** Binance's market-data-only REST host (public data; no account endpoints). */
export const MARKET_DATA_BASE_URL = "https://data-api.binance.vision";

/** Internal pair → the source's symbol. Only these pairs are quoted; nothing is guessed. */
export const SOURCE_SYMBOLS: ReadonlyMap<string, string> = new Map([
  ["BTC-USDT", "BTCUSDT"],
  ["ETH-USDT", "ETHUSDT"],
  ["SOL-USDT", "SOLUSDT"],
]);

/**
 * Limit-valuation crosses, as in the prototype source. The LimitEngine values a
 * trade in its limit currency (USD) by asking for `<base>-USD`, which this source
 * does not list; for the mapped bases it answers with the USDT pair's real price,
 * treating 1 USDT as 1 USD — the same convention the portfolio valuation uses.
 * Quotable through getTicker only; getTickers() lists the mapped pairs.
 */
export const USD_VALUATION_CROSSES: ReadonlyMap<string, string> = new Map([
  ["BTC-USD", "BTC-USDT"],
  ["ETH-USD", "ETH-USDT"],
  ["SOL-USD", "SOL-USDT"],
]);

/** The source symbol for a listed pair, or null when this source does not cover it. */
export function sourceSymbolFor(pair: string): string | null {
  return SOURCE_SYMBOLS.get(pair) ?? null;
}

const SOURCE = "binance";

const DEFAULT_TIMEOUT_MS = 5_000;
/** Generous for 500 candles; a body larger than this is refused unread. */
const MAX_RESPONSE_CHARS = 1_000_000;
export const MAX_CANDLES = 500;
export const MAX_BOOK_DEPTH = 50;
export const MAX_TRADES = 100;
/** The `limit` values /api/v3/depth accepts, smallest first, up to MAX_BOOK_DEPTH. */
const DEPTH_LIMITS = [5, 10, 20, 50] as const;

const TICKER_TTL_MS = 10_000;
const BOOK_TTL_MS = 5_000;
const CANDLES_TTL_MS = 60_000;
const TRADES_TTL_MS = 5_000;
/** A failed call is remembered this long, so a dead upstream is not hammered. */
const FAILURE_TTL_MS = 5_000;
const RATE_LIMIT_COOLDOWN_MS = 60_000;
const ACCESS_REFUSED_COOLDOWN_MS = 300_000;
const MAX_COOLDOWN_MS = 300_000;
const MAX_CACHE_ENTRIES = 256;

const INTERVALS: ReadonlySet<CandleInterval> = new Set(["1m", "5m", "15m", "1h", "4h", "1d", "1w"]);

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export type BinanceProviderOptions = {
  /** Injected in tests; the global fetch otherwise. */
  fetch?: FetchLike;
  /** Milliseconds since the epoch; injected in tests. */
  now?: () => number;
  timeoutMs?: number;
};

const unavailable = (detail: string): AppError => new AppError("MARKET_DATA_UNAVAILABLE", `binance: ${detail}`);

/** A response that does not have the shape this adapter accepts. */
class Malformed extends Error {}

/* ===========================================================================
   Normalisation — pure, exported for tests. Each throws on anything unexpected.
   =========================================================================== */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** An exact decimal from the source, canonicalised ("62000.01000000" → "62000.01"). */
function decimal(value: unknown, field: string): Money {
  try {
    return parseMoney(asDecimalString(value, field));
  } catch (error) {
    throw new Malformed(error instanceof Error ? error.message : `${field} is not a decimal`);
  }
}

function positive(value: unknown, field: string): DecimalString {
  const amount = decimal(value, field);
  if (!isPositive(amount)) throw new Malformed(`${field} must be positive`);
  return toDecimalString(amount);
}

function nonNegative(value: unknown, field: string): DecimalString {
  const amount = decimal(value, field);
  if (isNegative(amount)) throw new Malformed(`${field} must not be negative`);
  return toDecimalString(amount);
}

/** Absent → null (unknown). Present → an exact signed decimal. */
function optionalSigned(value: unknown, field: string): DecimalString | null {
  if (value === undefined || value === null) return null;
  return toDecimalString(decimal(value, field));
}

/** Absent or zero → null (the source has no figure). Negative → malformed. */
function optionalPrice(value: unknown, field: string): DecimalString | null {
  if (value === undefined || value === null) return null;
  const amount = decimal(value, field);
  if (isNegative(amount)) throw new Malformed(`${field} must not be negative`);
  return isZero(amount) ? null : toDecimalString(amount);
}

function optionalNonNegative(value: unknown, field: string): DecimalString | null {
  if (value === undefined || value === null) return null;
  return nonNegative(value, field);
}

/** An epoch-millisecond timestamp: a JSON number that is a safe, positive integer. */
function epochMs(value: unknown, field: string): Date {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Malformed(`${field} is not an epoch-millisecond timestamp`);
  }
  return new Date(value);
}

const cmp = (a: DecimalString, b: DecimalString): -1 | 0 | 1 => compareMoney(parseMoney(a), parseMoney(b));

/** GET /api/v3/ticker/24hr (one symbol) → Ticker. */
export function normalizeTicker(raw: unknown, pair: string, symbol: string): Ticker {
  if (!isRecord(raw)) throw new Malformed("ticker is not an object");
  if (raw.symbol !== symbol) throw new Malformed(`ticker is for ${String(raw.symbol)}, not ${symbol}`);

  const high24h = optionalPrice(raw.highPrice, "highPrice");
  const low24h = optionalPrice(raw.lowPrice, "lowPrice");
  if (high24h && low24h && cmp(high24h, low24h) < 0) throw new Malformed("highPrice is below lowPrice");

  return {
    pair,
    price: positive(raw.lastPrice, "lastPrice"),
    change24h: optionalSigned(raw.priceChange, "priceChange"),
    changePercent24h: optionalSigned(raw.priceChangePercent, "priceChangePercent"),
    high24h,
    low24h,
    volume24h: optionalNonNegative(raw.volume, "volume"),
    bid: optionalPrice(raw.bidPrice, "bidPrice"),
    ask: optionalPrice(raw.askPrice, "askPrice"),
    asOf: epochMs(raw.closeTime, "closeTime"),
    source: SOURCE,
  };
}

/** GET /api/v3/klines → Candle[], oldest first, at most `limit` (the newest ones). */
export function normalizeCandles(raw: unknown, limit: number): Candle[] {
  if (!Array.isArray(raw)) throw new Malformed("klines is not an array");
  const rows = raw.slice(-limit);
  const candles: Candle[] = [];
  let previousOpen: number | null = null;
  for (const [i, row] of rows.entries()) {
    if (!Array.isArray(row) || row.length < 6) throw new Malformed(`kline ${i} is not an array of at least 6 fields`);
    const openTime = epochMs(row[0], `kline ${i} openTime`);
    const open = positive(row[1], `kline ${i} open`);
    const high = positive(row[2], `kline ${i} high`);
    const low = positive(row[3], `kline ${i} low`);
    const close = positive(row[4], `kline ${i} close`);
    const volume = nonNegative(row[5], `kline ${i} volume`);
    if (cmp(high, low) < 0) throw new Malformed(`kline ${i} high is below low`);
    for (const [name, value] of [["open", open], ["close", close]] as const) {
      if (cmp(value, low) < 0 || cmp(value, high) > 0) throw new Malformed(`kline ${i} ${name} is outside high/low`);
    }
    const time = openTime.getTime();
    if (previousOpen !== null && time <= previousOpen) throw new Malformed("klines are not in ascending time order");
    previousOpen = time;
    candles.push({ openTime, open, high, low, close, volume });
  }
  return candles;
}

function levels(raw: unknown, side: "bids" | "asks", depth: number): OrderBookLevel[] {
  if (!Array.isArray(raw)) throw new Malformed(`${side} is not an array`);
  const out: OrderBookLevel[] = [];
  for (const [i, level] of raw.slice(0, depth).entries()) {
    if (!Array.isArray(level) || level.length < 2) throw new Malformed(`${side} level ${i} is not [price, quantity]`);
    const price = positive(level[0], `${side} ${i} price`);
    const amount = positive(level[1], `${side} ${i} quantity`);
    const previous = out.at(-1);
    if (previous) {
      const order = cmp(price, previous.price);
      // Bids fall, asks rise, strictly: anything else is not a book.
      if ((side === "bids" && order >= 0) || (side === "asks" && order <= 0)) {
        throw new Malformed(`${side} are not in price order`);
      }
    }
    out.push({ price, amount });
  }
  return out;
}

/** GET /api/v3/depth → bids (best first) and asks (best first), at most `depth` each. */
export function normalizeOrderBook(raw: unknown, depth: number): { bids: OrderBookLevel[]; asks: OrderBookLevel[] } {
  if (!isRecord(raw)) throw new Malformed("depth is not an object");
  const bids = levels(raw.bids, "bids", depth);
  const asks = levels(raw.asks, "asks", depth);
  const bestBid = bids[0];
  const bestAsk = asks[0];
  if (bestBid && bestAsk && cmp(bestBid.price, bestAsk.price) >= 0) throw new Malformed("the book is crossed");
  return { bids, asks };
}

/** GET /api/v3/trades → PublicTrade[], newest first, at most `limit`. */
export function normalizeTrades(raw: unknown, limit: number): PublicTrade[] {
  if (!Array.isArray(raw)) throw new Malformed("trades is not an array");
  return raw
    .slice(-limit)
    .map((trade, i): PublicTrade => {
      if (!isRecord(trade)) throw new Malformed(`trade ${i} is not an object`);
      if (typeof trade.isBuyerMaker !== "boolean") throw new Malformed(`trade ${i} isBuyerMaker is not a boolean`);
      return {
        price: positive(trade.price, `trade ${i} price`),
        amount: positive(trade.qty, `trade ${i} qty`),
        // The buyer resting as maker means the taker sold into the bid.
        side: trade.isBuyerMaker ? "SELL" : "BUY",
        executedAt: epochMs(trade.time, `trade ${i} time`),
      };
    })
    .reverse();
}

/* ===========================================================================
   Provider
   =========================================================================== */

type CacheEntry = { expires: number; value: Promise<unknown> };

const clamp = (value: number, min: number, max: number): number => Math.min(Math.max(value, min), max);

/** A caller's count, bounded to [1, max]; anything that is not a finite number gets `fallback`. */
const boundedCount = (value: number, fallback: number, max: number): number =>
  Number.isFinite(value) ? clamp(Math.trunc(value), 1, max) : clamp(fallback, 1, max);

export class BinancePublicMarketDataProvider implements MarketDataProvider {
  readonly name = "binance";
  readonly kind: MarketDataKind = "live";

  private readonly fetchImpl: FetchLike;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly cache = new Map<string, CacheEntry>();
  /** No upstream call before this time (rate limit or access refused). */
  private coolDownUntil = 0;

  constructor(options: BinanceProviderOptions = {}) {
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
    this.now = options.now ?? (() => Date.now());
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** Public market data needs no credentials, so there is nothing to configure. */
  isConfigured(): boolean {
    return true;
  }

  supportsPair(pair: string): boolean {
    return SOURCE_SYMBOLS.has(pair);
  }

  async getTicker(pair: string): Promise<Ticker> {
    const listed = USD_VALUATION_CROSSES.get(pair) ?? pair;
    const symbol = this.symbolFor(listed);
    const ticker = await this.cached(`ticker:${symbol}`, TICKER_TTL_MS, async () => {
      const raw = await this.getJson("/api/v3/ticker/24hr", { symbol });
      return this.normalized("ticker", () => normalizeTicker(raw, listed, symbol));
    });
    return listed === pair ? ticker : { ...ticker, pair };
  }

  async getTickers(pairs?: string[]): Promise<Ticker[]> {
    const requested = pairs && pairs.length > 0 ? pairs : [...SOURCE_SYMBOLS.keys()];
    // Pairs this source does not cover are left out, never synthesised.
    const covered = [...new Set(requested)].filter((pair) => SOURCE_SYMBOLS.has(pair));
    if (covered.length === 0) return [];
    const symbols = covered.map((pair) => SOURCE_SYMBOLS.get(pair)!).sort();

    const bySymbol = await this.cached(`tickers:${symbols.join(",")}`, TICKER_TTL_MS, async () => {
      const raw = await this.getJson("/api/v3/ticker/24hr", { symbols: JSON.stringify(symbols) });
      return this.normalized("tickers", () => {
        if (!Array.isArray(raw)) throw new Malformed("tickers is not an array");
        const out = new Map<string, Ticker>();
        for (const pair of covered) {
          const symbol = SOURCE_SYMBOLS.get(pair)!;
          const entry = raw.find((item) => isRecord(item) && item.symbol === symbol);
          // A missing or malformed entry leaves that one pair unquoted ("—").
          if (entry === undefined) continue;
          try {
            out.set(pair, normalizeTicker(entry, pair, symbol));
          } catch (error) {
            if (!(error instanceof Malformed)) throw error;
          }
        }
        if (out.size === 0) throw new Malformed("no ticker in the response could be read");
        return out;
      });
    });
    return covered.flatMap((pair) => {
      const ticker = bySymbol.get(pair);
      return ticker ? [ticker] : [];
    });
  }

  async getOrderBook(pair: string, depth = 12): Promise<OrderBook> {
    const symbol = this.symbolFor(pair);
    const wanted = boundedCount(depth, 12, MAX_BOOK_DEPTH);
    const limit = DEPTH_LIMITS.find((l) => l >= wanted) ?? MAX_BOOK_DEPTH;
    const book = await this.cached(`book:${symbol}:${limit}`, BOOK_TTL_MS, async () => {
      const raw = await this.getJson("/api/v3/depth", { symbol, limit: String(limit) });
      // The depth snapshot carries no timestamp: asOf is when it was fetched.
      const asOf = new Date(this.now());
      return { ...this.normalized("depth", () => normalizeOrderBook(raw, limit)), asOf };
    });
    return {
      pair,
      bids: book.bids.slice(0, wanted),
      asks: book.asks.slice(0, wanted),
      asOf: book.asOf,
      source: SOURCE,
    };
  }

  async getCandles(pair: string, interval: CandleInterval, limit = 60): Promise<Candle[]> {
    const symbol = this.symbolFor(pair);
    if (!INTERVALS.has(interval)) throw unavailable(`unsupported candle interval ${String(interval)}`);
    const count = boundedCount(limit, 60, MAX_CANDLES);
    return this.cached(`candles:${symbol}:${interval}:${count}`, CANDLES_TTL_MS, async () => {
      const raw = await this.getJson("/api/v3/klines", { symbol, interval, limit: String(count) });
      return this.normalized("klines", () => normalizeCandles(raw, count));
    });
  }

  async getRecentTrades(pair: string, limit = 30): Promise<PublicTrade[]> {
    const symbol = this.symbolFor(pair);
    const count = boundedCount(limit, 30, MAX_TRADES);
    return this.cached(`trades:${symbol}:${count}`, TRADES_TTL_MS, async () => {
      const raw = await this.getJson("/api/v3/trades", { symbol, limit: String(count) });
      return this.normalized("trades", () => normalizeTrades(raw, count));
    });
  }

  /* -------------------------------------------------------------- plumbing */

  private symbolFor(pair: string): string {
    const symbol = sourceSymbolFor(pair);
    if (!symbol) throw unavailable(`no source symbol for ${pair}`);
    return symbol;
  }

  private normalized<T>(what: string, build: () => T): T {
    try {
      return build();
    } catch (error) {
      if (error instanceof Malformed) throw unavailable(`malformed ${what}: ${error.message}`);
      throw error;
    }
  }

  /**
   * One upstream result per key per TTL, shared by concurrent callers. A failure
   * is kept for FAILURE_TTL_MS so a broken upstream is not called on every render.
   */
  private cached<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
    const now = this.now();
    const hit = this.cache.get(key);
    if (hit && hit.expires > now) return hit.value as Promise<T>;

    const value = load();
    this.cache.delete(key);
    this.cache.set(key, { expires: now + ttlMs, value });
    value.catch(() => {
      const entry = this.cache.get(key);
      if (entry?.value === value) entry.expires = Math.min(entry.expires, this.now() + FAILURE_TTL_MS);
    });
    while (this.cache.size > MAX_CACHE_ENTRIES) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
    return value;
  }

  private async getJson(path: string, params: Record<string, string>): Promise<unknown> {
    if (this.now() < this.coolDownUntil) throw unavailable("cooling down after the upstream refused requests");

    const url = new URL(path, MARKET_DATA_BASE_URL);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);

    // One deadline for the whole exchange — headers and body. An explicit timer
    // (not AbortSignal.timeout, whose timer does not hold the process open) so the
    // deadline fires whatever the fetch implementation does.
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(new DOMException("deadline exceeded", "TimeoutError")), this.timeoutMs);
    const failed = (error: unknown, what: string): AppError => {
      const name = error instanceof Error ? error.name : "error";
      return unavailable(controller.signal.aborted || name === "TimeoutError" ? "request timed out" : `${what} (${name})`);
    };

    let text: string;
    try {
      let response: Response;
      try {
        response = await this.fetchImpl(url.toString(), {
          method: "GET",
          headers: { accept: "application/json" },
          cache: "no-store",
          signal: controller.signal,
        });
      } catch (error) {
        throw failed(error, "request failed");
      }

      if (!response.ok) {
        this.noteRefusal(response);
        throw unavailable(`HTTP ${response.status} from ${path}`);
      }

      const declared = response.headers.get("content-length");
      if (declared !== null && exceedsLimit(declared, MAX_RESPONSE_DIGITS)) {
        throw unavailable(`response from ${path} is too large`);
      }

      try {
        text = await response.text();
      } catch (error) {
        throw failed(error, "reading the response failed");
      }
    } finally {
      clearTimeout(deadline);
    }
    if (text.length > MAX_RESPONSE_CHARS) throw unavailable(`response from ${path} is too large`);

    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw unavailable(`response from ${path} is not JSON`);
    }
  }

  /** 418/429: back off for Retry-After (bounded). 403/451: access refused — back off longer. */
  private noteRefusal(response: Response): void {
    const { status } = response;
    let coolDown = 0;
    if (status === 418 || status === 429) {
      const retryAfter = response.headers.get("retry-after");
      coolDown =
        retryAfter !== null && /^\d{1,3}$/.test(retryAfter)
          ? clamp(1000 * digitsToInteger(retryAfter), 1_000, MAX_COOLDOWN_MS)
          : RATE_LIMIT_COOLDOWN_MS;
    } else if (status === 403 || status === 451) {
      coolDown = ACCESS_REFUSED_COOLDOWN_MS;
    }
    if (coolDown > 0) this.coolDownUntil = Math.max(this.coolDownUntil, this.now() + coolDown);
  }
}

/** The response-size cap as a digit string, so a Content-Length is compared without parsing it. */
const MAX_RESPONSE_DIGITS = "1000000";

/** True when `declared` (a header) is not a plain digit string, or names more than `limit`. */
function exceedsLimit(declared: string, limit: string): boolean {
  if (!/^\d+$/.test(declared)) return true;
  const digits = declared.replace(/^0+(?=\d)/, "");
  return digits.length > limit.length || (digits.length === limit.length && digits > limit);
}

/** A short digit string (a header value, a count — never money) as an integer, digit by digit. */
function digitsToInteger(digits: string): number {
  let value = 0;
  for (const char of digits) value = value * 10 + (char.charCodeAt(0) - 48);
  return value;
}

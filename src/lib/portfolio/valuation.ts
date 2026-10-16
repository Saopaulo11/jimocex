import {
  divideMoney,
  formatMoney,
  isPositive,
  isZero,
  maxMoney,
  minMoney,
  multiplyMoney,
  parseMoney,
  toDecimalString,
  type DecimalString,
  type Money,
} from "../money.ts";

/**
 * Pure portfolio valuation (Slice 7.3/7.6).
 *
 * Converts a holding into a single reporting currency (USD) using whatever pair
 * prices are available, so a dashboard can show one "portfolio value". It is
 * display-only and NON-AUTHORITATIVE: the ledger is the source of truth for what
 * a customer holds, and this only values it for a glance. When the prices come
 * from the demo source, the whole valuation is demo and every surface says so.
 *
 * Exact throughout — every figure is `Money`, so a valuation never launders a
 * number through a float. Pure (money imported relatively) so it is unit-tested
 * with `node --test` and reused by both the dashboard and the portfolio page.
 */

const ONE = parseMoney("1");

/** Pair symbol ("BTC-USDT") → price as an exact decimal string. */
export type PriceMap = ReadonlyMap<string, string>;

/**
 * The USD price of one unit of `symbol`, derived from the available pairs, or
 * null when nothing connects it to USD.
 *
 * USDT and USDC are treated as ≈ USD for a demo valuation (they are the quote of
 * most pairs); a real reporting pipeline would price them against a USD feed.
 */
export function usdPriceOf(symbol: string, prices: PriceMap): Money | null {
  if (symbol === "USD") return ONE;
  if (symbol === "USDT") {
    const direct = prices.get("USDT-USD");
    return direct ? parseMoney(direct) : ONE;
  }

  // Priced directly in USD (or USDT, taken as USD for the demo): one unit of
  // `symbol` is worth this many USD.
  const direct = prices.get(`${symbol}-USD`) ?? prices.get(`${symbol}-USDT`);
  if (direct) return parseMoney(direct);

  // `symbol` is the quote of a USD/USDT pair — invert: USD per `symbol`.
  const inverse = prices.get(`USD-${symbol}`) ?? prices.get(`USDT-${symbol}`);
  if (inverse) {
    const rate = parseMoney(inverse);
    return isZero(rate) ? null : divideMoney(ONE, rate);
  }

  return null;
}

/** The USD value of `amount` units at `usdPrice`, or null when unpriced. */
export function valueInUsd(amount: Money, usdPrice: Money | null): Money | null {
  return usdPrice === null ? null : multiplyMoney(amount, usdPrice);
}

/** `value` as a percentage of `total`, as a decimal string, or null when total is non-positive. */
export function allocationPercent(value: Money, total: Money): DecimalString | null {
  if (!isPositive(total)) return null;
  const ratio = divideMoney(value, total);
  return toDecimalString(multiplyMoney(ratio, parseMoney("100")));
}

/**
 * An allocation percentage clamped to [0, 100] and formatted for a CSS bar
 * width. Kept here (exact, Money-based) so a page never reaches for `Number()`
 * or `toFixed()` on a money-derived figure.
 */
export function allocationBarWidth(percent: string | null): string {
  if (percent === null) return "0";
  const clamped = maxMoney(parseMoney("0"), minMoney(parseMoney("100"), parseMoney(percent)));
  return formatMoney(clamped, { decimals: 2 });
}

/** An allocation percentage for display, e.g. "33.3%", or a dash. */
export function allocationLabel(percent: string | null): string {
  if (percent === null) return "—";
  return `${formatMoney(parseMoney(percent), { decimals: 1 })}%`;
}

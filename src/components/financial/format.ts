/**
 * Display formatting for money and market figures.
 *
 * Every function here takes a Money and delegates to `formatMoney()` in
 * `@/lib/money`, so there is exactly one implementation of how an amount
 * becomes text: one set of rules for sign, zero, grouping and truncation, one
 * validator. A decimal string from the server is parsed into Money where it is
 * read (`fromDatabase()`, `parseMoney()`), never re-split here — a second
 * formatter working on raw strings would render "1e-8" as "1e-8.00" and
 * "-0.001" at two places as "-0.00".
 *
 * These functions only format. They never compute an amount, a fee or a rate —
 * those come from the server, which is the only authority on them (spec §50).
 *
 * There is no default precision. How many places an amount shows is a property
 * of its asset (`assets.decimals`) or its market (`trading_pairs.price_precision`)
 * and the caller passes it; a guessed default shows 0.009 USDT as "0.00".
 */

import { formatMoney, type Money } from "@/lib/money";

/**
 * An amount for display, grouped, truncated toward zero to `decimals` places —
 * so the magnitude shown never exceeds the magnitude held.
 */
export function formatAmount(
  value: Money,
  options: { decimals: number; minDecimals?: number; group?: boolean },
): string {
  const { decimals, minDecimals = 0, group = true } = options;
  return formatMoney(value, { decimals, minDecimals: Math.min(minDecimals, decimals), group });
}

/**
 * Direction of a figure AS DISPLAYED at `decimals` places. A change too small
 * to show is flat, so the arrow never disagrees with the digits next to it.
 */
export function signOf(value: Money, decimals = 18): "up" | "down" | "flat" {
  const shown = formatMoney(value, { decimals });
  if (!/[1-9]/.test(shown)) return "flat";
  return shown.startsWith("-") ? "down" : "up";
}

/**
 * "+2.41%" / "−1.08%" — signed, so the direction is unambiguous. `value` is in
 * percentage points: 2.41 means 2.41%.
 */
export function formatPercent(value: Money, decimals = 2): string {
  const direction = signOf(value, decimals);
  const magnitude = formatMoney(value, { decimals, minDecimals: decimals }).replace(/^-/, "");
  if (direction === "flat") return `${magnitude}%`;
  // U+2212 MINUS, not a hyphen: it aligns with the plus and with tabular digits.
  return `${direction === "up" ? "+" : "−"}${magnitude}%`;
}

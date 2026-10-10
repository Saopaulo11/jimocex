/**
 * Formatting for money and market figures.
 *
 * Everything here takes a DECIMAL STRING and returns a string. No value is ever
 * parsed into a JavaScript number on the way: `Number("0.1") + Number("0.2")`
 * is not 0.3, and a balance that has round-tripped through a float has already
 * lost precision before anything is displayed.
 *
 * These functions only format. They never compute an amount, a fee or a rate —
 * those come from the server, which is the only authority on them (spec §50).
 */

/** Splits a decimal string into sign, integer and fraction without arithmetic. */
function parts(value: string): { sign: string; whole: string; fraction: string } {
  const trimmed = value.trim();
  const negative = trimmed.startsWith("-");
  const unsigned = negative ? trimmed.slice(1) : trimmed.replace(/^\+/, "");
  const [whole = "0", fraction = ""] = unsigned.split(".");
  return { sign: negative ? "-" : "", whole: whole || "0", fraction };
}

function groupThousands(whole: string): string {
  return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/**
 * Formats an amount for display.
 *
 * `decimals` truncates rather than rounds. Rounding a balance up would show
 * more than the customer has, which is the one direction a financial figure
 * must never be wrong in.
 */
export function formatAmount(
  value: string,
  options: { decimals?: number; minDecimals?: number; group?: boolean } = {},
): string {
  const { decimals, minDecimals = 0, group = true } = options;
  const { sign, whole, fraction } = parts(value);

  let out = fraction;
  if (decimals !== undefined) out = out.slice(0, decimals);
  while (out.length < minDecimals) out += "0";

  const head = group ? groupThousands(whole) : whole;
  return out ? `${sign}${head}.${out}` : `${sign}${head}`;
}

/**
 * Sensible display precision per asset class. Crypto needs more places than
 * fiat, and a price needs more than a balance.
 */
export const ASSET_DECIMALS: Record<string, number> = {
  BTC: 8,
  ETH: 8,
  SOL: 6,
  TRX: 2,
  USDT: 2,
  USDC: 2,
  USD: 2,
  EUR: 2,
  GBP: 2,
  BRL: 2,
  RUB: 2,
};

export function displayDecimals(symbol: string): number {
  return ASSET_DECIMALS[symbol] ?? 8;
}

/** Sign of a decimal string, without converting it to a number. */
export function signOf(value: string): "up" | "down" | "flat" {
  const { sign, whole, fraction } = parts(value);
  const isZero = /^0*$/.test(whole) && /^0*$/.test(fraction);
  if (isZero) return "flat";
  return sign === "-" ? "down" : "up";
}

/** "+2.41%" / "−1.08%" — always signed, so the direction is unambiguous. */
export function formatPercent(value: string, decimals = 2): string {
  const direction = signOf(value);
  const magnitude = formatAmount(value.replace(/^-/, ""), { decimals, minDecimals: decimals });
  if (direction === "flat") return `${magnitude}%`;
  // U+2212 MINUS, not a hyphen: it aligns with the plus and with tabular digits.
  return `${direction === "up" ? "+" : "−"}${magnitude}%`;
}

import { MONEY_SCALE, formatMoney, parseAmountInput, parseMoney } from "../../lib/money.ts";
import type { TerminalMarketData } from "../../lib/markets/types.ts";

/**
 * The starting Price of the LIMIT order form (Slice 13C), from the terminal's
 * market data — the same `MarketDataProvider` seam the header's "Last price"
 * reads. Pure and I/O-free so the rules are unit-tested with `node --test`; the
 * imports are relative because node --test does not resolve `@/`.
 *
 * The figure is a convenience, not a quote: it only fills an input the customer
 * can edit. What it does NOT do —
 *
 *   * it is never sent as anything but the Price the customer submits, typed or
 *     left as filled. The server parses that string, re-validates it against the
 *     pair (positive, `price_precision`) and computes the notional, fee, reserve
 *     and limits itself; it never reads this module;
 *   * it is not executable: no execution provider is connected, so a LIMIT order
 *     rests OPEN at the customer's price whatever the market does;
 *   * it is never invented: no public market data for the pair (a pair the
 *     source does not cover, the source failing, demo or no provider) means no
 *     starting price — the field stays empty for the customer to type.
 */

/** Plain non-negative decimal only: no sign, exponent, grouping, comma or whitespace. */
const PLAIN_DECIMAL = /^\d+(\.\d+)?$/;

/**
 * The market price the form may start from: the selected pair's last price from
 * the public market-data source, or null. Demo figures never fill a real order
 * form, and neither does a response for a different pair.
 */
export function referencePriceFor(
  market: Pick<TerminalMarketData, "pair" | "kind" | "available" | "pairSupported" | "selectedTicker">,
  pairSymbol: string,
): string | null {
  if (market.kind !== "live" || !market.available || !market.pairSupported) return null;
  if (market.pair !== pairSymbol) return null;
  return market.selectedTicker?.price ?? null;
}

/**
 * The reference price as Price-field text at the pair's precision — e.g.
 * "82118.45000000" at precision 2 becomes "82118.45" — or null when it is not a
 * usable price. Extra digits are truncated (never rounded up past what the
 * source said), and the result must be text the form itself accepts: positive at
 * that precision and within numeric(38,18). A price that truncates to zero is
 * refused rather than shown as 0.
 */
export function limitPriceText(reference: unknown, pricePrecision: number): string | null {
  if (typeof reference !== "string" || !PLAIN_DECIMAL.test(reference)) return null;
  if (!Number.isInteger(pricePrecision) || pricePrecision < 0 || pricePrecision > MONEY_SCALE) return null;
  const text = formatMoney(parseMoney(reference), { decimals: pricePrecision, minDecimals: pricePrecision });
  return parseAmountInput(text, { maxDecimals: pricePrecision }).ok ? text : null;
}

/**
 * What the Price field should be set to now, or null to leave it as it is.
 *
 * Only a field the customer has not edited, and that holds no price yet (empty
 * or zero), is filled — so a price that arrives after the form opened (the first
 * read failed or was slow) still fills it, but a refresh never replaces a price
 * already there, typed or filled. Once the customer edits the field it is theirs,
 * even if they clear it.
 */
export function seedLimitPrice(state: {
  edited: boolean;
  current: string;
  reference: string | null;
  pricePrecision: number;
}): string | null {
  if (state.edited) return null;
  const current = parseAmountInput(state.current, { maxDecimals: MONEY_SCALE });
  const holdsNoPrice = !current.ok && (current.problem === "empty" || current.problem === "not_positive");
  if (!holdsNoPrice) return null;
  return limitPriceText(state.reference, state.pricePrecision);
}

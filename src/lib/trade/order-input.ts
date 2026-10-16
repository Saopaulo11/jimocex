import { MONEY_SCALE, parseAmountInput, type AmountInputProblem, type Money } from "../money.ts";
import type { OrderTypeValue } from "./types.ts";

/**
 * Parsing the raw strings a trade form submits into exact `Money`, with no I/O
 * (spec §19, §20). Kept pure and server-only-free so the trust boundary's input
 * handling is unit-testable with `node --test`, and so `actions.ts` and any
 * future route handler share one parser.
 *
 * It is deliberately lenient on decimal places (up to the full numeric(38,18)
 * scale): the asset's own precision, the pair's min/max, the fee and the
 * reserve are the ENGINE's to enforce against the resolved pair. This layer only
 * guarantees the values are exact, positive decimals — never a float, a sign, a
 * locale comma or a value outside the column — before they reach the engine.
 */

export type RawOrderInput = {
  type: OrderTypeValue;
  priceInput: string;
  amountInput: string;
};

export type ParsedOrderAmounts =
  | { ok: true; amount: Money; price: Money | null }
  | { ok: false; message: string };

/** A customer-facing message for a parse problem. Never leaks internals. */
export function amountProblemMessage(problem: AmountInputProblem, field: "price" | "amount"): string {
  switch (problem) {
    case "empty":
      return field === "price" ? "Enter a price." : "Enter an amount.";
    case "malformed":
      return `Enter a valid ${field} (digits and a single decimal point).`;
    case "too_many_decimals":
      return `This ${field} has more decimal places than the market allows.`;
    case "too_large":
      return `This ${field} is too large.`;
    case "not_positive":
      return `The ${field} must be greater than zero.`;
  }
}

/**
 * Parses the amount (always) and the price (for a LIMIT order). A MARKET order
 * carries no price here — the engine refuses MARKET regardless, so this never
 * fabricates one.
 */
export function parseOrderAmounts(input: RawOrderInput): ParsedOrderAmounts {
  const amount = parseAmountInput(input.amountInput, { maxDecimals: MONEY_SCALE });
  if (!amount.ok) return { ok: false, message: amountProblemMessage(amount.problem, "amount") };

  let price: Money | null = null;
  if (input.type === "LIMIT") {
    const parsedPrice = parseAmountInput(input.priceInput, { maxDecimals: MONEY_SCALE });
    if (!parsedPrice.ok) return { ok: false, message: amountProblemMessage(parsedPrice.problem, "price") };
    price = parsedPrice.value;
  }

  return { ok: true, amount: amount.value, price };
}

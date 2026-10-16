"use server";

import { getViewer } from "@/lib/auth/session";
import { buildExchangeQuote } from "@/lib/exchange/quote";
import type { ExchangeQuoteResult } from "@/lib/exchange/types";

/**
 * Exchange Server Action — returns a prototype quote.
 *
 * The browser sends only intent (the two assets and the amount as a string).
 * The rate and fee are computed on the server from the demo market data and the
 * real fee rules; no rate, fee or receive amount is ever accepted from the
 * client. A quote needs no sign-in; a tier (when signed in) only selects the
 * fee rule. Nothing here executes an exchange — none can be executed.
 */
export async function quoteExchangeAction(input: {
  fromSymbol: string;
  toSymbol: string;
  amountInput: string;
}): Promise<ExchangeQuoteResult> {
  const viewer = await getViewer();
  return buildExchangeQuote({
    fromSymbol: input.fromSymbol,
    toSymbol: input.toSymbol,
    amountInput: input.amountInput,
    tierCode: viewer?.profile.tier_code ?? null,
  });
}

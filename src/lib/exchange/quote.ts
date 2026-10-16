import "server-only";

import { computeFee, type ResolvedFeeRule } from "@/lib/engines/fee-rules";
import { moneySelect } from "@/lib/db/money-columns";
import {
  divideMoney,
  fromDatabase,
  fromDatabaseNullable,
  isZero,
  maxMoney,
  multiplyMoney,
  parseAmountInput,
  subtractMoney,
  toDecimalString,
  ZERO,
} from "@/lib/money";
import { getTickers } from "@/lib/markets/ticker";
import { usdPriceOf } from "@/lib/portfolio/valuation";
import { createClient } from "@/lib/supabase/server";

import type { ExchangeQuoteResult } from "./types";

/**
 * A prototype exchange quote (Slice 7.8).
 *
 * The RATE is derived from the demo market-data source; the FEE is the real
 * FeeEngine arithmetic (`computeFee`) applied to the SWAP `fee_rules` row. So
 * the quote is a genuine, exact computation — but over demo prices, which is
 * why `demo` is carried and every surface labels it.
 *
 * This quotes only. It writes nothing and settles nothing: no execution or
 * liquidity provider is connected, so an exchange cannot be performed. The quote
 * is the primitive a real convert flow would build on once a venue exists.
 */

export type { ExchangeQuote, ExchangeQuoteResult, ExchangeQuoteErrorCode } from "./types";

export async function buildExchangeQuote(input: {
  fromSymbol: string;
  toSymbol: string;
  amountInput: string;
  tierCode: string | null;
}): Promise<ExchangeQuoteResult> {
  if (input.fromSymbol === input.toSymbol) {
    return { ok: false, code: "SAME_ASSET", message: "Choose two different assets." };
  }

  const supabase = await createClient();
  const { data: assets } = await supabase
    .from("assets")
    .select("id, symbol, decimals, is_active")
    .in("symbol", [input.fromSymbol, input.toSymbol]);

  const from = assets?.find((a) => a.symbol === input.fromSymbol && a.is_active);
  const to = assets?.find((a) => a.symbol === input.toSymbol && a.is_active);
  if (!from || !to) return { ok: false, code: "UNKNOWN_ASSET", message: "That asset is not available." };

  const parsed = parseAmountInput(input.amountInput, { maxDecimals: from.decimals });
  if (!parsed.ok) {
    return { ok: false, code: "VALIDATION_FAILED", message: "Enter a valid amount greater than zero." };
  }
  const amount = parsed.value;

  const tickers = await getTickers();
  const priceMap = new Map<string, string>([...tickers.tickers.values()].map((t) => [t.pair, t.price as string]));
  const fromUsd = usdPriceOf(input.fromSymbol, priceMap);
  const toUsd = usdPriceOf(input.toSymbol, priceMap);
  if (!tickers.available || fromUsd === null || toUsd === null || isZero(toUsd)) {
    return { ok: false, code: "RATE_UNAVAILABLE", message: "No rate is available for this pair right now." };
  }

  // rate = USD(from) / USD(to): how many `to` units one `from` unit buys.
  const rate = divideMoney(fromUsd, toUsd);
  const grossReceive = multiplyMoney(amount, rate);

  const rule = await resolveSwapFeeRule(supabase, to.id ?? null, input.tierCode);
  const fee = computeFee(grossReceive, rule);
  const netReceive = maxMoney(subtractMoney(grossReceive, fee), ZERO);

  return {
    ok: true,
    quote: {
      fromSymbol: input.fromSymbol,
      toSymbol: input.toSymbol,
      fromDecimals: from.decimals,
      toDecimals: to.decimals,
      amount: toDecimalString(amount),
      rate: toDecimalString(rate),
      grossReceive: toDecimalString(grossReceive),
      fee: toDecimalString(fee),
      feeAsset: input.toSymbol,
      netReceive: toDecimalString(netReceive),
      demo: tickers.demo,
    },
  };
}

type Client = Awaited<ReturnType<typeof createClient>>;

/** The most specific active SWAP fee rule for the asset and tier, scored like the order engine. */
async function resolveSwapFeeRule(
  supabase: Client,
  toAssetId: string | null,
  tierCode: string | null,
): Promise<ResolvedFeeRule> {
  const zeroRule: ResolvedFeeRule = { percentage: ZERO, fixedFee: ZERO, minFee: null, maxFee: null };
  try {
    const { data } = await supabase
      .from("fee_rules")
      .select(moneySelect("fee_rules", "asset_id, tier_code, percentage, fixed_fee, min_fee, max_fee"))
      .eq("operation", "SWAP")
      .eq("is_active", true)
      .overrideTypes<
        {
          asset_id: string | null;
          tier_code: string | null;
          percentage: string;
          fixed_fee: string;
          min_fee: string | null;
          max_fee: string | null;
        }[],
        { merge: false }
      >();
    if (!data || data.length === 0) return zeroRule;

    const score = (row: { asset_id: string | null; tier_code: string | null }) =>
      (row.asset_id && row.asset_id === toAssetId ? 2 : row.asset_id === null ? 0 : -10) +
      (row.tier_code && row.tier_code === tierCode ? 1 : row.tier_code === null ? 0 : -10);

    const best = [...data].sort((a, b) => score(b) - score(a))[0];
    if (!best || score(best) < 0) return zeroRule;

    return {
      percentage: fromDatabase(best.percentage, "fee_rules.percentage"),
      fixedFee: fromDatabase(best.fixed_fee, "fee_rules.fixed_fee"),
      minFee: fromDatabaseNullable(best.min_fee, "fee_rules.min_fee"),
      maxFee: fromDatabaseNullable(best.max_fee, "fee_rules.max_fee"),
    };
  } catch {
    return zeroRule;
  }
}

import "server-only";

import { getMarketDataProvider } from "@/lib/providers/market-data";
import { product } from "@/config/brand";
import { moneySelect } from "@/lib/db/money-columns";
import { fromDatabase, toDecimalString } from "@/lib/money";
import { createClient } from "@/lib/supabase/server";
import type { Market, MarketsResult } from "./types";

/**
 * Reads the listed markets.
 *
 * The pairs are REAL data: they are configuration rows in `trading_pairs`, and
 * which ones exist, whether they are listed, and whether trading is enabled are
 * all genuine platform state. What is not real — and is not invented here — is
 * the price. That comes from a market data provider, and no provider is
 * connected, so every row returns without one and the UI says so.
 *
 * The temptation this function exists to resist is filling `price` with
 * something plausible. A fabricated price is indistinguishable from a real one
 * on screen, and a customer would make decisions against it.
 */


export async function listMarkets(): Promise<MarketsResult> {
  const pricesAvailable = getMarketDataProvider().isConfigured();

  try {
    const supabase = await createClient();

    // Reads through the user-scoped client. `trading_pairs` has a public read
    // policy, so this works signed out — which is what /markets needs.
    const { data, error } = await supabase
      .from("trading_pairs")
      // min_order_size is numeric(38,18); moneySelect casts it to text so the
      // exact value survives PostgREST's JSON serialisation.
      .select(
        moneySelect(
          "trading_pairs",
          "symbol, pair_type, trading_enabled, swap_enabled, price_precision, amount_precision, min_order_size, base:base_asset_id(symbol), quote:quote_asset_id(symbol)",
        ),
      )
      .eq("is_active", true)
      .order("display_order", { ascending: true })
      .overrideTypes<
        {
          symbol: string;
          pair_type: Market["type"];
          trading_enabled: boolean;
          swap_enabled: boolean;
          price_precision: number;
          amount_precision: number;
          min_order_size: string;
          base: { symbol: string } | null;
          quote: { symbol: string } | null;
        }[],
        { merge: false }
      >();

    if (error || !data) return { markets: [], configured: false, pricesAvailable };

    const markets = data.flatMap((row) => {
      // The embedded relations come back as objects; guard rather than assert,
      // so a schema change surfaces as a missing row instead of a crash.
      const base = row.base?.symbol;
      const quote = row.quote?.symbol;
      if (!base || !quote) return [];

      return [
        {
          symbol: row.symbol,
          base,
          quote,
          type: row.pair_type,
          tradingEnabled: row.trading_enabled,
          swapEnabled: row.swap_enabled,
          pricePrecision: row.price_precision,
          amountPrecision: row.amount_precision,
          // Through the gate and back out as a DecimalString: a dropped cast
          // throws here, naming the column, instead of handing the client
          // component a number that merely looks like a string in the types.
          minOrderSize: toDecimalString(
            fromDatabase(row.min_order_size, "trading_pairs.min_order_size"),
          ),
        } satisfies Market,
      ];
    });

    // Brand/product VISIBILITY filter only. `trading_pairs.trading_enabled`
    // remains the authority on whether a pair can actually be traded; an
    // allow-list here just controls what the UI surfaces (default: all).
    const visible =
      product.enabledMarkets === "all"
        ? markets
        : markets.filter((market) => product.enabledMarkets.includes(market.symbol));

    return { markets: visible, configured: true, pricesAvailable };
  } catch {
    // No Supabase configuration in this environment. The page still renders and
    // says the listing is unavailable, rather than failing the request.
    return { markets: [], configured: false, pricesAvailable };
  }
}


/**
 * Assets a customer can hold, for the exchange selectors. `decimals` is the
 * asset's own precision: what an amount input accepts (parseAmountInput's
 * maxDecimals) and how many places an amount displays.
 */
export async function listAssets(): Promise<
  { symbol: string; name: string; type: string; decimals: number }[]
> {
  try {
    const supabase = await createClient();
    const { data, error } = await supabase
      .from("assets")
      .select("symbol, name, type, decimals")
      .eq("is_active", true)
      .order("type", { ascending: true })
      .order("symbol", { ascending: true });

    if (error || !data) return [];
    return data;
  } catch {
    return [];
  }
}

export type { Market, MarketsResult, PairType } from "./types";
export { MARKET_CATEGORIES } from "./types";

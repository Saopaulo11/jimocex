/**
 * Which market-data provider a deployment uses — the pure half of the registry
 * (index.ts), kept free of `server-only` and `@/` imports so `node --test` can
 * prove the rules directly.
 *
 * Selection, in order:
 *   1. `JIMOCEX_MARKET_DATA_PROVIDER`, when set, always wins: "binance" (public
 *      market data), "prototype" (labelled demo data) or "unavailable".
 *   2. Otherwise the brand config: `product.demoMarketData: true` is an explicit
 *      opt-in to the demo source; anything else gets the public market-data
 *      provider.
 *
 * The demo source is therefore only ever used when someone chose it. A name the
 * registry does not know resolves to "unavailable", never to a working-looking
 * provider: a typo must not quietly change what numbers the platform shows, and
 * nothing here ever falls back to the demo source.
 */

export const MARKET_DATA_PROVIDER_NAMES = ["unavailable", "prototype", "binance"] as const;

export type MarketDataProviderName = (typeof MARKET_DATA_PROVIDER_NAMES)[number];

/** The real (public, read-only) provider used when nothing else is chosen. */
export const DEFAULT_MARKET_DATA_PROVIDER: MarketDataProviderName = "binance";

export type ProviderSelection = {
  name: MarketDataProviderName;
  /** The requested name when it was not recognised (and "unavailable" was used instead). */
  unknown: string | null;
};

export function resolveMarketDataProvider(
  configured: string | undefined,
  demoMarketData: boolean,
): ProviderSelection {
  const requested = configured ?? (demoMarketData ? "prototype" : DEFAULT_MARKET_DATA_PROVIDER);
  const known = (MARKET_DATA_PROVIDER_NAMES as readonly string[]).includes(requested);
  return known
    ? { name: requested as MarketDataProviderName, unknown: null }
    : { name: "unavailable", unknown: requested };
}

import "server-only";

import { UnavailableMarketDataProvider } from "./unavailable";
import type { MarketDataProvider } from "./types";

/**
 * Market data provider registry (spec §63, §64).
 *
 * Adding a real feed means writing an adapter, registering it here and setting
 * `JIMOCEX_MARKET_DATA_PROVIDER`. Nothing in a component, a page or an engine
 * changes.
 *
 * The default is deliberately the provider that refuses. A deployment with no
 * feed configured shows "unavailable" everywhere it would show a price, which
 * is the truth; silently selecting a demo source would put invented numbers on
 * a production screen.
 */

const registry = new Map<string, () => MarketDataProvider>([
  ["unavailable", () => new UnavailableMarketDataProvider()],
]);

const instances = new Map<string, MarketDataProvider>();

export function getMarketDataProvider(): MarketDataProvider {
  const name = process.env.JIMOCEX_MARKET_DATA_PROVIDER ?? "unavailable";

  const cached = instances.get(name);
  if (cached) return cached;

  const factory = registry.get(name);
  if (!factory) {
    // An unknown name falls back to refusing rather than to a working-looking
    // provider: a typo in an environment variable must not quietly change what
    // numbers the platform shows.
    console.warn(
      `[jimocex] unknown market data provider "${name}" — falling back to "unavailable"`,
    );
    const fallback = new UnavailableMarketDataProvider();
    instances.set(name, fallback);
    return fallback;
  }

  const instance = factory();
  instances.set(name, instance);
  return instance;
}

export type { MarketDataProvider } from "./types";
export * from "./types";

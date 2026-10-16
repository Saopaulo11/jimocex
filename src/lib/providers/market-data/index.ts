import "server-only";

import { product } from "@/config/brand";

import { PrototypeMarketDataProvider } from "./prototype";
import { UnavailableMarketDataProvider } from "./unavailable";
import type { MarketDataProvider } from "./types";

/**
 * Market data provider registry (spec §63, §64).
 *
 * Adding a real feed means writing an adapter, registering it here and setting
 * `JIMOCEX_MARKET_DATA_PROVIDER`. Nothing in a component, a page or an engine
 * changes.
 *
 * Selection, in order:
 *   1. `JIMOCEX_MARKET_DATA_PROVIDER` — an explicit choice always wins, so a
 *      deployment with a real feed names it and a client can force "unavailable".
 *   2. otherwise `product.demoMarketData` (brand config): the prototype demo
 *      source when true, the refusing provider when false.
 *
 * Note the ordering of the fallback: the demo source is opt-in through brand
 * config, and the honest "unavailable" provider is what a client gets the
 * moment they turn the demo off WITHOUT naming a real feed. An unknown
 * environment name also falls back to refusing rather than to a working-looking
 * provider: a typo must not quietly change what numbers the platform shows.
 * The demo source is never "live" — its `kind` is "demo", so every surface
 * labels it, and no screen can pass a demo price off as a market one.
 */

const registry = new Map<string, () => MarketDataProvider>([
  ["unavailable", () => new UnavailableMarketDataProvider()],
  ["prototype", () => new PrototypeMarketDataProvider()],
]);

const instances = new Map<string, MarketDataProvider>();

export function getMarketDataProvider(): MarketDataProvider {
  const configured = process.env.JIMOCEX_MARKET_DATA_PROVIDER;
  const name = configured ?? (product.demoMarketData ? "prototype" : "unavailable");

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

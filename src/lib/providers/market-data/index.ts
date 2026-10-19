import "server-only";

import { product } from "@/config/brand";

import { BinancePublicMarketDataProvider } from "./binance";
import { PrototypeMarketDataProvider } from "./prototype";
import { resolveMarketDataProvider, type MarketDataProviderName } from "./selection";
import { UnavailableMarketDataProvider } from "./unavailable";
import type { MarketDataProvider } from "./types";

/**
 * Market data provider registry (spec §63, §64).
 *
 * Adding another feed means writing an adapter, registering it here and setting
 * `JIMOCEX_MARKET_DATA_PROVIDER`. Nothing in a component, a page or an engine
 * changes.
 *
 * Which provider is used is decided in `./selection` (pure, unit-tested):
 *   1. `JIMOCEX_MARKET_DATA_PROVIDER` — "binance", "prototype" or "unavailable";
 *      an explicit choice always wins.
 *   2. otherwise `product.demoMarketData` (brand config): true is an explicit
 *      opt-in to the labelled demo source; otherwise the public, read-only
 *      "binance" market data.
 *
 * An unknown name resolves to "unavailable", never to a working-looking provider,
 * and no provider ever falls back to another: a source that cannot answer says
 * so, and the page shows "unavailable". The demo source's `kind` is "demo", so
 * every surface labels it, and no screen can pass a demo price off as a market one.
 *
 * Market data is display data. The order engine, the ledger and settlement do
 * not read it; the LimitEngine only values an order with it, and refuses when it
 * cannot. Execution is a different provider seam (`@/lib/execution`).
 */

const registry: Record<MarketDataProviderName, () => MarketDataProvider> = {
  unavailable: () => new UnavailableMarketDataProvider(),
  prototype: () => new PrototypeMarketDataProvider(),
  binance: () => new BinancePublicMarketDataProvider(),
};

const instances = new Map<MarketDataProviderName, MarketDataProvider>();

export function getMarketDataProvider(): MarketDataProvider {
  const { name, unknown } = resolveMarketDataProvider(
    process.env.JIMOCEX_MARKET_DATA_PROVIDER,
    product.demoMarketData,
  );
  if (unknown !== null && !instances.has(name)) {
    console.warn(`[jimocex] unknown market data provider "${unknown}" — using "unavailable"`);
  }

  const cached = instances.get(name);
  if (cached) return cached;

  // One instance per process, so the adapter's short cache and request
  // merging are shared by every page and request this instance serves.
  const instance = registry[name]();
  instances.set(name, instance);
  return instance;
}

export type { MarketDataProvider } from "./types";
export * from "./types";

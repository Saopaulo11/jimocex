import "server-only";

import { ExecutionService } from "./service";
import { UnavailableExecutionProvider } from "./unavailable";
import type { ExecutionProvider } from "./types";

/**
 * Execution provider registry (Slice 5), mirroring the market-data registry.
 *
 * Connecting a real venue means writing a `server-only` adapter that implements
 * `ExecutionProvider`, registering it here, and setting
 * `JIMOCEX_EXECUTION_PROVIDER`. Nothing in the Order Engine, the ledger, or any
 * business logic changes — the core only ever sees the interface.
 *
 * The default is the provider that refuses. A deployment with no venue
 * configured, or with a typo'd provider name, falls back to "unavailable"
 * rather than to anything that looks like it can execute — because an execution
 * seam that quietly does nothing, or quietly invents a fill, is far worse than
 * one that says it is not connected.
 *
 * Provider selection is server-side configuration. Credentials live in that
 * adapter's own server-only environment variables — never in `@/config/brand`,
 * never in a `NEXT_PUBLIC_*` variable, never in the browser bundle.
 */

const registry = new Map<string, () => ExecutionProvider>([
  ["unavailable", () => new UnavailableExecutionProvider()],
]);

const instances = new Map<string, ExecutionProvider>();

export function getExecutionProvider(): ExecutionProvider {
  const name = process.env.JIMOCEX_EXECUTION_PROVIDER ?? "unavailable";

  const cached = instances.get(name);
  if (cached) return cached;

  const factory = registry.get(name);
  if (!factory) {
    console.warn(`[jimocex] unknown execution provider "${name}" — falling back to "unavailable"`);
    const fallback = new UnavailableExecutionProvider();
    instances.set(name, fallback);
    return fallback;
  }

  const instance = factory();
  instances.set(name, instance);
  return instance;
}

/** The Execution Service over the configured provider. */
export function getExecutionService(): ExecutionService {
  return new ExecutionService(getExecutionProvider());
}

export { ExecutionService } from "./service";
export type { ExecutionResult, ExecutionServiceOptions } from "./service";
export * from "./types";

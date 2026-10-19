import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";

import { BinancePublicMarketDataProvider } from "../binance.ts";

/**
 * Market data cannot move money (Slice 13A).
 *
 * Statically, over the source tree:
 *   * the market-data modules import nothing that writes — no Supabase client,
 *     no database helper, no engine, ledger, settlement, execution or trade
 *     module — and call no RPC or table write;
 *   * nothing that moves money (order engine, settlement, execution, trade
 *     actions, wallets, ledger helpers) imports market data, except the
 *     LimitEngine, which only VALUES an order with it (and refuses without it).
 * And behaviourally: the public adapter exposes only the read interface.
 */

const SRC = path.resolve(import.meta.dirname, "../../../..");

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return name === "__tests__" ? [] : files(full);
    return /\.(ts|tsx)$/.test(name) ? [full] : [];
  });
}

const rel = (file: string) => path.relative(SRC, file).split(path.sep).join("/");

/** Import specifiers (static and dynamic), read from code with comments removed. */
function imports(file: string): string[] {
  const code = stripComments(readFileSync(file, "utf8"));
  const found: string[] = [];
  for (const m of code.matchAll(/\bfrom\s+["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)|^\s*import\s+["']([^"']+)["']/gm)) {
    found.push((m[1] ?? m[2] ?? m[3])!);
  }
  return found;
}

function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'])\/\/.*$/gm, "$1");
}

/** The modules that fetch, shape or serve market data. */
const MARKET_DATA_MODULES = [
  ...files(path.join(SRC, "lib/providers/market-data")),
  path.join(SRC, "lib/markets/ticker.ts"),
  path.join(SRC, "lib/markets/terminal.ts"),
  path.join(SRC, "app/api/market-data/terminal/route.ts"),
  path.join(SRC, "app/trade/useTerminalMarketData.ts"),
];

const WRITE_CAPABLE = /supabase|\/db\/|lib\/db|engines|settlement|execution|\/trade\/|ledger|wallets|orders|admin\/actions|money-write/;

describe("market-data modules cannot write", () => {
  for (const file of MARKET_DATA_MODULES) {
    test(rel(file), () => {
      for (const spec of imports(file)) {
        assert.doesNotMatch(spec, WRITE_CAPABLE, `${rel(file)} imports ${spec}`);
      }
      const code = stripComments(readFileSync(file, "utf8"));
      for (const call of [".rpc(", ".insert(", ".update(", ".upsert(", "moneyInsert", "moneyArgs", "createAdminClient", "createClient("]) {
        assert.ok(!code.includes(call), `${rel(file)} contains ${call}`);
      }
      for (const fn of ["apply_fill", "ledger_post", "place_limit_order", "cancel_order"]) {
        assert.ok(!code.includes(fn), `${rel(file)} names ${fn}`);
      }
    });
  }
});

describe("money-moving code does not read market data", () => {
  const MONEY_DIRS = ["lib/engines", "lib/settlement", "lib/execution", "lib/trade", "lib/wallets", "lib/db", "app/trade/actions.ts"];
  const READS_MARKET_DATA = /providers\/market-data|markets\/ticker|markets\/terminal/;
  const ALLOWED = new Set([
    // Values an order in the limit currency; refuses (LIMIT_CHECK_UNAVAILABLE) when it cannot.
    "lib/engines/limit-engine.ts",
  ]);

  for (const target of MONEY_DIRS) {
    const full = path.join(SRC, target);
    const list = statSync(full).isDirectory() ? files(full) : [full];
    for (const file of list) {
      test(rel(file), () => {
        const reads = imports(file).filter((spec) => READS_MARKET_DATA.test(spec));
        if (ALLOWED.has(rel(file))) return;
        assert.deepEqual(reads, [], `${rel(file)} imports market data`);
      });
    }
  }

  test("the order engine itself never reads market data", () => {
    for (const name of ["order-engine.ts", "order-engine.server.ts", "order-rules.ts", "fee-rules.ts"]) {
      const specs = imports(path.join(SRC, "lib/engines", name));
      assert.ok(!specs.some((s) => /market-data|markets\//.test(s)), `${name} imports market data`);
    }
  });
});

describe("the public adapter exposes only the read interface", () => {
  test("no method that could place, cancel, fill or settle", () => {
    const methods = Object.getOwnPropertyNames(BinancePublicMarketDataProvider.prototype)
      .filter((name) => name !== "constructor")
      .filter((name) => !["symbolFor", "normalized", "cached", "getJson", "noteRefusal"].includes(name))
      .sort();
    assert.deepEqual(methods, ["getCandles", "getOrderBook", "getRecentTrades", "getTicker", "getTickers", "isConfigured", "supportsPair"]);
  });
});

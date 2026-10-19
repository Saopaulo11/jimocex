import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";

/**
 * The execution boundary cannot move money (Slice 14A). Statically, over the
 * source tree (comments removed):
 *
 *   * the execution layer (provider contract, service, lifecycle, status map,
 *     coordinator) imports nothing that writes and names no money primitive —
 *     a provider answer has no path to a balance;
 *   * `apply_fill` is called from exactly one module, the settlement server
 *     gateway, which otherwise only reads;
 *   * no browser-facing module imports execution or settlement, so a client
 *     cannot hand settlement a fill;
 *   * the new modules use no float conversion (the money guard checks the
 *     whole tree; this pins it for these files).
 */

const SRC = path.resolve(import.meta.dirname, "../../..");

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return name === "__tests__" ? [] : files(full);
    return /\.(ts|tsx)$/.test(name) ? [full] : [];
  });
}

const rel = (file: string) => path.relative(SRC, file).split(path.sep).join("/");
const code = (file: string) =>
  readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'])\/\/.*$/gm, "$1");

function imports(file: string): string[] {
  const found: string[] = [];
  for (const m of code(file).matchAll(/\bfrom\s+["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)|^\s*import\s+["']([^"']+)["']/gm)) {
    found.push((m[1] ?? m[2] ?? m[3])!);
  }
  return found;
}

/** Imports that load code at runtime — `import type` is erased and can execute nothing. */
function runtimeImports(file: string): string[] {
  const found: string[] = [];
  for (const m of code(file).matchAll(/^\s*(?:import|export)\s+(type\s+)?[^"';]*?from\s+["']([^"']+)["']|^\s*import\s+["']([^"']+)["']/gm)) {
    if (!m[1]) found.push((m[2] ?? m[3])!);
  }
  return found;
}

// The pure layer. Its one server adapter (lifecycle-gateway.server.ts, 14B) is
// held to its own, narrower rule below — as settlement's service.server.ts is.
const EXECUTION = files(path.join(SRC, "lib/execution")).filter((f) => !f.endsWith(".server.ts"));
const LIFECYCLE_GATEWAY = path.join(SRC, "lib/execution/lifecycle-gateway.server.ts");
const LIFECYCLE_PRIMITIVES = ["claim_order_for_submission", "finalize_venue_cancellation", "record_provider_order_id"];
const SETTLEMENT_PURE = ["lib/settlement/service.ts", "lib/settlement/types.ts", "lib/settlement/fills.ts"].map((f) => path.join(SRC, f));

describe("the execution layer cannot write (40/41)", () => {
  test("covers the whole layer", () => {
    const names = EXECUTION.map(rel).sort();
    for (const expected of ["coordinator.ts", "index.ts", "lifecycle.ts", "service.ts", "status-map.ts", "types.ts", "unavailable.ts"]) {
      assert.ok(names.includes(`lib/execution/${expected}`), expected);
    }
    // The import reader is not vacuous: it sees the coordinator's runtime imports.
    assert.deepEqual(runtimeImports(path.join(SRC, "lib/execution/coordinator.ts")).sort(), ["../money.ts", "./lifecycle.ts", "./types.ts"]);
  });

  for (const file of [...EXECUTION, ...SETTLEMENT_PURE]) {
    test(rel(file), () => {
      for (const spec of runtimeImports(file)) {
        assert.doesNotMatch(spec, /supabase|lib\/db|\/db\/|money-write|ledger|wallets|engines|service\.server/, `${rel(file)} imports ${spec}`);
      }
      const body = code(file);
      for (const word of [".rpc(", ".from(", ".insert(", ".update(", ".upsert(", ".delete(", "createAdminClient", "createClient(", "fetch("]) {
        assert.ok(!body.includes(word), `${rel(file)} contains ${word}`);
      }
      for (const fn of ["apply_fill", "ledger_post", "place_limit_order", "cancel_order", "release_withdrawal_hold"]) {
        assert.ok(!body.includes(fn), `${rel(file)} names ${fn}`);
      }
    });
  }

  test("a provider exposes only the venue interface — nothing that settles, credits or posts", () => {
    // Read from source: the adapters import "server-only", which node --test cannot load.
    const body = /export interface ExecutionProvider \{([\s\S]*?)\n\}/.exec(code(path.join(SRC, "lib/execution/types.ts")))?.[1] ?? "";
    const members = [...body.matchAll(/^\s*(?:readonly\s+)?(\w+)\??[(:]/gm)].map((m) => m[1]).sort();
    assert.deepEqual(members, ["cancelOrder", "fillReporting", "getFills", "getOpenOrders", "getOrder", "isConfigured", "name", "placeOrder"]);
  });
});

describe("settlement is the only financial mutation path for fills (42)", () => {
  const ALL = files(SRC).filter((f) => !rel(f).startsWith("lib/supabase/") && rel(f) !== "lib/db/money-columns.ts");

  test("apply_fill is called from the settlement server gateway and nowhere else", () => {
    const callers = ALL.filter((f) => /\.rpc\(\s*["']apply_fill["']/.test(code(f))).map(rel);
    assert.deepEqual(callers, ["lib/settlement/service.server.ts"]);
    const naming = ALL.filter((f) => code(f).includes("apply_fill")).map(rel);
    assert.deepEqual(naming, ["lib/settlement/service.server.ts"]);
  });

  test("the settlement server gateway writes nothing but through apply_fill", () => {
    const body = code(path.join(SRC, "lib/settlement/service.server.ts"));
    for (const word of [".insert(", ".update(", ".upsert(", ".delete(", "ledger_post", "cancel_order"]) {
      assert.ok(!body.includes(word), `service.server.ts contains ${word}`);
    }
    const rpcs = [...body.matchAll(/\.rpc\(\s*["']([a-z_]+)["']/g)].map((m) => m[1]);
    assert.deepEqual(rpcs, ["apply_fill"]);
  });
});

describe("a client cannot supply a fill (43)", () => {
  test("no app or component module imports execution or settlement", () => {
    const clientSide = [...files(path.join(SRC, "app")), ...files(path.join(SRC, "components"))];
    for (const file of clientSide) {
      for (const spec of imports(file)) {
        assert.doesNotMatch(spec, /lib\/execution|lib\/settlement/, `${rel(file)} imports ${spec}`);
      }
    }
  });
});

describe("no float money arithmetic in the new modules (44)", () => {
  const NEW = ["lib/execution/lifecycle.ts", "lib/execution/status-map.ts", "lib/execution/coordinator.ts", "lib/settlement/fills.ts"];
  for (const name of NEW) {
    test(name, () => {
      const body = code(path.join(SRC, name));
      for (const word of ["Number(", "parseFloat", "parseInt", ".toFixed(", ".toPrecision(", "Math.", "Intl.NumberFormat"]) {
        assert.ok(!body.includes(word), `${name} contains ${word}`);
      }
    });
  }
});

describe("the lifecycle gateway writes only through 022's primitives (14B)", () => {
  test("its only RPCs are the claim, the venue-id compare-and-set and the venue-confirmed release", () => {
    const body = code(LIFECYCLE_GATEWAY);
    const rpcs = [...body.matchAll(/\.rpc\(\s*["']([a-z_]+)["']/g)].map((m) => m[1]).sort();
    assert.deepEqual(rpcs, LIFECYCLE_PRIMITIVES);
  });

  test("it writes no table and names no other money primitive", () => {
    const body = code(LIFECYCLE_GATEWAY);
    for (const word of [".insert(", ".update(", ".upsert(", ".delete(", "apply_fill", "ledger_post", "cancel_order", "place_limit_order"]) {
      assert.ok(!body.includes(word), `lifecycle-gateway.server.ts contains ${word}`);
    }
  });

  test("the three primitives are called from the gateway and nowhere else", () => {
    const ALL = files(SRC).filter((f) => !rel(f).startsWith("lib/supabase/") && rel(f) !== "lib/db/money-columns.ts");
    for (const fn of LIFECYCLE_PRIMITIVES) {
      const naming = ALL.filter((f) => code(f).includes(fn)).map(rel);
      assert.deepEqual(naming, ["lib/execution/lifecycle-gateway.server.ts"], fn);
    }
  });

  test("nothing in the application imports the gateway yet (no venue is connected)", () => {
    const importers = files(SRC).filter((f) => imports(f).some((spec) => /lifecycle-gateway/.test(spec))).map(rel);
    assert.deepEqual(importers, []);
  });
});

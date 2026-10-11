import assert from "node:assert/strict";
import path from "node:path";
import { before, describe, test } from "node:test";

import type ts from "typescript";

import {
  ROOT,
  checkFiles,
  createGuardProgram,
  isScannedFile,
  type Offence,
  type Rule,
} from "../../../../scripts/money-guard.ts";

/**
 * The money guard, run two ways.
 *
 * 1. Over the application: no offence anywhere in src/ or scripts/.
 * 2. Over fixtures: every way of breaking the boundary that an audit found —
 *    each of which the previous regex guard let through — must be reported
 *    under the rule that names it, and the sanctioned forms must not be.
 *
 * The second half is what makes the first worth anything. A guard that
 * reports nothing passes on a clean codebase and on a broken one alike.
 */

const FIXTURE_DIR = path.join(ROOT, "src/__money_guard_fixtures__");

const HEADER = `
import { createAdminClient } from "@/lib/supabase/admin";
import { moneySelect } from "@/lib/db/money-columns";
import { moneyArgs, moneyInsert } from "@/lib/db/money-write";
import { ZERO, addMoney, formatMoney, parseMoney, toDatabase, type Money } from "@/lib/money";
declare const db: ReturnType<typeof createAdminClient>;
declare const a: Money;
declare const b: Money;
declare const row: { available_balance: string; price: string };
declare const input: HTMLInputElement;
export {};
`;

/** Each fixture is one statement in an async function, and the rule it must trip. */
const VIOLATIONS: Record<string, [Rule, string]> = {
  "select-star": ["select", `await db.from("wallets").select("*");`],
  "select-bare": ["select", `await db.from("wallets").select();`],
  "select-raw-column": ["select", `await db.from("wallets").select("id, available_balance");`],
  "select-alias": ["select", `await db.from("wallets").select("bal:available_balance");`],
  "select-quoted": ["select", `await db.from("wallets").select('"available_balance"');`],
  "select-multiline": ["select", "await db.from(\"trades\").select(`id,\n  price`);"],
  "select-numeric-cast": ["select", `await db.from("trades").select("price::numeric");`],
  "select-float-cast": ["select", `await db.from("trades").select("price::float8");`],
  "select-aggregate": ["select", `await db.from("limit_usage").select("usd_equivalent.sum()");`],
  "select-embedded": ["select", `await db.from("profiles").select("user_id, wallets(available_balance)");`],
  "select-embedded-star": ["select", `await db.from("profiles").select("user_id, wallets(*)");`],
  "select-template": ["select", "const c = 'price'; await db.from(\"trades\").select(`id, ${c}`);"],
  "select-variable": ["select", `const cols = "price"; await db.from("trades").select(cols);`],
  "select-wrong-table": ["select", `await db.from("wallets").select(moneySelect("trades", "price"));`],
  "select-after-write": [
    "select",
    `await db.from("deposits").insert(moneyInsert("deposits", { user_id: "u", asset_id: "a", amount: a })).select();`,
  ],
  "select-through-variable": ["select", `const q = db.from("wallets"); await q.select("*");`],
  "select-jsonb-raw": ["select", `await db.from("audit_logs").select("id, metadata");`],
  "write-raw": ["write", `await db.from("deposits").insert({ user_id: "u", asset_id: "a", amount: toDatabase(a) });`],
  "write-ledger-only-wallets": ["write", `await db.from("wallets").update({} as never);`],
  "write-ledger-only-entries": ["write", `await db.from("ledger_entries").insert({} as never);`],
  "write-upsert": ["write", `await db.from("trades").upsert([{ price: toDatabase(a) }] as never);`],
  "rpc-without-money-args": [
    "rpc",
    `await db.rpc("ledger_post", { p_user_id: "u", p_asset_id: "a", p_entry_type: "DEPOSIT", p_amount: toDatabase(a), p_available_delta: toDatabase(a), p_locked_delta: toDatabase(ZERO) });`,
  ],
  "rpc-dynamic-name": ["rpc", `const fn = "is_admin" as "is_admin"; await db.rpc(fn);`],
  "rpc-unregistered": ["rpc", `await db.rpc("limit_usage_in_window" as "is_admin");`],
  "filter-number": ["filter", `await db.from("trades").select("id").gte("amount", 0.1);`],
  "filter-money": ["filter", `await db.from("trades").select("id").eq("price", a as unknown as never);`],
  "filter-laundered": ["filter", `await db.from("trades").select("id").gte("price", (0.1 as unknown) as string);`],
  "filter-in-numbers": ["filter", `await db.from("trades").select("id").in("amount", [1, 2] as never);`],
  "filter-match": ["filter", `await db.from("trades").select("id").match({ amount: 1 } as never);`],
  "filter-operator": ["filter", `await db.from("trades").select("id").filter("amount", "gt", 0.1);`],
  "filter-not": ["filter", `await db.from("trades").select("id").not("amount", "lt", 1);`],
  "select-element-access": ["select", `await db["from"]("wallets").select("*");`],
  "select-optional-chain": ["select", `await db?.from("wallets")?.select("*");`],
  "float-Number": ["float", `Number(row.available_balance);`],
  "float-Number-alias": ["float", `const N = Number; N(row.price);`],
  "float-Number-callback": ["float", `[row.price].map(Number);`],
  "float-globalThis": ["float", `globalThis.parseFloat(row.price);`],
  "float-parseFloat": ["float", `parseFloat(row.price);`],
  "float-parseInt": ["float", `parseInt(row.price, 10);`],
  "float-Number-parseFloat": ["float", `Number.parseFloat(row.price);`],
  "float-toFixed": ["float", `(1.5).toFixed(2);`],
  "float-valueAsNumber": ["float", `input.valueAsNumber;`],
  "float-intl": ["float", `new Intl.NumberFormat("en").format(1);`],
  "money-multiply": ["money-op", `a * b;`],
  "money-add": ["money-op", `a + b;`],
  "money-compare": ["money-op", `a < b;`],
  "money-compound": ["money-op", `let t = a; t += b;`],
  "money-negate": ["money-op", `-a;`],
  "money-template": ["money-op", "`${a}`;"],
  "money-String": ["money-op", `String(a);`],
  "money-toString": ["money-op", `a.toString();`],
  "money-json": ["money-op", `JSON.stringify(a);`],
  "money-laundered": ["money-op", `String(a as unknown as number);`],
  "allow-without-reason": ["allow", `// money-guard-allow:\nparseFloat(row.price);`],
};

const CLEAN: Record<string, string> = {
  "select-cast": `await db.from("wallets").select("id, available_balance::text, locked_balance::text");`,
  "select-moneySelect": `await db.from("wallets").select(moneySelect("wallets", "id, available_balance"));`,
  "select-no-money-table": `await db.from("profiles").select("*");`,
  "select-embedded-cast": `await db.from("profiles").select("user_id, wallets(available_balance::text)");`,
  "select-jsonb-text-path": `await db.from("audit_logs").select("id, metadata->>action");`,
  "write-helper": `await db.from("deposits").insert(moneyInsert("deposits", { user_id: "u", asset_id: "a", amount: a }));`,
  "rpc-helper": `await db.rpc("ledger_post", moneyArgs("ledger_post", { p_user_id: "u", p_asset_id: "a", p_entry_type: "DEPOSIT", p_amount: a, p_available_delta: a, p_locked_delta: ZERO }));`,
  "rpc-no-money": `await db.rpc("is_admin");`,
  "filter-decimal": `await db.from("trades").select("id").gte("amount", toDatabase(parseMoney("0.1")));`,
  "filter-not-money": `await db.from("trades").select("id").eq("pair_id", "x");`,
  "money-helpers": `addMoney(a, b); formatMoney(a); a === b;`,
  "plain-numbers": `[1, 2].map((x) => x * 2).filter(Boolean); Math.min(2, 3); Array.from({ length: 3 });`,
  "dom-select": `input.select();`,
  "number-inspection": `Number.isInteger(5); Number.isSafeInteger(5); const n: Number = 5; const o = { Number: 1 };`,
  "allow-with-reason": `// money-guard-allow: fixture proving a reasoned exemption is honoured\nparseFloat(row.price);`,
};

const fixturePath = (name: string) => path.join(FIXTURE_DIR, `${name}.ts`);
const fixtureSource = (statement: string) => `${HEADER}\nexport async function fixture() {\n${statement}\n}\n`;

let program: ts.Program;
const byFile = new Map<string, Offence[]>();
let repoOffences: Offence[] = [];
let exemptionsSeen: { file: string; line: number; reason: string }[] = [];

before(() => {
  const virtual: Record<string, string> = {};
  for (const [name, [, statement]] of Object.entries(VIOLATIONS)) virtual[fixturePath(name)] = fixtureSource(statement);
  for (const [name, statement] of Object.entries(CLEAN)) virtual[fixturePath(`clean-${name}`)] = fixtureSource(statement);

  program = createGuardProgram(virtual);

  const repoFiles = program
    .getSourceFiles()
    .map((file) => file.fileName)
    .filter((fileName) => isScannedFile(fileName) && !fileName.startsWith(FIXTURE_DIR));
  const repo = checkFiles(program, repoFiles);
  repoOffences = repo.offences;
  exemptionsSeen = repo.exemptions;

  const fixtures = checkFiles(program, Object.keys(virtual));
  for (const offence of fixtures.offences) {
    const list = byFile.get(offence.file) ?? [];
    list.push(offence);
    byFile.set(offence.file, list);
  }
});

const relativeFixture = (name: string) => path.relative(ROOT, fixturePath(name));

describe("the application passes the money guard", () => {
  test("no offence in src/ or scripts/", () => {
    const listing = repoOffences.map((o) => `${o.file}:${o.line} [${o.rule}] ${o.message}`).join("\n  ");
    assert.deepEqual(repoOffences, [], `money guard offences:\n  ${listing}`);
  });

  test("it actually scanned the application", () => {
    const scanned = program.getSourceFiles().filter((f) => isScannedFile(f.fileName) && !f.fileName.startsWith(FIXTURE_DIR));
    assert.ok(scanned.length > 50, `only ${scanned.length} files scanned`);
    assert.ok(scanned.some((f) => f.fileName.endsWith("src/lib/engines/limit-engine.ts")));
  });

  test("every exemption carries a reason (listed here so none is invisible)", () => {
    for (const exemption of exemptionsSeen) {
      assert.ok(exemption.reason.length > 0);
      console.log(`  exempt: ${exemption.file}:${exemption.line} — ${exemption.reason}`);
    }
  });
});

describe("each way of breaking the boundary is caught", () => {
  for (const [name, [rule]] of Object.entries(VIOLATIONS)) {
    test(`${name} → ${rule}`, () => {
      const offences = byFile.get(relativeFixture(name)) ?? [];
      assert.ok(
        offences.some((o) => o.rule === rule),
        `expected a "${rule}" offence, got: ${JSON.stringify(offences.map((o) => `${o.rule}: ${o.message}`))}`,
      );
    });
  }
});

describe("the sanctioned forms are not reported", () => {
  for (const name of Object.keys(CLEAN)) {
    test(name, () => {
      const offences = byFile.get(relativeFixture(`clean-${name}`)) ?? [];
      assert.deepEqual(offences.map((o) => `${o.rule}: ${o.message}`), []);
    });
  }
});

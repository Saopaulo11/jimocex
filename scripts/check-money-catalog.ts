/**
 * Compares the money registry (src/lib/db/money-columns.ts) with the catalog
 * of a database built from the migrations.
 *
 *   node --experimental-strip-types scripts/check-money-catalog.ts catalog.json
 *
 * Run by scripts/test-db.sh after the invariant suite, on the JSON that
 * supabase/tests/02_money_catalog.sql emits. It replaces a unit test that read
 * the migration files with regular expressions and so could not see a column
 * added by ALTER TABLE, written in capitals, declared as `decimal`, or indented
 * differently — while its comments said it could. The catalog is the schema
 * itself; there is nothing for a migration's formatting to hide behind.
 *
 * Exits 1 listing every disagreement.
 */

import { readFileSync } from "node:fs";

import {
  ALL_MONEY_COLUMN_NAMES,
  DB_FUNCTIONS,
  DEFAULT_MONEY_NUMERIC,
  GENERATED_MONEY_COLUMNS,
  JSON_COLUMNS,
  LEDGER_ONLY_TABLES,
  MONEY_COLUMNS,
  NARROW_MONEY_COLUMNS,
  NOT_MONEY_NUMERIC,
  TRIGGER_FUNCTIONS,
} from "../src/lib/db/money-columns.ts";

type Column = {
  table: string;
  column: string;
  type: string;
  precision: number | null;
  scale: number | null;
  generated: boolean;
};
type Check = { table: string; name: string; def: string };
type Arg = { name: string | null; type: string; numericish: boolean; mode: string };
type Fn = {
  name: string;
  identity: string;
  isTrigger: boolean;
  args: Arg[];
  rowtypeColumns: string[];
  scalarResult: string;
  scalarNumericish: boolean;
  executableBy: { PUBLIC: boolean; anon: boolean; authenticated: boolean; service_role: boolean };
  source: string;
};
type Catalog = {
  columns: Column[];
  indirectNumericColumns: string[];
  checks: Check[];
  views: string[];
  functions: Fn[] | null;
  tablePrivileges: { table: string; role: string; privilege: string }[] | null;
  truncateTriggers: string[];
  defaultFunctionGrants: string[];
};

const file = process.argv[2];
if (!file) {
  console.error("usage: check-money-catalog.ts <catalog.json>");
  process.exit(2);
}
const catalog = JSON.parse(readFileSync(file, "utf8")) as Catalog;
const problems: string[] = [];

const money = MONEY_COLUMNS as Record<string, readonly string[]>;
const json = JSON_COLUMNS as Record<string, readonly string[]>;
const generated = GENERATED_MONEY_COLUMNS as Record<string, readonly string[]>;
const functions = DB_FUNCTIONS as Record<
  string,
  {
    args: readonly string[];
    result: readonly string[];
    scalarResult?: true;
    jsonArgs?: readonly string[];
  }
>;

/** Money tables whose rows are never changed or removed (forbid_mutation). */
const APPEND_ONLY_MONEY_TABLES = ["ledger_entries", "limit_usage"];

const NUMERIC = new Set(["numeric"]);
const FLOAT = new Set(["real", "double precision", "money"]);
const isNumericType = (type: string) => NUMERIC.has(type.replace(/\(.*\)$/, "").trim()) || FLOAT.has(type);
const key = (table: string, column: string) => `${table}.${column}`;

/* ----------------------------------------------------------------- columns */

const byKey = new Map(catalog.columns.map((c) => [key(c.table, c.column), c]));

for (const c of catalog.columns) {
  const k = key(c.table, c.column);
  const isMoney = money[c.table]?.includes(c.column) ?? false;

  if (FLOAT.has(c.type)) problems.push(`${k} is ${c.type}: no float or money type may hold a financial value`);

  if (c.type === "numeric") {
    if (!isMoney && !(k in NOT_MONEY_NUMERIC)) {
      problems.push(`${k} is numeric but in neither MONEY_COLUMNS nor NOT_MONEY_NUMERIC`);
    }
    if (isMoney) {
      const expected = NARROW_MONEY_COLUMNS[k] ?? DEFAULT_MONEY_NUMERIC;
      if (c.precision !== expected.precision || c.scale !== expected.scale) {
        problems.push(
          `${k} is numeric(${c.precision ?? "?"},${c.scale ?? "?"}); the registry expects numeric(${expected.precision},${expected.scale})`,
        );
      }
    }
  }

  if ((c.type === "jsonb" || c.type === "json") && !(json[c.table]?.includes(c.column) ?? false)) {
    problems.push(`${k} is ${c.type} but not in JSON_COLUMNS`);
  }

  // A money name reused for a non-money column would be cast to text inside an
  // embedded resource, where moneySelect() matches by name alone.
  if (!isMoney && ALL_MONEY_COLUMN_NAMES.includes(c.column)) {
    problems.push(`${k} reuses a money column name for a non-money column`);
  }

  if (c.generated && isMoney && !(generated[c.table]?.includes(c.column) ?? false)) {
    problems.push(`${k} is generated but not in GENERATED_MONEY_COLUMNS`);
  }
}

for (const [table, columns] of Object.entries(money)) {
  for (const column of columns) {
    const c = byKey.get(key(table, column));
    if (!c) problems.push(`MONEY_COLUMNS lists ${key(table, column)}, which does not exist`);
    else if (c.type !== "numeric") problems.push(`MONEY_COLUMNS lists ${key(table, column)}, which is ${c.type}`);
  }
}
for (const [table, columns] of Object.entries(json)) {
  for (const column of columns) {
    const c = byKey.get(key(table, column));
    if (!c || (c.type !== "jsonb" && c.type !== "json")) {
      problems.push(`JSON_COLUMNS lists ${key(table, column)}, which is not a json column`);
    }
  }
}
for (const [table, columns] of Object.entries(generated)) {
  for (const column of columns) {
    if (!byKey.get(key(table, column))?.generated) {
      problems.push(`GENERATED_MONEY_COLUMNS lists ${key(table, column)}, which is not generated`);
    }
  }
}
for (const k of Object.keys(NOT_MONEY_NUMERIC)) {
  if (byKey.get(k)?.type !== "numeric") problems.push(`NOT_MONEY_NUMERIC lists ${k}, which is not a numeric column`);
}

for (const column of catalog.indirectNumericColumns) {
  problems.push(`${column} holds a numeric inside another type; PostgREST would emit it as a JSON number`);
}

/* --------------------------------------------------- NaN cannot be stored */

for (const [table, columns] of Object.entries(money)) {
  for (const column of columns) {
    if (generated[table]?.includes(column)) continue; // derived from constrained columns
    const guarded = catalog.checks.some(
      (check) =>
        check.table === table &&
        new RegExp(`\\(${column} <> 'NaN'::numeric\\)`).test(check.def),
    );
    if (!guarded) problems.push(`${key(table, column)} has no CHECK (${column} <> 'NaN')`);
  }
}

/* ------------------------------------------------------------------- views */

for (const view of catalog.views) {
  problems.push(`view ${view} exists; views are not covered by the money registry — add them before adding one`);
}

/* --------------------------------------------------------------- functions */

const seen = new Set<string>();
const seenTriggers = new Set<string>();
for (const fn of catalog.functions ?? []) {
  if (fn.isTrigger) {
    seenTriggers.add(fn.name);
    if (!(TRIGGER_FUNCTIONS as readonly string[]).includes(fn.name)) {
      problems.push(`trigger function ${fn.name} is not listed in TRIGGER_FUNCTIONS`);
    }
    // Who may execute it is checked by scripts/check-privileges.ts.
    continue;
  }
  seen.add(fn.name);
  const entry = functions[fn.name];
  const label = `${fn.name}(${fn.identity})`;

  if (!entry) {
    problems.push(`${label} is not classified in DB_FUNCTIONS`);
    continue;
  }

  const inputs = fn.args.filter((a) => a.mode === "i" || a.mode === "b" || a.mode === "v");
  const outputs = fn.args.filter((a) => a.mode === "o" || a.mode === "b" || a.mode === "t");

  const numericInputs = inputs.filter((a) => isNumericType(a.type)).map((a) => a.name ?? "?").sort();
  const expectedInputs = [...entry.args].sort();
  if (numericInputs.join() !== expectedInputs.join()) {
    problems.push(`${label}: numeric arguments are [${numericInputs}], DB_FUNCTIONS says [${expectedInputs}]`);
  }

  const jsonInputs = inputs.filter((a) => a.type === "jsonb" || a.type === "json").map((a) => a.name ?? "?").sort();
  const expectedJson = [...(entry.jsonArgs ?? [])].sort();
  if (jsonInputs.join() !== expectedJson.join()) {
    problems.push(`${label}: jsonb arguments are [${jsonInputs}], DB_FUNCTIONS says [${expectedJson}]`);
  }

  // Nothing numeric may leave a function — not directly, not inside an array,
  // a domain or a composite: PostgREST would emit it as a JSON number.
  for (const out of outputs) {
    if (isNumericType(out.type) || out.numericish) {
      problems.push(`${label} returns ${out.name} as ${out.type}; return money as text`);
    }
  }
  if (isNumericType(fn.scalarResult) || fn.scalarNumericish) {
    problems.push(`${label} returns ${fn.scalarResult}, which carries a numeric; return money as text`);
  }
  // A json result is a document whose numbers PostgREST emits as numbers.
  const jsonOut = [fn.scalarResult, ...outputs.map((a) => a.type)].some((t) => t === "json" || t === "jsonb");
  if (jsonOut) problems.push(`${label} returns json; amounts inside it would reach JavaScript as doubles — return text`);
  for (const input of inputs) {
    if (input.numericish && !isNumericType(input.type)) {
      problems.push(`${label}: argument ${input.name} (${input.type}) carries a numeric inside another type`);
    }
  }
  if (fn.rowtypeColumns.some(isNumericType)) {
    problems.push(`${label} returns a row type with numeric columns; return a TABLE with money as text`);
  }

  for (const column of entry.result) {
    const out = outputs.find((a) => a.name === column);
    if (!out) problems.push(`${label}: DB_FUNCTIONS lists result ${column}, which it does not return`);
    else if (out.type !== "text") problems.push(`${label}: result ${column} is ${out.type}, expected text`);
  }
  if (entry.scalarResult && fn.scalarResult !== "text") {
    problems.push(`${label}: DB_FUNCTIONS says its result is money as text, but it returns ${fn.scalarResult}`);
  }

  // The exact executors are checked by scripts/check-privileges.ts against the
  // privilege profile under test; this rule holds in every profile.
  const movesMoney = entry.args.length > 0 || entry.result.length > 0 || entry.scalarResult === true;
  if (movesMoney && (fn.executableBy.PUBLIC || fn.executableBy.anon || fn.executableBy.authenticated)) {
    const who = fn.executableBy.PUBLIC ? "PUBLIC" : fn.executableBy.anon ? "anon" : "authenticated";
    problems.push(`${label} carries money and is executable by ${who}`);
  }

  // SQL may add, subtract, sum and compare money; it may not take it through a float.
  if (/\b(float[48]?|double\s+precision|real)\b/i.test(fn.source)) {
    problems.push(`${label} mentions a float type in its body`);
  }
}
for (const name of Object.keys(functions)) {
  if (!seen.has(name)) problems.push(`DB_FUNCTIONS lists ${name}, which does not exist`);
}
for (const name of TRIGGER_FUNCTIONS) {
  if (!seenTriggers.has(name)) problems.push(`TRIGGER_FUNCTIONS lists ${name}, which does not exist`);
}
for (const role of catalog.defaultFunctionGrants) {
  problems.push(`a new function in public would be executable by ${role} by default; revoke the default privilege`);
}

/* ---------------------------------------------------- balances via ledger */

for (const grant of catalog.tablePrivileges ?? []) {
  if ((LEDGER_ONLY_TABLES as readonly string[]).includes(grant.table)) {
    problems.push(`${grant.role} may ${grant.privilege} ${grant.table} directly; balances move only through ledger_post`);
  } else if (grant.privilege === "TRUNCATE" && grant.table in money) {
    problems.push(`${grant.role} may TRUNCATE ${grant.table}; no client role may empty a money table`);
  } else if (grant.table in money && grant.role !== "service_role") {
    // Money tables are written by the server only. RLS refusing the write is
    // not enough on its own; the grant must not exist either.
    problems.push(`${grant.role} may ${grant.privilege} ${grant.table}; only the server writes money tables`);
  }
}
for (const table of APPEND_ONLY_MONEY_TABLES) {
  if (!catalog.truncateTriggers.includes(table)) problems.push(`${table} is append-only but has no TRUNCATE guard`);
}

/* ------------------------------------------------------------------ report */

const moneyCount = Object.values(money).flat().length;
const fnCount = (catalog.functions ?? []).filter((f) => !f.isTrigger).length;

if (problems.length > 0) {
  console.error(`money registry does not match the database (${problems.length}):`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}
console.log(
  `    ${moneyCount} money columns, ${Object.values(json).flat().length} jsonb columns, ` +
    `${fnCount} functions: registry matches the catalog`,
);

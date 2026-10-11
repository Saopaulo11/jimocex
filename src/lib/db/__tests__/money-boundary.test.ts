import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";

import { ALL_MONEY_COLUMN_NAMES, MONEY_COLUMNS, moneySelect } from "../money-columns.ts";

/**
 * Guards on the financial boundary itself.
 *
 * The unit tests in money.test.ts prove the arithmetic is exact. These prove
 * something different and just as important: that no query in the codebase
 * bypasses it, and that the registry of money columns has not fallen behind the
 * schema.
 *
 * Both run as static analysis over the repository — no database, no network —
 * so they fail in CI the moment someone writes a select that would silently
 * round a balance.
 */

const ROOT = join(import.meta.dirname, "..", "..", "..", "..");
const SRC = join(ROOT, "src");
const MIGRATIONS = join(ROOT, "supabase", "migrations");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(path));
    else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith(".test.ts")) out.push(path);
  }
  return out;
}

describe("moneySelect", () => {
  test("casts money columns and leaves the rest alone", () => {
    assert.equal(
      moneySelect("wallets", "id, available_balance, locked_balance"),
      "id, available_balance::text, locked_balance::text",
    );
  });

  test("leaves embedded relations untouched", () => {
    assert.equal(
      moneySelect("trading_pairs", "symbol, min_order_size, base:base_asset_id(symbol)"),
      "symbol, min_order_size::text, base:base_asset_id(symbol)",
    );
  });

  test("does not double an existing cast", () => {
    assert.equal(
      moneySelect("wallets", "available_balance::text"),
      "available_balance::text",
    );
  });

  test("preserves an alias", () => {
    assert.equal(
      moneySelect("wallets", "balance:available_balance"),
      "balance:available_balance::text",
    );
  });

  test("ignores columns of a table that holds no money", () => {
    assert.equal(moneySelect("profiles", "id, email"), "id, email");
  });
});

describe("the registry matches the schema", () => {
  /**
   * Reads the migrations rather than the live database, so this runs anywhere
   * and still catches the real failure: a migration that adds a money column
   * without registering it, after which every select of that column silently
   * rounds.
   */
  const sql = readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => readFileSync(join(MIGRATIONS, f), "utf8"))
    .join("\n");

  /** Every `create table public.X ( ... )` body in migration order. */
  function tableBodies(): Map<string, string> {
    const tables = new Map<string, string>();
    const pattern = /create table (?:if not exists )?public\.(\w+)\s*\(/g;

    for (let match = pattern.exec(sql); match; match = pattern.exec(sql)) {
      const name = match[1]!;
      // Walk to the matching close paren so nested parens in types and checks
      // do not end the body early.
      let depth = 1;
      let i = match.index + match[0].length;
      while (i < sql.length && depth > 0) {
        if (sql[i] === "(") depth += 1;
        else if (sql[i] === ")") depth -= 1;
        i += 1;
      }
      tables.set(name, sql.slice(match.index + match[0].length, i - 1));
    }
    return tables;
  }

  /**
   * Columns that are `numeric` but deliberately not money.
   *
   * `risk_events.score` is numeric(10,4): a model output compared against a
   * threshold, not a quantity anyone is paid, and exactly representable as a
   * double. Listing the exception here means a NEW numeric column cannot be
   * waved through by accident — it fails the test until someone classifies it.
   */
  const NOT_MONEY = new Set(["risk_events.score"]);

  test("every numeric column in the schema is classified", () => {
    const unregistered: string[] = [];

    for (const [table, body] of tableBodies()) {
      // A column line looks like `  name  numeric(38, 18) ...`.
      const columnPattern = /^\s{2}(\w+)\s+numeric\s*\(/gm;
      for (let m = columnPattern.exec(body); m; m = columnPattern.exec(body)) {
        const column = m[1]!;
        const qualified = `${table}.${column}`;
        if (NOT_MONEY.has(qualified)) continue;

        const registered = (MONEY_COLUMNS as Record<string, readonly string[]>)[table];
        if (!registered?.includes(column)) unregistered.push(qualified);
      }
    }

    assert.deepEqual(
      unregistered,
      [],
      `numeric columns missing from MONEY_COLUMNS (add them, or add to NOT_MONEY with a reason): ${unregistered.join(", ")}`,
    );
  });

  test("the registry lists no column the schema does not have", () => {
    const bodies = tableBodies();
    const missing: string[] = [];

    for (const [table, columns] of Object.entries(MONEY_COLUMNS)) {
      const body = bodies.get(table);
      if (!body) {
        missing.push(`${table} (table not found in migrations)`);
        continue;
      }
      for (const column of columns) {
        if (!new RegExp(`^\\s{2}${column}\\s+numeric\\s*\\(`, "m").test(body)) {
          missing.push(`${table}.${column}`);
        }
      }
    }

    assert.deepEqual(missing, [], `registered columns not found as numeric in the schema: ${missing.join(", ")}`);
  });
});

describe("no query bypasses the boundary", () => {
  /**
   * Scans every source file for a `.select("…")` literal naming a money column
   * without a cast.
   *
   * This is the test that would have caught the original defect. Reading a
   * money column raw is not a style problem — it is a silently rounded balance,
   * and it looks completely normal in review.
   */
  test("no raw .select() reads a money column", () => {
    const offenders: string[] = [];
    const selectPattern = /\.select\(\s*(["'`])([^"'`]*)\1/g;

    for (const file of sourceFiles(SRC)) {
      const text = readFileSync(file, "utf8");

      for (let m = selectPattern.exec(text); m; m = selectPattern.exec(text)) {
        const columns = m[2]!;
        // `select("*")` on a money table would also be unsafe, and is caught.
        const named = columns
          .split(",")
          .map((c) => c.trim().split(":").pop()!.trim())
          .filter(Boolean);

        for (const column of named) {
          const bare = column.replace(/\(.*/, "");
          if (!ALL_MONEY_COLUMN_NAMES.includes(bare)) continue;
          if (column.includes("::text")) continue;

          offenders.push(`${file.replace(ROOT + "/", "")}: ${bare}`);
        }
      }
    }

    assert.deepEqual(
      offenders,
      [],
      `money columns selected without ::text — use moneySelect():\n  ${offenders.join("\n  ")}`,
    );
  });

  test("no source file calls a money-returning RPC", () => {
    // limit_usage_in_window returns numeric, and a function's return type cannot
    // be cast at the call site the way a column can. The engine sums the rows
    // itself instead; this keeps it that way.
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const text = readFileSync(file, "utf8");
      if (text.includes('rpc("limit_usage_in_window"')) {
        offenders.push(file.replace(ROOT + "/", ""));
      }
    }
    assert.deepEqual(offenders, []);
  });

  test("no source file does float arithmetic on a money value", () => {
    const banned = /\b(Number|parseFloat|parseInt)\s*\(\s*\w*(amount|price|fee|balance|rate|total)\w*/i;
    const offenders: string[] = [];

    for (const file of sourceFiles(SRC)) {
      readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, index) => {
          if (line.trim().startsWith("*") || line.trim().startsWith("//")) return;
          if (banned.test(line)) offenders.push(`${file.replace(ROOT + "/", "")}:${index + 1}`);
        });
    }

    assert.deepEqual(offenders, [], `float coercion of a money value:\n  ${offenders.join("\n  ")}`);
  });
});

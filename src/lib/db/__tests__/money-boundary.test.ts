import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { ZERO, parseMoney } from "../../money.ts";
import {
  ALL_MONEY_COLUMN_NAMES,
  DB_FUNCTIONS,
  GENERATED_MONEY_COLUMNS,
  JSON_COLUMNS,
  LEDGER_ONLY_TABLES,
  MONEY_COLUMNS,
  NARROW_MONEY_COLUMNS,
  moneySelect,
  selectProblems,
} from "../money-columns.ts";
import { moneyArgs, moneyInsert, moneyUpdate } from "../money-write.ts";

/**
 * The money registry, the select builder and the write layer.
 *
 * What this file does NOT do any more is check the registry against the
 * migrations by reading their text: that approach could not see ALTER TABLE,
 * casing, `decimal` or a column added in an unusual way, and it said otherwise.
 * `npm run test:db` now compares the registry with the catalog of a database
 * built from the migrations (scripts/check-money-catalog.ts). The scan of the
 * application code for queries that bypass all this lives in
 * money-guard.test.ts.
 */

const m = parseMoney;

describe("moneySelect casts every money and jsonb column to text", () => {
  test("money columns of the table, and nothing else", () => {
    assert.equal(
      moneySelect("wallets", "id, asset_id, available_balance, locked_balance"),
      "id, asset_id, available_balance::text, locked_balance::text",
    );
  });

  test("keeps an alias and does not double an existing cast", () => {
    assert.equal(
      moneySelect("tier_limits", "ceiling:max_amount, min_amount::text"),
      "ceiling:max_amount::text, min_amount::text",
    );
  });

  test("casts money inside an embedded resource, whose table it cannot see", () => {
    assert.equal(
      moneySelect("wallets", "id, ledger:ledger_entries(amount, entry_type, available_delta)"),
      "id, ledger:ledger_entries(amount::text, entry_type, available_delta::text)",
    );
    assert.equal(
      moneySelect("trading_pairs", "symbol, min_order_size, base:base_asset_id(symbol)"),
      "symbol, min_order_size::text, base:base_asset_id(symbol)",
    );
  });

  test("reads jsonb as text, except a path that already yields text", () => {
    assert.equal(moneySelect("ledger_entries", "id, metadata"), "id, metadata::text");
    assert.equal(moneySelect("ledger_entries", "id, metadata->>amount"), "id, metadata->>amount");
    assert.equal(moneySelect("ledger_entries", "id, metadata->amount"), "id, metadata->amount::text");
  });

  for (const [table, columns, reason] of [
    ["wallets", "*", /reads every money column/],
    ["wallets", "id, ledger_entries(*)", /inside an embedded resource/],
    ["trades", "price::numeric", /cast to numeric/],
    ["trades", "price::float8", /cast to float8/],
    ["limit_usage", "usd_equivalent.sum()", /aggregate sum\(\)/],
  ] as const) {
    test(`refuses ${columns} on ${table}`, () => {
      assert.throws(() => moneySelect(table, columns), reason);
    });
  }

  test("refuses a table it does not know, rather than passing the text through", () => {
    // @ts-expect-error — the parameter is typed; this is the runtime half.
    assert.throws(() => moneySelect("wallet", "available_balance"), /holds no money/);
  });
});

describe("selectProblems — the check the static guard runs on a literal", () => {
  test("a raw money column, a star and an uncast embed are each reported", () => {
    assert.equal(selectProblems("wallets", "available_balance").length, 1);
    assert.equal(selectProblems("wallets", "*").length, 1);
    assert.equal(selectProblems("profiles", "user_id, wallets(available_balance)").length, 1);
    assert.equal(selectProblems("profiles", "user_id, wallets(*)").length, 1);
  });

  test("the cast forms pass", () => {
    assert.deepEqual(selectProblems("wallets", "id, available_balance::text, bal:locked_balance::text"), []);
    assert.deepEqual(selectProblems("profiles", "*"), []);
    assert.deepEqual(selectProblems("profiles", "user_id, wallets(available_balance::text)"), []);
  });
});

describe("the registry is internally consistent", () => {
  const moneyTables = Object.keys(MONEY_COLUMNS);

  test("every generated, narrow and ledger-only entry names a registered money column", () => {
    for (const [table, columns] of Object.entries(GENERATED_MONEY_COLUMNS)) {
      for (const column of columns) {
        assert.ok((MONEY_COLUMNS as Record<string, readonly string[]>)[table]?.includes(column), `${table}.${column}`);
      }
    }
    for (const key of Object.keys(NARROW_MONEY_COLUMNS)) {
      const [table = "", column = ""] = key.split(".");
      assert.ok((MONEY_COLUMNS as Record<string, readonly string[]>)[table]?.includes(column), key);
    }
    for (const table of LEDGER_ONLY_TABLES) assert.ok(moneyTables.includes(table), table);
  });

  test("no name is both a money column and a jsonb column", () => {
    const jsonNames = new Set<string>(Object.values(JSON_COLUMNS).flat());
    for (const name of ALL_MONEY_COLUMN_NAMES) assert.ok(!jsonNames.has(name), name);
  });

  test("a function's money arguments are listed once", () => {
    for (const [fn, entry] of Object.entries(DB_FUNCTIONS)) {
      assert.equal(new Set(entry.args).size, entry.args.length, fn);
    }
  });
});

describe("the write layer serialises Money and refuses everything else", () => {
  const user = "00000000-0000-4000-8000-000000000001";
  const asset = "00000000-0000-4000-8000-000000000002";

  test("money fields become exact decimal strings; others pass through", () => {
    assert.deepEqual(
      moneyInsert("deposits", { user_id: user, asset_id: asset, amount: m("1234567890123456.123456789012345678") }),
      { user_id: user, asset_id: asset, amount: "1234567890123456.123456789012345678" },
    );
    assert.deepEqual(moneyUpdate("tier_limits", { max_amount: null, is_active: false }), {
      max_amount: null,
      is_active: false,
    });
  });

  test("a narrower column refuses digits it would round away", () => {
    assert.deepEqual(moneyUpdate("fee_rules", { percentage: m("0.125") }), { percentage: "0.125" });
    assert.throws(() => moneyUpdate("fee_rules", { percentage: m("0.1234565") }), /fee_rules\.percentage/);
  });

  test("a number, a string or a value out of range is refused, naming the column", () => {
    // @ts-expect-error — a float forced through.
    assert.throws(() => moneyInsert("deposits", { user_id: user, asset_id: asset, amount: 1.5 }), /deposits\.amount must be written from Money/);
    // @ts-expect-error — a decimal string that skipped parseMoney.
    assert.throws(() => moneyInsert("deposits", { user_id: user, asset_id: asset, amount: "1.5" }), /parse it with parseMoney/);
    assert.throws(
      () => moneyInsert("deposits", { user_id: user, asset_id: asset, amount: m("100000000000000000000") }),
      /does not fit numeric\(38,18\)/,
    );
  });

  test("ledger-only tables and generated columns cannot be written", () => {
    // @ts-expect-error — wallets is not a writable table.
    assert.throws(() => moneyInsert("wallets", {}), /ledger_post/);
    // @ts-expect-error — net_amount is not in the update shape.
    assert.throws(() => moneyUpdate("withdrawals", { net_amount: m("1") }), /computed by PostgreSQL/);
  });

  test("a JSON number inside a jsonb value is refused, wherever it is nested", () => {
    assert.throws(
      // @ts-expect-error — ExactJson has no numbers; this is the runtime half.
      () => moneyInsert("risk_events", { subject_type: "swap", decision: "REVIEW", details: { lines: [{ fee: 0.1 }] } }),
      /risk_events\.details: \$\.lines\[0\]\.fee is a number/,
    );
    assert.deepEqual(
      moneyInsert("risk_events", { subject_type: "swap", decision: "REVIEW", details: { fee: "0.1" } }),
      { subject_type: "swap", decision: "REVIEW", details: { fee: "0.1" } },
    );
  });

  test("ledger_post arguments are serialised, its metadata checked", () => {
    const args = moneyArgs("ledger_post", {
      p_user_id: user,
      p_asset_id: asset,
      p_entry_type: "DEPOSIT",
      p_amount: m("0.000000000000000001"),
      p_available_delta: m("0.000000000000000001"),
      p_locked_delta: ZERO,
      p_metadata: { source: "test", fee: "0.1" },
    });
    assert.equal(args.p_amount, "0.000000000000000001");
    assert.equal(args.p_locked_delta, "0");
    assert.deepEqual(args.p_metadata, { source: "test", fee: "0.1" });

    assert.throws(
      () =>
        moneyArgs("ledger_post", {
          p_user_id: user,
          p_asset_id: asset,
          p_entry_type: "DEPOSIT",
          p_amount: m("1"),
          p_available_delta: m("1"),
          p_locked_delta: ZERO,
          // @ts-expect-error — a number inside jsonb.
          p_metadata: { fee: 0.1 },
        }),
      /ledger_post\(p_metadata\): \$\.fee is a number/,
    );
  });
});

/**
 * Writing money to the database.
 *
 * The other half of `moneySelect()`. Business logic works in Money; a
 * PostgREST body needs decimal strings. These two functions are where one
 * becomes the other, with the destination column's range and scale checked on
 * the way:
 *
 *     await admin.from("deposits").insert(
 *       moneyInsert("deposits", { user_id, asset_id, amount: credited }),
 *     );
 *
 *     await admin.rpc("ledger_post", moneyArgs("ledger_post", {
 *       p_user_id, p_asset_id, p_entry_type: "DEPOSIT",
 *       p_amount: credited, p_available_delta: credited, p_locked_delta: ZERO,
 *     }));
 *
 * The re-typed schema (`./database`) already refuses a number, a plain string
 * or a raw bigint in a money field at compile time. These functions add the
 * runtime half, for values that arrive through a cast or from untyped code:
 * a money field that is not a Money throws, naming the column; so does a value
 * the column would round or overflow; so does a JSON number inside a jsonb
 * value; so does any write to a ledger-only table or a generated column.
 */

import { toDatabase, type DbDecimal, type Money } from "../money.ts";
import {
  DB_FUNCTIONS,
  DEFAULT_MONEY_NUMERIC,
  LEDGER_ONLY_TABLES,
  isGeneratedMoneyColumn,
  isJsonColumn,
  isMoneyColumn,
  moneyNumericSpec,
  type JsonTable,
  type MoneyTable,
} from "./money-columns.ts";
import type { Database, FunctionArgs, Insert, Update } from "./database";

type LedgerOnlyTable = (typeof LEDGER_ONLY_TABLES)[number];

/**
 * Tables whose writes these helpers check: every table holding money or jsonb,
 * except wallets and ledger_entries, which move only through ledger_post.
 */
export type WritableMoneyTable = Exclude<MoneyTable | JsonTable, LedgerOnlyTable>;

/** DbDecimal → Money, everything else unchanged. */
type WithMoney<V> = V extends DbDecimal ? Money : V;

export type MoneyInsert<T extends WritableMoneyTable> = {
  [K in keyof Insert<T>]: WithMoney<Insert<T>[K]>;
};
export type MoneyUpdate<T extends WritableMoneyTable> = {
  [K in keyof Update<T>]: WithMoney<Update<T>[K]>;
};

type FunctionsWithMoneyArgs = {
  [F in keyof typeof DB_FUNCTIONS]: (typeof DB_FUNCTIONS)[F]["args"] extends readonly [] ? never : F;
}[keyof typeof DB_FUNCTIONS];

export type MoneyArgs<F extends FunctionsWithMoneyArgs> = {
  [K in keyof FunctionArgs<F>]: WithMoney<FunctionArgs<F>[K]>;
};

/** An insert payload for `table`, with its money fields serialised. */
export function moneyInsert<T extends WritableMoneyTable>(table: T, row: MoneyInsert<T>): Insert<T> {
  return serialiseRow(table, row as Record<string, unknown>) as Insert<T>;
}

/** An update payload for `table`, with its money fields serialised. */
export function moneyUpdate<T extends WritableMoneyTable>(table: T, patch: MoneyUpdate<T>): Update<T> {
  return serialiseRow(table, patch as Record<string, unknown>) as Update<T>;
}

/** RPC arguments for `fn`, with its money arguments serialised. */
export function moneyArgs<F extends FunctionsWithMoneyArgs>(fn: F, args: MoneyArgs<F>): FunctionArgs<F> {
  const entry: { args: readonly string[]; jsonArgs?: readonly string[] } = DB_FUNCTIONS[fn];
  const out: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(args as Record<string, unknown>)) {
    const label = `${fn}(${name})`;
    if (entry.args.includes(name)) {
      out[name] = serialiseMoney(value, label, DEFAULT_MONEY_NUMERIC);
    } else {
      if (entry.jsonArgs?.includes(name)) assertNoJsonNumbers(value, label);
      out[name] = value;
    }
  }
  return out as FunctionArgs<F>;
}

function serialiseRow(table: string, row: Record<string, unknown>): Record<string, unknown> {
  if ((LEDGER_ONLY_TABLES as readonly string[]).includes(table)) {
    throw new Error(`${table} is written only by ledger_post(); use moneyArgs("ledger_post", …)`);
  }

  const out: Record<string, unknown> = {};
  for (const [column, value] of Object.entries(row)) {
    const label = `${table}.${column}`;
    if (isGeneratedMoneyColumn(table, column)) {
      throw new Error(`${label} is computed by PostgreSQL and cannot be written`);
    }
    if (isMoneyColumn(table, column)) {
      out[column] = serialiseMoney(value, label, moneyNumericSpec(table, column));
    } else {
      if (isJsonColumn(table, column)) assertNoJsonNumbers(value, label);
      out[column] = value;
    }
  }
  return out;
}

function serialiseMoney(
  value: unknown,
  column: string,
  numeric: { precision: number; scale: number },
): DbDecimal | null | undefined {
  // NULL is a value some money columns legitimately hold (a limit with no
  // ceiling); the database's NOT NULL constraints decide where it is allowed.
  if (value === null || value === undefined) return value;
  if (typeof value !== "bigint") {
    throw new TypeError(
      `${column} must be written from Money, received ${typeof value}` +
        (typeof value === "string" ? ` ${JSON.stringify(value)} — parse it with parseMoney() first` : ""),
    );
  }
  return toDatabase(value as Money, { numeric, column });
}

/**
 * A JSON number inside a jsonb value would be written exactly, but read back
 * through PostgREST as a double. Amounts in documents are decimal strings.
 */
function assertNoJsonNumbers(value: unknown, where: string, path = "$"): void {
  if (typeof value === "number" || typeof value === "bigint") {
    throw new TypeError(`${where}: ${path} is a ${typeof value}; amounts inside jsonb are decimal strings`);
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoJsonNumbers(item, where, `${path}[${index}]`));
  } else if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) assertNoJsonNumbers(item, where, `${path}.${key}`);
  }
}

export type { Database };

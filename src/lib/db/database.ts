/**
 * The database schema as the application is allowed to see it.
 *
 * `@/lib/supabase/database.types` is generated from PostgreSQL, and the
 * generator maps `numeric` to `number`. Taken at its word, it forces every
 * money write through a JavaScript double: the correct decimal string does not
 * compile, the lossy number does. This file re-types the generated schema from
 * the registry in `./money-columns`, so the compiler enforces the boundary
 * instead of fighting it:
 *
 *   * a money column or money function argument in a WRITE is a `DbDecimal` —
 *     produced only by `toDatabase()`, which has checked the column's range
 *     and scale — so neither a number, nor an arbitrary string, nor a raw
 *     Money bigint (which supabase-js would send as its 10^18-scaled digits),
 *     nor an unchecked DecimalString is accepted;
 *   * a money column in a READ or a filter is a `DecimalString`;
 *   * wallets and ledger_entries have no insert or update shape at all — a
 *     balance moves only through `ledger_post`;
 *   * generated columns (remaining_amount, net_amount) cannot be written;
 *   * jsonb columns and arguments accept `ExactJson`, which has no number in
 *     it: an amount inside a document is a decimal string too.
 *
 * Rows are typed the same way. A money column read raw would in fact arrive as
 * a JSON number; the static guard (`scripts/money-guard.ts`) makes that read
 * impossible to write, and `fromDatabase()` throws if one slips through, so the
 * type states the only shape the code can observe.
 *
 * The generated file stays untouched and regenerable. All three Supabase
 * clients are created with this type.
 */

import type { DbDecimal, DecimalString } from "@/lib/money";
import type { Database as Generated, Json } from "@/lib/supabase/database.types";

import type {
  DB_FUNCTIONS,
  GENERATED_MONEY_COLUMNS,
  JSON_COLUMNS,
  LEDGER_ONLY_TABLES,
  MONEY_COLUMNS,
} from "./money-columns";

/** JSON with no numbers in it. An amount inside a jsonb document is a decimal string. */
export type ExactJson =
  | string
  | boolean
  | null
  | { [key: string]: ExactJson | undefined }
  | ExactJson[];

type GeneratedPublic = Generated["public"];
type GeneratedTables = GeneratedPublic["Tables"];
type GeneratedFunctions = GeneratedPublic["Functions"];

type MoneyColumnOf<T> = T extends keyof typeof MONEY_COLUMNS ? (typeof MONEY_COLUMNS)[T][number] : never;
type JsonColumnOf<T> = T extends keyof typeof JSON_COLUMNS ? (typeof JSON_COLUMNS)[T][number] : never;
type GeneratedColumnOf<T> = T extends keyof typeof GENERATED_MONEY_COLUMNS
  ? (typeof GENERATED_MONEY_COLUMNS)[T][number]
  : never;
type LedgerOnlyTable = (typeof LEDGER_ONLY_TABLES)[number];

type FunctionEntry<F> = F extends keyof typeof DB_FUNCTIONS ? (typeof DB_FUNCTIONS)[F] : never;
type MoneyArgOf<F> = FunctionEntry<F> extends { args: readonly (infer A)[] } ? A : never;
type MoneyResultOf<F> = FunctionEntry<F> extends { result: readonly (infer R)[] } ? R : never;
type JsonArgOf<F> = FunctionEntry<F> extends { jsonArgs: readonly (infer J)[] } ? J : never;
type NullableResultOf<F> = FunctionEntry<F> extends { nullableResult: readonly (infer N)[] } ? N : never;

/** number → DecimalString; null and undefined kept. For what is read. */
type Decimal<V> = V extends number ? DecimalString : V;
/** number → DbDecimal; null and undefined kept. For what is written. */
type DbWrite<V> = V extends number ? DbDecimal : V;
/** Generated text money result → DecimalString. */
type DecimalText<V> = V extends string ? DecimalString : V;
/** Json → ExactJson; undefined kept. */
type NoNumbers<V> = [Exclude<V, undefined>] extends [Json] ? ExactJson | Extract<V, undefined> : V;

type RowOf<T, Row> = {
  [K in keyof Row]: K extends MoneyColumnOf<T> ? Decimal<Row[K]> : Row[K];
};

type WriteOf<T, Shape> = T extends LedgerOnlyTable
  ? never
  : {
      [K in keyof Shape as K extends GeneratedColumnOf<T> ? never : K]: K extends MoneyColumnOf<T>
        ? DbWrite<Shape[K]>
        : K extends JsonColumnOf<T>
          ? NoNumbers<Shape[K]>
          : Shape[K];
    };

type Tables = {
  [T in keyof GeneratedTables]: {
    Row: RowOf<T, GeneratedTables[T]["Row"]>;
    Insert: WriteOf<T, GeneratedTables[T]["Insert"]>;
    Update: WriteOf<T, GeneratedTables[T]["Update"]>;
    Relationships: GeneratedTables[T]["Relationships"];
  };
};

type ArgsOf<F, Args> = [Args] extends [never]
  ? never
  : {
      [K in keyof Args]: K extends MoneyArgOf<F>
        ? DbWrite<Args[K]>
        : K extends JsonArgOf<F>
          ? NoNumbers<Args[K]>
          : Args[K];
    };

type ResultColumn<F, K, V> =
  | (K extends MoneyResultOf<F> ? DecimalText<V> : V)
  | (K extends NullableResultOf<F> ? null : never);

type ReturnsOf<F, R> = R extends readonly (infer Item)[]
  ? { [K in keyof Item]: ResultColumn<F, K, Item[K]> }[]
  : FunctionEntry<F> extends { scalarResult: true }
    ? DecimalText<R>
    : R;

type Functions = {
  [F in keyof GeneratedFunctions]: Omit<GeneratedFunctions[F], "Args" | "Returns"> & {
    Args: ArgsOf<F, GeneratedFunctions[F]["Args"]>;
    Returns: ReturnsOf<F, GeneratedFunctions[F]["Returns"]>;
  };
};

export type Database = {
  [S in keyof Generated]: S extends "public"
    ? {
        Tables: Tables;
        Views: GeneratedPublic["Views"];
        Functions: Functions;
        Enums: GeneratedPublic["Enums"];
        CompositeTypes: GeneratedPublic["CompositeTypes"];
      }
    : Generated[S];
};

export type TableName = keyof Tables;
export type Row<T extends TableName> = Tables[T]["Row"];
export type Insert<T extends TableName> = Tables[T]["Insert"];
export type Update<T extends TableName> = Tables[T]["Update"];
export type FunctionName = keyof Functions;
export type FunctionArgs<F extends FunctionName> = Functions[F]["Args"];

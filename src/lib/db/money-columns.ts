/**
 * Which database values are money, and how to move them safely.
 *
 * PostgREST serialises `numeric` as a bare JSON number, so any money column
 * read without a cast reaches JavaScript as a rounded double. Casting it to
 * text in the select is what preserves the exact value:
 *
 *     .select("id, available_balance::text, locked_balance::text")
 *
 * Remembering that at thirty call sites is not a plan, so this file is the
 * single statement of where money lives in the schema, and the code that reads
 * and writes it is driven from here:
 *
 *   * `moneySelect()` applies the casts on the way out;
 *   * `@/lib/db/money-write` serialises Money on the way in;
 *   * `@/lib/db/database` re-types the generated schema so a JavaScript number
 *     cannot be written to — or filtered against — a money column.
 *
 * Three checks keep this file honest. `scripts/test-db.sh` compares it with the
 * catalog of a database built from the migrations (every numeric column, every
 * function argument and result, every jsonb column). The static guard in
 * `scripts/money-guard.ts` fails `npm test` on any query that bypasses it. And
 * the type-level tests fail `npm run typecheck` if the re-typed schema drifts.
 *
 * Classification follows the distinction that matters for correctness: a value
 * is listed when losing its low-order digits would change an amount of money, a
 * price, a rate, a fee or a limit.
 */

import type { NumericSpec } from "@/lib/money";

/* ===========================================================================
   Columns
   =========================================================================== */

export const MONEY_COLUMNS = {
  wallets: ["available_balance", "locked_balance"],
  ledger_entries: ["amount", "available_delta", "locked_delta"],
  trading_orders: [
    "price",
    "amount",
    "filled_amount",
    "remaining_amount",
    "average_price",
    "locked_amount",
  ],
  trades: ["price", "amount", "quote_amount", "fee"],
  swap_quotes: ["from_amount", "rate", "fee", "output_amount"],
  swap_orders: ["from_amount", "to_amount", "rate", "fee"],
  deposits: ["amount"],
  withdrawals: ["amount", "fee", "net_amount"],
  tier_limits: ["max_amount", "min_amount"],
  fee_rules: ["percentage", "fixed_fee", "min_fee", "max_fee"],
  trading_pairs: ["min_order_size", "max_order_size"],
  limit_usage: ["usd_equivalent"],
} as const satisfies Record<string, readonly string[]>;

export type MoneyTable = keyof typeof MONEY_COLUMNS;
export type MoneyColumn<T extends MoneyTable> = (typeof MONEY_COLUMNS)[T][number];

/** Every money column is numeric(38,18) — Money's own scale — unless listed here. */
export const DEFAULT_MONEY_NUMERIC: NumericSpec = { precision: 38, scale: 18 };

/**
 * Money columns narrower than numeric(38,18).
 *
 * PostgreSQL rounds a value with more fractional digits than the column's scale
 * silently, so the write layer refuses such a value instead (see
 * `toDatabase()`). A percentage needs no more than six places.
 */
export const NARROW_MONEY_COLUMNS: Readonly<Record<string, NumericSpec>> = {
  "fee_rules.percentage": { precision: 10, scale: 6 },
};

/**
 * Computed by PostgreSQL (`generated always as … stored`). Readable like any
 * money column, never writable — the re-typed schema removes them from every
 * insert and update shape.
 */
export const GENERATED_MONEY_COLUMNS = {
  trading_orders: ["remaining_amount"],
  withdrawals: ["net_amount"],
} as const satisfies Partial<Record<MoneyTable, readonly string[]>>;

/**
 * Tables whose rows change only through `ledger_post()`. Direct writes are
 * revoked from every role in the database (017) and removed from the types.
 */
export const LEDGER_ONLY_TABLES = ["wallets", "ledger_entries"] as const satisfies readonly MoneyTable[];

/**
 * Numeric columns that are deliberately NOT money, each with the reason. The
 * catalog check fails on any numeric column found in neither list.
 */
export const NOT_MONEY_NUMERIC: Readonly<Record<string, string>> = {
  "risk_events.score":
    "numeric(10,4) model output compared against thresholds; not a quantity anyone is paid, and exactly representable as a double",
};

/**
 * jsonb columns. jsonb keeps the digits of a number exactly, but PostgREST
 * emits it as a bare JSON number and `JSON.parse` rounds it — the same defect as
 * a numeric column, one level down. They are therefore read as text and parsed
 * with `parseJsonExact()`, and written with no JSON numbers in them: the
 * re-typed schema accepts only `ExactJson` here, in which an amount is a
 * decimal string.
 */
export const JSON_COLUMNS = {
  assets: ["metadata"],
  ledger_entries: ["metadata"],
  risk_events: ["details"],
  audit_logs: ["metadata"],
  idempotency_keys: ["response"],
  provider_events: ["payload"],
} as const satisfies Record<string, readonly string[]>;

export type JsonTable = keyof typeof JSON_COLUMNS;

/** Every money column name across every table. */
export const ALL_MONEY_COLUMN_NAMES: readonly string[] = Array.from(
  new Set(Object.values(MONEY_COLUMNS).flat()),
).sort();

const ALL_JSON_COLUMN_NAMES: readonly string[] = Array.from(
  new Set(Object.values(JSON_COLUMNS).flat()),
).sort();

export function isMoneyColumn(table: string, column: string): boolean {
  const columns = MONEY_COLUMNS[table as MoneyTable] as readonly string[] | undefined;
  return columns?.includes(column) ?? false;
}

export function isJsonColumn(table: string, column: string): boolean {
  const columns = JSON_COLUMNS[table as JsonTable] as readonly string[] | undefined;
  return columns?.includes(column) ?? false;
}

export function isGeneratedMoneyColumn(table: string, column: string): boolean {
  const columns = (GENERATED_MONEY_COLUMNS as Record<string, readonly string[]>)[table];
  return columns?.includes(column) ?? false;
}

/** The column's numeric(precision, scale), for range and scale checks on write. */
export function moneyNumericSpec(table: string, column: string): NumericSpec {
  return NARROW_MONEY_COLUMNS[`${table}.${column}`] ?? DEFAULT_MONEY_NUMERIC;
}

/* ===========================================================================
   Functions
   =========================================================================== */

type FunctionMoney = {
  /** Arguments that carry money; the caller sends them as decimal strings. */
  readonly args: readonly string[];
  /** Result columns that carry money; the function returns them as text. */
  readonly result: readonly string[];
  /** The scalar result is money, returned as text. */
  readonly scalarResult?: true;
  /** jsonb arguments; like jsonb columns, they may hold no JSON numbers. */
  readonly jsonArgs?: readonly string[];
  /**
   * The client roles that may EXECUTE the function — exactly these, checked
   * against the catalog. Every function here is called by the server only.
   */
  readonly executors: readonly ("anon" | "authenticated" | "service_role")[];
  /**
   * Result columns that can be NULL. Supabase's generator types every column
   * of a RETURNS TABLE as non-null; these are re-typed `| null` in
   * `@/lib/db/database`, so a consumer reads them with fromDatabaseNullable()
   * instead of throwing on exactly the row that matters.
   */
  readonly nullableResult?: readonly string[];
};

/** Called only by the server, carrying no money in or out. */
const SERVER_ONLY: FunctionMoney = { args: [], result: [], executors: ["service_role"] };

/**
 * Every non-trigger function in `public`, and where money crosses it.
 *
 * The catalog check fails on a function missing from this list, on a numeric
 * argument not named here, on any numeric result, and on a money function
 * executable by `anon` or `authenticated`. The static guard refuses `.rpc()` on
 * a name not listed, and requires `moneyArgs()` for a function that has money
 * arguments.
 */
export const DB_FUNCTIONS = {
  ledger_post: {
    args: ["p_amount", "p_available_delta", "p_locked_delta"],
    result: [],
    jsonArgs: ["p_metadata"],
    executors: ["service_role"],
  },
  consume_quote: {
    args: [],
    result: ["from_amount", "rate", "fee", "output_amount"],
    executors: ["service_role"],
    // A quote is owned by a user OR a session, and may have no fee asset.
    nullableResult: ["user_id", "session_id", "fee_asset_id", "used_at"],
  },
  reconcile_wallets: {
    args: [],
    result: ["wallet_available", "ledger_available", "wallet_locked", "ledger_locked"],
    executors: ["service_role"],
    // NULL when a ledger has no wallet row — the incident the FULL JOIN exists to report.
    nullableResult: ["wallet_available", "wallet_locked"],
  },
  limit_usage_total: { args: [], result: [], scalarResult: true, executors: ["service_role"] },
  place_limit_order: {
    // Money INPUTS only; it returns the new order's id (a scalar), so there is
    // no money result column to track.
    args: ["p_price", "p_amount", "p_lock_amount", "p_fee"],
    result: [],
    jsonArgs: ["p_metadata"],
    executors: ["service_role"],
  },
  cancel_order: SERVER_ONLY,
  apply_fill: {
    // Money INPUTS only; it returns the settled trade's id (a scalar), so there
    // is no money result column. p_fee_asset_id/p_executed_at are not money.
    args: ["p_base_amount", "p_quote_amount", "p_execution_price", "p_fee_amount"],
    result: [],
    executors: ["service_role"],
  },
  claim_deposit_for_credit: SERVER_ONLY,
  claim_provider_event: SERVER_ONLY,
  expire_stale_quotes: SERVER_ONLY,
  // Used by server code, not by any RLS policy — so no client role needs it.
  has_admin_role: SERVER_ONLY,
  is_admin: SERVER_ONLY,
  mark_trade_settled: SERVER_ONLY,
  release_withdrawal_hold: SERVER_ONLY,
} as const satisfies Record<string, FunctionMoney>;

/**
 * Trigger functions. They fire because a trigger does; no role calls them, so
 * no role — not even service_role — is granted EXECUTE.
 */
export const TRIGGER_FUNCTIONS = [
  "forbid_mutation",
  "guard_notification_columns",
  "guard_order_status_transition",
  "guard_profile_privileged_columns",
  "guard_swap_status_transition",
  "guard_withdrawal_status_transition",
  "handle_new_user",
  "touch_updated_at",
] as const;

export type DbFunction = keyof typeof DB_FUNCTIONS;

/* ===========================================================================
   Selects
   =========================================================================== */

/**
 * Builds a PostgREST select string with every money and jsonb column cast to
 * text.
 *
 *     moneySelect("wallets", "id, available_balance, locked_balance")
 *     // "id, available_balance::text, locked_balance::text"
 *
 * Strict on purpose. It throws, rather than passing the text through, on
 * anything that would let a money value leave the database as a JSON number:
 *
 *   * `*` — at the top level of a money table, or inside any embedded
 *     resource, because an embed's target table cannot be known from here;
 *   * a money column cast to anything other than text (`::numeric`, `::float8`);
 *   * an aggregate over a money column (`amount.sum()`), which PostgREST
 *     returns as numeric;
 *   * a table this file does not know.
 *
 * Inside an embedded resource (`ledger:ledger_entries(amount)`), any column
 * whose name is a money or jsonb column anywhere in the schema is cast. The
 * catalog check guarantees such a name is not reused for a non-money column.
 */
export function moneySelect(table: MoneyTable | JsonTable, columns: string): string {
  if (!(table in MONEY_COLUMNS) && !(table in JSON_COLUMNS)) {
    throw new Error(`moneySelect: "${String(table)}" holds no money or jsonb column`);
  }
  const problems: string[] = [];
  const rendered = renderSelect(columns, table, problems);
  if (problems.length > 0) {
    throw new Error(`moneySelect("${table}", "${columns}"): ${problems.join("; ")}`);
  }
  return rendered;
}

/**
 * Lists what is wrong with a hand-written select string, without changing it.
 * Used by the static guard on string literals. `table` is null when the query
 * targets a table that holds no money — only its embedded resources matter then.
 */
export function selectProblems(table: string | null, columns: string): string[] {
  const problems: string[] = [];
  const isSensitive = table !== null && (table in MONEY_COLUMNS || table in JSON_COLUMNS);
  walkSelect(columns, isSensitive ? table : null, false, problems, false);
  return problems;
}

function renderSelect(columns: string, table: string, problems: string[]): string {
  return walkSelect(columns, table, false, problems, true);
}

/**
 * One pass over a PostgREST select list. In render mode it returns the list
 * with casts applied; in check mode it only records problems.
 */
function walkSelect(
  columns: string,
  table: string | null,
  embedded: boolean,
  problems: string[],
  render: boolean,
): string {
  return splitTopLevel(columns)
    .map((raw) => {
      const item = raw.trim();
      if (!item) return item;

      // An embedded resource: `alias:relation!hint(inner)` or `...relation(inner)`.
      const open = item.indexOf("(");
      if (open !== -1 && item.endsWith(")") && !/\.\w+\(\)/.test(item.slice(0, open + 2))) {
        const head = item.slice(0, open);
        const inner = item.slice(open + 1, -1);
        return `${head}(${walkSelect(inner, null, true, problems, render)})`;
      }

      if (item === "*" || item.endsWith(":*")) {
        if (embedded) problems.push(`"*" inside an embedded resource can read money uncast`);
        else if (table !== null) problems.push(`"*" reads every money column of ${table} uncast`);
        return item;
      }

      const field = parseField(item);
      const sensitive = embedded
        ? ALL_MONEY_COLUMN_NAMES.includes(field.column) || ALL_JSON_COLUMN_NAMES.includes(field.column)
        : table !== null && (isMoneyColumn(table, field.column) || isJsonColumn(table, field.column));
      if (!sensitive) return item;

      if (field.aggregate) {
        problems.push(`aggregate ${field.aggregate}() over ${field.column} returns numeric`);
        return item;
      }
      if (field.cast !== null && field.cast !== "text") {
        problems.push(`${field.column} is cast to ${field.cast}; money leaves the database as text`);
        return item;
      }
      // `json_col->>key` is already text.
      if (field.cast === "text" || field.jsonPath === "text") return item;

      if (!render) {
        problems.push(`${field.column} is selected without ::text`);
        return item;
      }
      return `${item}::text`;
    })
    .join(", ");
}

type Field = {
  column: string;
  cast: string | null;
  aggregate: string | null;
  /** `->>` yields text; `->` yields json, whose numbers PostgREST emits as numbers. */
  jsonPath: "none" | "text" | "json";
};

/** `alias:column->path.agg()::cast` → its parts. */
function parseField(item: string): Field {
  let rest = item;
  let cast: string | null = null;

  const castAt = rest.lastIndexOf("::");
  if (castAt !== -1) {
    cast = rest.slice(castAt + 2).trim().toLowerCase();
    rest = rest.slice(0, castAt);
  }

  let aggregate: string | null = null;
  const agg = /\.(\w+)\(\)\s*$/.exec(rest);
  if (agg) {
    aggregate = agg[1] ?? null;
    rest = rest.slice(0, agg.index);
  }

  // Drop the alias. A JSON path may contain ':' only after an arrow, so the
  // alias is everything before the first ':' that precedes any arrow.
  const arrow = rest.search(/->/);
  const colon = rest.indexOf(":");
  if (colon !== -1 && (arrow === -1 || colon < arrow)) rest = rest.slice(colon + 1);

  const pathAt = rest.search(/->/);
  const column = (pathAt === -1 ? rest : rest.slice(0, pathAt)).trim().replace(/^"|"$/g, "");
  const path = pathAt === -1 ? "" : rest.slice(pathAt);
  // Only the LAST arrow decides what comes back: `a->b->>c` is text.
  const jsonPath = path === "" ? "none" : /->>[^>]*$/.test(path) ? "text" : "json";
  return { column, cast, aggregate, jsonPath };
}

/** Splits on commas that are not inside parentheses. */
function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of text) {
    if (char === "(") depth += 1;
    if (char === ")") depth -= 1;
    if (char === "," && depth === 0) {
      parts.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  parts.push(current);
  return parts;
}

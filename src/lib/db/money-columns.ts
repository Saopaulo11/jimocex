/**
 * Which database columns hold money, and how to select them safely.
 *
 * PostgREST serialises `numeric` as a bare JSON number, so any money column
 * read without a cast reaches JavaScript as a rounded double. Casting it to
 * text in the select is what preserves the exact value:
 *
 *     .select("id, available_balance::text, locked_balance::text")
 *
 * Remembering that at thirty call sites is not a plan, so the registry below is
 * the single statement of which columns need it, and `moneySelect()` applies
 * the casts from it. Adding a money column means adding it here; a test asserts
 * this list still matches the database, and another asserts no select in the
 * codebase reads one of these columns raw.
 *
 * Classification follows the distinction that matters for correctness: a value
 * is listed when losing its low-order digits would change an amount of money, a
 * price, a rate, a fee or a limit. `risk_events.score` is numeric(10,4) and is
 * deliberately NOT listed — it is a model output compared against thresholds,
 * not a quantity anyone is paid, and it is exactly representable in a double.
 */

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

/** Every money column name across every table, for the guard test. */
export const ALL_MONEY_COLUMN_NAMES: readonly string[] = Array.from(
  new Set(Object.values(MONEY_COLUMNS).flat()),
).sort();

export function isMoneyColumn(table: string, column: string): boolean {
  const columns = MONEY_COLUMNS[table as MoneyTable] as readonly string[] | undefined;
  return columns?.includes(column) ?? false;
}

/**
 * Builds a PostgREST select string with every money column cast to text.
 *
 *     moneySelect("wallets", "id, available_balance, locked_balance")
 *     // "id, available_balance::text, locked_balance::text"
 *
 * Embedded relations (`base:base_asset_id(symbol)`) and columns already carrying
 * a cast are passed through untouched, so a hand-written cast is not doubled.
 */
export function moneySelect(table: MoneyTable | (string & {}), columns: string): string {
  return columns
    .split(",")
    .map((part) => {
      const column = part.trim();
      if (!column) return column;

      // Leave embedded resources and existing casts alone.
      if (column.includes("(") || column.includes("::")) return column;

      // `alias:column` — cast the column, keep the alias.
      const [left, right] = column.includes(":") ? column.split(":") : [undefined, column];
      const name = (right ?? "").trim();

      if (!isMoneyColumn(table, name)) return column;
      return left ? `${left.trim()}:${name}::text` : `${name}::text`;
    })
    .join(", ");
}

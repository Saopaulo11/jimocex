import "server-only";

import { moneySelect } from "@/lib/db/money-columns";
import { fromDatabase, fromDatabaseNullable, toDecimalString } from "@/lib/money";
import { createClient } from "@/lib/supabase/server";

import type { OpenOrderView, OrderSideValue, OrderStatusValue, OrderTypeValue, PairBalance } from "./types";

/**
 * The current user's trading account reads (spec §19, §31).
 *
 * Both reads go through the USER-scoped client (`createClient`), not the
 * service-role client. That is deliberate: `wallets_own_read` and
 * `trading_orders_own_read` (migration 010) restrict every row to
 * `user_id = auth.uid()`, so RLS — not this code — guarantees a customer can
 * only ever see their own balances and their own orders. There is no user id
 * parameter to get wrong, and no way to ask for someone else's rows.
 *
 * Money columns are read through `moneySelect` (which appends `::text`) and
 * parsed with `fromDatabase`, so a dropped cast throws here naming the column
 * rather than quietly handing the UI a rounded number. The balances are the
 * ledger-backed projection; this module never computes a balance, it reads one.
 */

/** Non-terminal statuses — an order still resting with funds held. */
const OPEN_STATUSES: readonly OrderStatusValue[] = ["PENDING", "OPEN", "PARTIALLY_FILLED"];

/** Every wallet the signed-in user holds, as exact decimal strings. */
export async function getWalletBalances(): Promise<PairBalance[]> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("wallets")
    .select(moneySelect("wallets", "available_balance, locked_balance, asset:asset_id(symbol, decimals)"))
    .overrideTypes<
      {
        available_balance: string;
        locked_balance: string;
        asset: { symbol: string; decimals: number } | null;
      }[],
      { merge: false }
    >();

  if (error || !data) return [];

  return data.flatMap((row) => {
    if (!row.asset) return [];
    const available = fromDatabase(row.available_balance, "wallets.available_balance");
    const locked = fromDatabase(row.locked_balance, "wallets.locked_balance");
    return [
      {
        symbol: row.asset.symbol,
        decimals: row.asset.decimals,
        available: toDecimalString(available),
        locked: toDecimalString(locked),
      },
    ];
  });
}

/** The signed-in user's resting (non-terminal) orders, newest first. */
export async function getOpenOrders(): Promise<OpenOrderView[]> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("trading_orders")
    .select(
      moneySelect(
        "trading_orders",
        "id, side, type, price, amount, status, created_at, pair:pair_id(symbol, price_precision, amount_precision, base:base_asset_id(symbol), quote:quote_asset_id(symbol))",
      ),
    )
    // RLS already restricts to the caller's rows; this narrows to the ones that
    // are still live (a FILLED/CANCELLED/REJECTED/EXPIRED order is not "open").
    .in("status", [...OPEN_STATUSES])
    .order("created_at", { ascending: false })
    .overrideTypes<
      {
        id: string;
        side: OrderSideValue;
        type: OrderTypeValue;
        price: string | null;
        amount: string;
        status: OrderStatusValue;
        created_at: string;
        pair: {
          symbol: string;
          price_precision: number;
          amount_precision: number;
          base: { symbol: string } | null;
          quote: { symbol: string } | null;
        } | null;
      }[],
      { merge: false }
    >();

  if (error || !data) return [];

  return data.flatMap((row) => {
    const base = row.pair?.base?.symbol;
    const quote = row.pair?.quote?.symbol;
    if (!row.pair || !base || !quote) return [];

    const price = fromDatabaseNullable(row.price, "trading_orders.price");
    const amount = fromDatabase(row.amount, "trading_orders.amount");

    return [
      {
        id: row.id,
        pairSymbol: row.pair.symbol,
        side: row.side,
        type: row.type,
        price: price === null ? null : toDecimalString(price),
        amount: toDecimalString(amount),
        status: row.status,
        createdAt: row.created_at,
        pricePrecision: row.pair.price_precision,
        amountPrecision: row.pair.amount_precision,
        baseSymbol: base,
        quoteSymbol: quote,
      },
    ];
  });
}

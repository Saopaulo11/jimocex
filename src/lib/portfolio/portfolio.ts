import "server-only";

import { moneySelect } from "@/lib/db/money-columns";
import {
  addMoney,
  compareMoney,
  fromDatabase,
  isPositive,
  toDecimalString,
  type DecimalString,
  type Money,
} from "@/lib/money";
import { getTickers } from "@/lib/markets/ticker";
import { createClient } from "@/lib/supabase/server";

import { allocationPercent, usdPriceOf, valueInUsd, type PriceMap } from "./valuation";

/**
 * The signed-in customer's portfolio (Slice 7.3/7.6).
 *
 * Balances are the ledger-backed `wallets` projection, read through the
 * USER-scoped client so RLS (`wallets_own_read`) guarantees a customer only ever
 * sees their own — there is no user id to get wrong. This module never computes
 * a balance; it reads one and values it.
 *
 * The valuation is display-only and labelled: `demo` is true when the prices
 * are the prototype source, and `valued` is false when nothing could be priced.
 * The reporting currency is USD. Every figure is exact `Money` and crosses out
 * as a `DecimalString`.
 */

const REPORTING_CURRENCY = "USD";

export type Holding = {
  symbol: string;
  name: string;
  type: string;
  decimals: number;
  available: DecimalString;
  locked: DecimalString;
  total: DecimalString;
  /** Demo USD value of the total, or null when the asset could not be priced. */
  valueUsd: DecimalString | null;
  /** Share of the priced portfolio, or null when unpriced / nothing priced. */
  allocationPercent: DecimalString | null;
};

export type Portfolio = {
  holdings: Holding[];
  totalUsd: DecimalString | null;
  availableUsd: DecimalString | null;
  lockedUsd: DecimalString | null;
  /** Any asset holds a non-zero balance. */
  hasFunds: boolean;
  /** At least one holding could be valued. */
  valued: boolean;
  /** The valuation used demo prices (label it "Demo data"). */
  demo: boolean;
  reportingCurrency: string;
};

export async function getPortfolio(): Promise<Portfolio> {
  const [walletRows, tickers] = await Promise.all([readWallets(), getTickers()]);

  const priceMap: PriceMap = new Map(
    [...tickers.tickers.values()].map((t) => [t.pair, t.price as string]),
  );

  let totalUsd: Money | null = null;
  let availableUsd: Money | null = null;
  let lockedUsd: Money | null = null;
  let valued = false;
  let hasFunds = false;

  // First pass: parse balances and value each holding.
  const priced = walletRows.map((row) => {
    const available = fromDatabase(row.available_balance, "wallets.available_balance");
    const locked = fromDatabase(row.locked_balance, "wallets.locked_balance");
    const total = addMoney(available, locked);
    if (isPositive(total)) hasFunds = true;

    const usdPrice = usdPriceOf(row.symbol, priceMap);
    const totalValue = valueInUsd(total, usdPrice);
    const availableValue = valueInUsd(available, usdPrice);
    const lockedValue = valueInUsd(locked, usdPrice);

    if (totalValue !== null) {
      valued = true;
      totalUsd = totalUsd === null ? totalValue : addMoney(totalUsd, totalValue);
    }
    if (availableValue !== null) availableUsd = availableUsd === null ? availableValue : addMoney(availableUsd, availableValue);
    if (lockedValue !== null) lockedUsd = lockedUsd === null ? lockedValue : addMoney(lockedUsd, lockedValue);

    return { row, available, locked, total, totalValue };
  });

  // Second pass: allocation needs the portfolio total.
  const holdings: Holding[] = priced
    .map(({ row, available, locked, total, totalValue }) => ({
      symbol: row.symbol,
      name: row.name,
      type: row.type,
      decimals: row.decimals,
      available: toDecimalString(available),
      locked: toDecimalString(locked),
      total: toDecimalString(total),
      valueUsd: totalValue === null ? null : toDecimalString(totalValue),
      allocationPercent:
        totalValue === null || totalUsd === null ? null : allocationPercent(totalValue, totalUsd),
      _sortValue: totalValue,
    }))
    // Largest value first; unpriced holdings after priced ones; then by symbol.
    .sort((a, b) => {
      if (a._sortValue !== null && b._sortValue !== null) return compareMoney(b._sortValue, a._sortValue);
      if (a._sortValue !== null) return -1;
      if (b._sortValue !== null) return 1;
      return a.symbol.localeCompare(b.symbol);
    })
    .map(({ _sortValue: _unused, ...holding }) => holding);

  return {
    holdings,
    totalUsd: totalUsd === null ? null : toDecimalString(totalUsd),
    availableUsd: availableUsd === null ? null : toDecimalString(availableUsd),
    lockedUsd: lockedUsd === null ? null : toDecimalString(lockedUsd),
    hasFunds,
    valued: valued && tickers.available,
    demo: tickers.demo,
    reportingCurrency: REPORTING_CURRENCY,
  };
}

export { usdPriceOf } from "./valuation";

type WalletRow = {
  available_balance: string;
  locked_balance: string;
  symbol: string;
  name: string;
  type: string;
  decimals: number;
};

async function readWallets(): Promise<WalletRow[]> {
  try {
    const supabase = await createClient();
    const { data, error } = await supabase
      .from("wallets")
      .select(
        moneySelect("wallets", "available_balance, locked_balance, asset:asset_id(symbol, name, type, decimals)"),
      )
      .overrideTypes<
        {
          available_balance: string;
          locked_balance: string;
          asset: { symbol: string; name: string; type: string; decimals: number } | null;
        }[],
        { merge: false }
      >();

    if (error || !data) return [];
    return data.flatMap((row) =>
      row.asset
        ? [
            {
              available_balance: row.available_balance,
              locked_balance: row.locked_balance,
              symbol: row.asset.symbol,
              name: row.asset.name,
              type: row.asset.type,
              decimals: row.asset.decimals,
            },
          ]
        : [],
    );
  } catch {
    return [];
  }
}


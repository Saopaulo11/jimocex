import type { ReactNode } from "react";

import type { Money } from "@/lib/money";

import { formatAmount, formatPercent, signOf } from "./format";

/**
 * Financial display primitives (spec §21).
 *
 * Every balance, price, fee and limit in the product renders through one of
 * these, which is what keeps precision, alignment and the up/down convention
 * identical on every screen.
 *
 * All of them take Money, parsed where the value was read (`fromDatabase()` for
 * a column, `parseMoney()` for a decimal string from the server). None accepts
 * a number or a raw string, and none guesses a precision — see ./format.
 */

/**
 * An amount with its unit. The unit is smaller and muted so the eye lands on
 * the figure first, which is what it is actually scanning for.
 */
export function CurrencyAmount({
  value,
  symbol,
  decimals,
  size = "md",
  className,
}: {
  value: Money;
  symbol: string;
  /** The asset's own precision — `assets.decimals`. */
  decimals: number;
  size?: "sm" | "md" | "lg" | "xl";
  className?: string;
}) {
  const places = decimals;

  return (
    <span
      className={[
        "jc-amount-display",
        size === "lg" ? "jc-amount-display--lg" : null,
        size === "xl" ? "jc-amount-display--xl" : null,
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {formatAmount(value, { decimals: places, minDecimals: Math.min(2, places) })}
      <span className="jc-amount-unit">{symbol}</span>
    </span>
  );
}

/** A market price, quoted in its pair's quote asset. */
export function Price({
  value,
  quoteSymbol,
  decimals,
}: {
  value: Money;
  quoteSymbol?: string;
  /** The market's `price_precision`. */
  decimals: number;
}) {
  return (
    <span className="jc-numeric">
      {formatAmount(value, { decimals, minDecimals: decimals })}
      {quoteSymbol ? <span className="jc-amount-unit">{quoteSymbol}</span> : null}
    </span>
  );
}

/**
 * A 24h change. Direction is carried by the sign and by colour together —
 * never by colour alone, which fails for colour-blind users and in print.
 */
export function PriceChange({ percent, decimals = 2 }: { percent: Money; decimals?: number }) {
  const direction = signOf(percent, decimals);

  return (
    <span className={`jc-change jc-change--${direction}`}>
      {formatPercent(percent, decimals)}
      <span className="jc-sr-only">
        {direction === "up" ? " increase" : direction === "down" ? " decrease" : " no change"}
      </span>
    </span>
  );
}

/**
 * A labelled figure. `pending` is for a value the server has not supplied —
 * it renders a dash rather than a zero, because "0.00" is a claim and a dash
 * is an absence.
 */
export function Stat({
  label,
  value,
  hint,
  pending = false,
}: {
  label: ReactNode;
  value: ReactNode;
  hint?: ReactNode;
  pending?: boolean;
}) {
  return (
    <div className="jc-stat">
      <span className="jc-stat-label">{label}</span>
      {pending ? (
        <span className="jc-amount-display jc-amount-display--lg jc-muted" aria-label="Not available">
          —
        </span>
      ) : (
        value
      )}
      {hint ? <span className="jc-caption">{hint}</span> : null}
    </div>
  );
}

/**
 * Available and locked side by side.
 *
 * Shown as a pair because the question a customer actually has is "how much of
 * this can I use", and a single balance figure does not answer it.
 */
export function BalancePair({
  available,
  locked,
  symbol,
  decimals,
}: {
  available: Money;
  locked: Money;
  symbol: string;
  /** The asset's own precision — `assets.decimals`. */
  decimals: number;
}) {
  return (
    <div className="jc-stat-pair">
      <Stat
        label="Available"
        value={<CurrencyAmount value={available} symbol={symbol} decimals={decimals} size="lg" />}
      />
      <Stat
        label="Locked"
        value={<CurrencyAmount value={locked} symbol={symbol} decimals={decimals} size="lg" />}
        hint="Reserved for open orders and pending withdrawals"
      />
    </div>
  );
}

/**
 * Asset monogram. Deliberately a typographic mark rather than a downloaded coin
 * logo: coin art is the single strongest "crypto product" signal there is, and
 * a ticker in a disc reads the way a currency code reads on a bank statement.
 */
export function AssetIcon({ symbol, size = "md" }: { symbol: string; size?: "md" | "lg" }) {
  return (
    <span
      className={["jc-asset-icon", size === "lg" ? "jc-asset-icon--lg" : null]
        .filter(Boolean)
        .join(" ")}
      aria-hidden="true"
    >
      {symbol.slice(0, 4)}
    </span>
  );
}

export function NetworkBadge({ network }: { network: string }) {
  return (
    <span className="jc-badge jc-badge--neutral">
      <span className="jc-sr-only">Network: </span>
      {network}
    </span>
  );
}

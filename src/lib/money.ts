/**
 * The financial boundary.
 *
 * Every amount, price, rate and fee in JimoCex passes through this module, and
 * nothing outside it is allowed to do arithmetic on money.
 *
 * ---------------------------------------------------------------------------
 * Why this exists
 * ---------------------------------------------------------------------------
 *
 * PostgreSQL stores money as `numeric(38,18)`, which is exact. PostgREST
 * serialises `numeric` as a bare JSON number, and `JSON.parse` turns that into
 * an IEEE-754 double. A double carries about 15–17 significant digits;
 * `numeric(38,18)` needs 38. Measured against this database:
 *
 *     stored     1234567890123456.123456789012345678
 *     received   1234567890123456
 *
 * The eighteen fractional digits are gone before any application code runs, so
 * converting to a string afterwards cannot bring them back. The fix has to
 * happen in the query — the column is cast to text in SQL — and this module is
 * what makes that safe to rely on:
 *
 *     numeric(38,18)  ->  ::text in the select  ->  parseMoney  ->  Money
 *       ->  exact BigInt arithmetic  ->  formatMoney  ->  UI
 *
 * `fromDatabase()` is the gate. Hand it a JavaScript number and it throws,
 * naming the column — so a dropped cast surfaces as a loud failure on the first
 * read instead of as silently rounded balances months later. Failing closed is
 * the only acceptable behaviour for this class of defect.
 *
 * ---------------------------------------------------------------------------
 * Representation
 * ---------------------------------------------------------------------------
 *
 * A `Money` is a BigInt scaled by 10^18, matching the database column exactly.
 * It is branded, so a plain bigint cannot be passed where a Money is expected
 * and a Money cannot be used as an ordinary number by accident.
 */

const SCALE = 18;
const SCALE_FACTOR = 10n ** BigInt(SCALE);

declare const MoneyBrand: unique symbol;

/** An exact decimal amount, scaled by 10^18. */
export type Money = bigint & { readonly [MoneyBrand]: true };

export const MONEY_SCALE = SCALE;

/** Rounding applied when a result has more precision than it can keep. */
export type Rounding =
  /** Toward zero. The default: never invents value that is not there. */
  | "truncate"
  /** Away from zero. For a fee the platform charges, never for a payout. */
  | "up"
  /** Half away from zero, which is what a person expects from a printed rate. */
  | "half-up";

const DECIMAL_PATTERN = /^[+-]?(\d+(\.\d*)?|\.\d+)$/;

/* ===========================================================================
   Construction
   =========================================================================== */

/**
 * Parses an exact decimal string into Money.
 *
 * Strings only. A number argument is a type error and, if forced through at
 * runtime, a thrown one — by the time a money value is a JavaScript number the
 * damage is already done and accepting it would launder the loss.
 *
 * Rejects exponent notation (`1e18`): it is how a float stringifies, so seeing
 * it here means a number reached this function by some path.
 */
export function parseMoney(value: string, rounding: Rounding = "truncate"): Money {
  if (typeof value !== "string") {
    throw new TypeError(
      `parseMoney expects a decimal string, received ${typeof value}. ` +
        "A money value that is already a JavaScript number has lost precision; " +
        "cast the column to text in SQL instead.",
    );
  }

  const trimmed = value.trim();
  if (!DECIMAL_PATTERN.test(trimmed)) {
    throw new RangeError(`parseMoney: not an exact decimal string: ${JSON.stringify(value)}`);
  }

  const negative = trimmed.startsWith("-");
  const unsigned = trimmed.replace(/^[+-]/, "");
  const [whole = "0", fraction = ""] = unsigned.split(".");

  let digits = fraction.slice(0, SCALE);
  const dropped = fraction.slice(SCALE);
  digits = digits.padEnd(SCALE, "0");

  let scaled = BigInt(whole || "0") * SCALE_FACTOR + BigInt(digits || "0");

  // More precision than the scale can hold. Explicit rather than silent.
  if (dropped && /[1-9]/.test(dropped)) {
    if (rounding === "up") scaled += 1n;
    else if (rounding === "half-up" && dropped.charAt(0) >= "5") scaled += 1n;
  }

  return (negative ? -scaled : scaled) as Money;
}

/** Money from a whole number of units. For constants only, never for input. */
export function moneyFromUnits(units: number | bigint): Money {
  if (typeof units === "number" && !Number.isSafeInteger(units)) {
    throw new RangeError(`moneyFromUnits: ${units} is not a safe integer`);
  }
  return (BigInt(units) * SCALE_FACTOR) as Money;
}

export const ZERO = 0n as Money;

/* ===========================================================================
   The database boundary
   =========================================================================== */

/**
 * Converts a value read from the database into Money.
 *
 * This is the single gate between PostgREST and the rest of the application,
 * and it is deliberately strict:
 *
 *   * a string parses exactly;
 *   * `null` becomes null when the column is nullable;
 *   * **a number throws**, naming the column, because it can only mean the
 *     `::text` cast was omitted from that select and the value is already
 *     rounded.
 *
 * The alternative — accepting the number and stringifying it — would make the
 * mistake invisible, which is exactly how a rounded balance reaches a customer.
 *
 * @param column  Identifies the source in the error, e.g. "wallets.available_balance".
 */
export function fromDatabase(value: string, column: string): Money;
export function fromDatabase(value: string | null, column: string): Money | null;
export function fromDatabase(value: unknown, column: string): Money | null {
  if (value === null || value === undefined) return null;

  if (typeof value === "number") {
    throw new TypeError(
      `${column} arrived as a JavaScript number, which means its precision is ` +
        "already lost. PostgREST serialises numeric as a JSON number, so every " +
        `money column must be cast in the select: \`${column.split(".").pop()}::text\`. ` +
        "See src/lib/db/money-columns.ts.",
    );
  }

  if (typeof value !== "string") {
    throw new TypeError(`${column}: expected a decimal string, received ${typeof value}`);
  }

  return parseMoney(value);
}

/* ===========================================================================
   Arithmetic — exact, no floats anywhere
   =========================================================================== */

export function addMoney(a: Money, b: Money): Money {
  return (a + b) as Money;
}

export function subtractMoney(a: Money, b: Money): Money {
  return (a - b) as Money;
}

export function negateMoney(a: Money): Money {
  return -a as Money;
}

export function absMoney(a: Money): Money {
  return (a < 0n ? -a : a) as Money;
}

export function sumMoney(values: readonly Money[]): Money {
  let total = 0n;
  for (const value of values) total += value;
  return total as Money;
}

/**
 * Multiplies two scaled values — an amount by a rate, say — and rescales.
 *
 * The product of two 10^18-scaled values is 10^36-scaled, so it is divided back
 * down. That division is where precision is decided, which is why the rounding
 * mode is explicit and defaults to truncation: a payout computed by rounding up
 * pays out value the platform does not hold.
 */
export function multiplyMoney(a: Money, b: Money, rounding: Rounding = "truncate"): Money {
  const product = a * b;
  return divideScaled(product, SCALE_FACTOR, rounding);
}

/** Divides one scaled value by another, keeping the scale. */
export function divideMoney(a: Money, b: Money, rounding: Rounding = "truncate"): Money {
  if (b === 0n) throw new RangeError("divideMoney: division by zero");
  return divideScaled(a * SCALE_FACTOR, b, rounding);
}

/**
 * Applies a percentage held at the same scale — `percentageOf(1000, "0.5")` is
 * 0.5% of 1000. Fees round UP by default: the platform should never under-charge
 * itself by a rounding step, and the customer sees the exact figure before
 * committing.
 */
export function percentageOf(amount: Money, percent: Money, rounding: Rounding = "up"): Money {
  const hundred = 100n * SCALE_FACTOR;
  const numerator = amount * percent;
  return divideScaled(numerator, hundred, rounding);
}

function divideScaled(numerator: bigint, denominator: bigint, rounding: Rounding): Money {
  const negative = numerator < 0n !== denominator < 0n;
  const absNumerator = numerator < 0n ? -numerator : numerator;
  const absDenominator = denominator < 0n ? -denominator : denominator;

  let quotient = absNumerator / absDenominator;
  const remainder = absNumerator % absDenominator;

  if (remainder !== 0n) {
    if (rounding === "up") quotient += 1n;
    // Compare 2×remainder with the denominator to avoid any fractional step.
    else if (rounding === "half-up" && remainder * 2n >= absDenominator) quotient += 1n;
  }

  return (negative ? -quotient : quotient) as Money;
}

/* ===========================================================================
   Comparison
   =========================================================================== */

/** -1, 0 or 1. Suitable directly as an Array#sort comparator result. */
export function compareMoney(a: Money, b: Money): -1 | 0 | 1 {
  return a < b ? -1 : a > b ? 1 : 0;
}

export const isZero = (a: Money): boolean => a === 0n;
export const isNegative = (a: Money): boolean => a < 0n;
export const isPositive = (a: Money): boolean => a > 0n;
export const lessThan = (a: Money, b: Money): boolean => a < b;
export const lessOrEqual = (a: Money, b: Money): boolean => a <= b;
export const greaterThan = (a: Money, b: Money): boolean => a > b;
export const greaterOrEqual = (a: Money, b: Money): boolean => a >= b;
export const equalsMoney = (a: Money, b: Money): boolean => a === b;

export function minMoney(a: Money, b: Money): Money {
  return a <= b ? a : b;
}

export function maxMoney(a: Money, b: Money): Money {
  return a >= b ? a : b;
}

/* ===========================================================================
   Output
   =========================================================================== */

/**
 * Renders Money as an exact decimal string.
 *
 * `decimals` truncates. Rounding a balance up would display more than the
 * customer holds, which is the one direction a financial figure must never be
 * wrong in.
 */
export function formatMoney(
  value: Money,
  options: { decimals?: number; minDecimals?: number; group?: boolean } = {},
): string {
  const { decimals, minDecimals = 0, group = false } = options;

  const negative = value < 0n;
  const abs = negative ? -value : value;

  const whole = (abs / SCALE_FACTOR).toString();
  let fraction = (abs % SCALE_FACTOR).toString().padStart(SCALE, "0");

  fraction = decimals === undefined ? fraction.replace(/0+$/, "") : fraction.slice(0, decimals);
  while (fraction.length < minDecimals) fraction += "0";

  const head = group ? whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",") : whole;
  const text = fraction ? `${head}.${fraction}` : head;
  return negative && /[1-9]/.test(text) ? `-${text}` : text;
}

/** The value as it should be written back to a `numeric(38,18)` column. */
export function toDatabase(value: Money): string {
  return formatMoney(value);
}

/**
 * Last resort for a value whose provenance is unknown.
 *
 * Returns null instead of throwing, so a display path can degrade to "—" rather
 * than failing a page render. Never use it on a value that will be calculated
 * with — `fromDatabase` is the gate for that, and it is strict on purpose.
 */
export function tryParseMoney(value: unknown): Money | null {
  if (typeof value !== "string") return null;
  try {
    return parseMoney(value);
  } catch {
    return null;
  }
}

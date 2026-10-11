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
 *     numeric(38,18)  ->  ::text in the select  ->  fromDatabase  ->  Money
 *       ->  exact BigInt arithmetic  ->  Money
 *       ->  toDatabase  ->  decimal string in the JSON body  ->  numeric(38,18)
 *
 * `fromDatabase()` is the gate on the way out. Hand it a JavaScript number and
 * it throws, naming the column — so a dropped cast surfaces as a loud failure
 * on the first read instead of as silently rounded balances months later.
 * Failing closed is the only acceptable behaviour for this class of defect.
 *
 * `toDatabase()` is the gate on the way in. It returns a `DbDecimal`, the only
 * type the re-typed schema (`@/lib/db/database`) accepts for a money column in a
 * write, and it refuses a value the column would round or overflow rather than
 * letting PostgreSQL change it silently.
 *
 * Every other place a decimal enters the system has its own entry point here:
 * `parseAmountInput()` for what a customer types, `parseJsonExact()` for a
 * provider's JSON body, `asDecimalString()` for a string from anywhere else.
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

declare const DecimalBrand: unique symbol;

/**
 * An exact decimal rendered as text — "1234.5", "-0.000000000000000001". Never
 * exponent notation, never grouping.
 *
 * This is what crosses every boundary a bigint cannot: a JSON body to
 * PostgREST, a server-to-client prop, a jsonb document. The brand means a value
 * of this type came out of this module, so a stray `String(someNumber)` cannot
 * pass for one.
 */
export type DecimalString = string & { readonly [DecimalBrand]: true };

declare const DbDecimalBrand: unique symbol;

/**
 * A DecimalString that has been checked against its destination column's range
 * and scale. Only `toDatabase()` produces one, and it is the only type the
 * re-typed schema (`@/lib/db/database`) accepts in an insert, an update or a
 * money function argument — so `toDecimalString()` output, a provider's figure
 * or a value parsed from JSON cannot be written without passing that check.
 */
export type DbDecimal = DecimalString & { readonly [DbDecimalBrand]: true };

/** A column's numeric(precision, scale). */
export type NumericSpec = { readonly precision: number; readonly scale: number };

export const MONEY_SCALE = SCALE;

/**
 * Rounding applied when a result has more precision than it can keep.
 *
 * The first three act on the MAGNITUDE and keep the sign, which is what an
 * amount needs: a fee of 0.0000000000000000015 rounds "up" to 0.000000000000000002
 * whether it is shown as a charge or a credit. For a signed quantity where the
 * direction on the number line matters — a debit that must never be
 * understated — use "floor" or "ceil".
 */
export type Rounding =
  /** Toward zero. The default: never invents value that is not there. */
  | "truncate"
  /** Away from zero. For a fee the platform charges, never for a payout. */
  | "up"
  /** Half away from zero, which is what a person expects from a printed rate. */
  | "half-up"
  /** Toward negative infinity. */
  | "floor"
  /** Toward positive infinity. */
  | "ceil";

/** Whether rounding a value with a discarded remainder adds one unit to its magnitude. */
function bumpsMagnitude(
  rounding: Rounding,
  negative: boolean,
  hasRemainder: boolean,
  halfOrMore: boolean,
): boolean {
  if (!hasRemainder) return false;
  switch (rounding) {
    case "truncate":
      return false;
    case "up":
      return true;
    case "half-up":
      return halfOrMore;
    case "floor":
      return negative;
    case "ceil":
      return !negative;
  }
}

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
  const hasRemainder = /[1-9]/.test(dropped);
  if (bumpsMagnitude(rounding, negative, hasRemainder, dropped.charAt(0) >= "5")) {
    scaled += 1n;
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
   Input from outside the system
   =========================================================================== */

/** Why a customer-typed amount was refused. Stable codes, for the form to word. */
export type AmountInputProblem =
  /** Nothing was entered. */
  | "empty"
  /** Not a plain decimal: a sign, exponent, grouping, a comma, letters. */
  | "malformed"
  /** More fractional digits than the asset has. */
  | "too_many_decimals"
  /** More than numeric(38,18) can hold. */
  | "too_large"
  /** Zero. (Negative input is already "malformed": there is no sign to type.) */
  | "not_positive";

/**
 * Parses an amount a customer typed. The only entry point for one.
 *
 * Stricter than `parseMoney`, which reads values the system produced itself:
 *
 *   * digits and one "." only — no sign, no exponent, no grouping, no comma.
 *     A comma is refused rather than guessed at, because "10,5" is ten and a
 *     half in Russian and Brazilian notation and one hundred and five in
 *     English. The form normalises the locale's separator before calling this;
 *   * no more fractional digits than `maxDecimals` (the asset's `decimals`, or
 *     a pair's precision). Never silently truncated: the customer must see the
 *     amount that will be used;
 *   * within numeric(38,18), and greater than zero.
 *
 * Returns a result rather than throwing: a malformed amount is a normal event
 * on a form, not an exception.
 */
export function parseAmountInput(
  raw: string,
  options: { maxDecimals: number },
): { ok: true; value: Money } | { ok: false; problem: AmountInputProblem } {
  const { maxDecimals } = options;
  if (!Number.isInteger(maxDecimals) || maxDecimals < 0 || maxDecimals > SCALE) {
    throw new RangeError(`parseAmountInput: maxDecimals must be a whole number from 0 to ${SCALE}`);
  }
  if (typeof raw !== "string") return { ok: false, problem: "malformed" };

  const text = raw.trim();
  if (text === "") return { ok: false, problem: "empty" };

  const match = /^(\d*)(?:\.(\d*))?$/.exec(text);
  const whole = match?.[1] ?? "";
  const fraction = match?.[2] ?? "";
  if (!match || (whole === "" && fraction === "")) return { ok: false, problem: "malformed" };

  if (fraction.replace(/0+$/, "").length > maxDecimals) {
    return { ok: false, problem: "too_many_decimals" };
  }
  if (whole.replace(/^0+/, "").length > 38 - SCALE) return { ok: false, problem: "too_large" };

  const value = parseMoney(`${whole || "0"}.${fraction || "0"}`);
  if (value <= 0n) return { ok: false, problem: "not_positive" };
  return { ok: true, value };
}

/**
 * `JSON.parse` that keeps every number exact.
 *
 * A provider's webhook body or market-data response carries amounts as JSON
 * numbers more often than not, and `JSON.parse` rounds them to doubles before
 * any code sees them: `{"amount": 1234567890123456.123456789012345678}` becomes
 * 1234567890123456. This reads each number from its source text instead and
 * returns it as a DecimalString — exponent notation expanded exactly, so
 * `1e-8` becomes "0.00000001".
 *
 * The same applies to a jsonb column read as text (see JSON_COLUMNS in
 * `@/lib/db/money-columns`).
 *
 * Needs JSON.parse source text access (Node 21+, current browsers). On a
 * runtime without it this throws rather than falling back to doubles.
 */
export function parseJsonExact(text: string): unknown {
  let sourceAvailable = true;
  const result: unknown = JSON.parse(
    text,
    (_key: string, value: unknown, context?: { source?: string }) => {
      if (typeof value !== "number") return value;
      if (context?.source === undefined) {
        sourceAvailable = false;
        return value;
      }
      return jsonNumberToDecimal(context.source);
    },
  );
  if (!sourceAvailable) {
    throw new Error("parseJsonExact: this runtime does not expose the source text of JSON numbers");
  }
  return result;
}

/** Zeros an exponent may add when expanded. numeric(38,18) needs at most 20 or 18. */
const MAX_JSON_PADDING = 64;

/** A JSON number's source text as an exact decimal, expanding any exponent. */
function jsonNumberToDecimal(source: string): DecimalString {
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?)(\d+))?$/.exec(source);
  if (!match) throw new RangeError(`parseJsonExact: unexpected number ${source}`);
  const [, sign = "", whole = "0", fraction = "", expSign = "", expDigits = ""] = match;

  let exponent = 0;
  for (const char of expDigits) {
    exponent = exponent * 10 + (char.charCodeAt(0) - 48);
    if (exponent > MAX_JSON_PADDING * 2) break; // already far out of range; refused below
  }
  if (expSign === "-") exponent = -exponent;

  const digits = whole + fraction;
  const point = whole.length + exponent;
  // The body is untrusted. "1e400" is five bytes; expanded it is four hundred.
  // Bound the zeros an exponent may add, which is far beyond anything
  // numeric(38,18) can hold in either direction.
  const padding = point <= 0 ? -point : Math.max(0, point - digits.length);
  if (padding > MAX_JSON_PADDING) {
    throw new RangeError(`parseJsonExact: ${source} is out of range for an amount`);
  }
  let integerPart: string;
  let fractionPart: string;
  if (point <= 0) {
    integerPart = "0";
    fractionPart = "0".repeat(-point) + digits;
  } else if (point >= digits.length) {
    integerPart = digits + "0".repeat(point - digits.length);
    fractionPart = "";
  } else {
    integerPart = digits.slice(0, point);
    fractionPart = digits.slice(point);
  }

  integerPart = integerPart.replace(/^0+(?=\d)/, "");
  return (fractionPart ? `${sign}${integerPart}.${fractionPart}` : `${sign}${integerPart}`) as DecimalString;
}

/* ===========================================================================
   The database boundary
   =========================================================================== */

/**
 * Converts a value read from the database into Money.
 *
 * This is the single gate between PostgREST and the rest of the application,
 * and it is deliberately strict:
 *
 *   * a decimal string parses exactly;
 *   * **a number throws**, naming the column, because it can only mean the
 *     `::text` cast was omitted from that select and the value is already
 *     rounded;
 *   * `null` and `undefined` throw. A missing key means the select string and
 *     the code reading it disagree; reading it as "no value" would turn a typo
 *     into "no ceiling". A column that may legitimately be NULL is read with
 *     `fromDatabaseNullable()` instead;
 *   * anything else that is not an exact decimal — PostgreSQL's 'NaN' among
 *     them — throws, naming the column.
 *
 * The alternative — accepting the number and stringifying it — would make the
 * mistake invisible, which is exactly how a rounded balance reaches a customer.
 *
 * @param column  Identifies the source in the error, e.g. "wallets.available_balance".
 */
export function fromDatabase(value: string, column: string): Money {
  if (value === null || value === undefined) {
    throw new TypeError(
      `${column} is ${value === null ? "NULL" : "missing from the response"}. ` +
        (value === null
          ? "Read a nullable column with fromDatabaseNullable()."
          : "Check that the select string names it."),
    );
  }
  return parseDatabaseValue(value, column);
}

/**
 * `fromDatabase()` for a column that may be NULL — a limit with no ceiling, a
 * market order's price. NULL becomes null; a missing key still throws.
 */
export function fromDatabaseNullable(value: string | null, column: string): Money | null {
  if (value === null) return null;
  if (value === undefined) {
    throw new TypeError(`${column} is missing from the response. Check that the select string names it.`);
  }
  return parseDatabaseValue(value, column);
}

/** numeric::text output: an optional minus, digits, an optional fraction. Nothing else. */
const DATABASE_DECIMAL = /^-?\d+(\.\d+)?$/;

function parseDatabaseValue(value: unknown, column: string): Money {
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

  // Stricter than parseMoney: PostgreSQL renders numeric with no whitespace and
  // no plus sign, and a value with more than 18 fractional digits cannot be
  // held exactly. Truncating it here would be the one place this gate changes a
  // value silently.
  if (!DATABASE_DECIMAL.test(value)) {
    throw new RangeError(`${column}: ${JSON.stringify(value)} is not an exact decimal`);
  }
  const fraction = value.split(".")[1] ?? "";
  if (fraction.replace(/0+$/, "").length > SCALE) {
    throw new RangeError(
      `${column}: ${JSON.stringify(value)} has more than ${SCALE} decimal places; Money cannot hold it exactly`,
    );
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

  // Compare 2×remainder with the denominator to avoid any fractional step.
  if (bumpsMagnitude(rounding, negative, remainder !== 0n, remainder * 2n >= absDenominator)) {
    quotient += 1n;
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
 * `decimals` truncates toward zero, so the magnitude shown never exceeds the
 * magnitude held: a balance is never displayed as more than the customer has,
 * and a debit never as more than was taken. A value that truncates to zero is
 * shown without a sign.
 */
export function formatMoney(
  value: Money,
  options: { decimals?: number; minDecimals?: number; group?: boolean } = {},
): string {
  const { decimals, minDecimals = 0, group = false } = options;
  if (decimals !== undefined) assertPlaces(decimals, "decimals");
  assertPlaces(minDecimals, "minDecimals");
  if (decimals !== undefined && minDecimals > decimals) {
    // Padding past the truncation point would print zeros where the value has
    // digits: 1.123456 at decimals 2, minDecimals 4 would read "1.1200".
    throw new RangeError(`formatMoney: minDecimals (${minDecimals}) exceeds decimals (${decimals})`);
  }

  const negative = value < 0n;
  const abs = negative ? -value : value;

  const whole = (abs / SCALE_FACTOR).toString();
  let fraction = (abs % SCALE_FACTOR).toString().padStart(SCALE, "0");

  fraction = decimals === undefined ? fraction.replace(/0+$/, "") : fraction.slice(0, decimals);
  if (fraction.length < minDecimals) fraction = fraction.padEnd(minDecimals, "0");

  const head = group ? whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",") : whole;
  const text = fraction ? `${head}.${fraction}` : head;
  return negative && /[1-9]/.test(text) ? `-${text}` : text;
}

function assertPlaces(places: number, name: string): void {
  if (!Number.isInteger(places) || places < 0 || places > SCALE) {
    throw new RangeError(`formatMoney: ${name} must be a whole number from 0 to ${SCALE}, got ${places}`);
  }
}

/**
 * Money as an exact decimal string, for any boundary a bigint cannot cross: a
 * JSON response, a server-to-client prop, a value inside a jsonb document.
 */
export function toDecimalString(value: Money): DecimalString {
  return formatMoney(value) as DecimalString;
}

/**
 * The value as it is written to a money column.
 *
 * Refuses, rather than lets PostgreSQL alter:
 *   * a value outside the column's range — numeric(38,18) holds at most twenty
 *     integer digits;
 *   * a value with more fractional digits than the column's scale, which
 *     PostgreSQL would round silently (fee_rules.percentage is numeric(10,6));
 *   * anything that is not a Money at runtime — a JavaScript number forced
 *     through with a cast, or a raw bigint that skipped this function, which
 *     supabase-js would otherwise send as its 10^18-scaled digits.
 *
 * @param options.numeric  The column's numeric(precision, scale); defaults to numeric(38,18).
 * @param options.column   Names the destination in the error, e.g. "deposits.amount".
 */
export function toDatabase(
  value: Money,
  options: { numeric?: NumericSpec; column?: string } = {},
): DbDecimal {
  const { numeric = { precision: 38, scale: SCALE }, column = "value" } = options;

  if (typeof value !== "bigint") {
    throw new TypeError(
      `${column}: toDatabase expects Money, received ${typeof value}. ` +
        "A JavaScript number has already lost precision; parse the decimal string with parseMoney().",
    );
  }

  const { precision, scale } = numeric;
  if (scale > SCALE || scale < 0 || precision <= 0 || precision < scale) {
    throw new RangeError(`${column}: unsupported numeric(${precision},${scale})`);
  }

  const abs = value < 0n ? -value : value;
  const unitsBelowScale = 10n ** BigInt(SCALE - scale);
  if (abs % unitsBelowScale !== 0n) {
    throw new RangeError(
      `${column}: ${formatMoney(value)} has more than ${scale} decimal places; ` +
        `numeric(${precision},${scale}) would round it. Round it explicitly first.`,
    );
  }

  const limit = 10n ** BigInt(precision - scale) * SCALE_FACTOR;
  if (abs >= limit) {
    throw new RangeError(
      `${column}: ${formatMoney(value)} does not fit numeric(${precision},${scale}), ` +
        `which holds less than 10^${precision - scale}.`,
    );
  }

  return formatMoney(value) as DbDecimal;
}

/**
 * Accepts a string from outside this module as a DecimalString, unchanged.
 *
 * For values that are passed on rather than calculated with — a price from a
 * market-data adapter, a figure in a provider payload. Refuses a JavaScript
 * number, exponent notation, 'NaN' and anything else that is not a plain
 * decimal, naming the field.
 */
export function asDecimalString(value: unknown, field: string): DecimalString {
  if (typeof value === "number") {
    throw new TypeError(
      `${field} is a JavaScript number, so its exact value is already gone. ` +
        "Parse the source JSON with parseJsonExact().",
    );
  }
  if (typeof value === "bigint") {
    throw new TypeError(`${field} is a bigint; serialise a Money with toDecimalString()`);
  }
  if (typeof value !== "string" || !DECIMAL_PATTERN.test(value)) {
    const shown = typeof value === "string" ? JSON.stringify(value) : typeof value;
    throw new RangeError(`${field}: ${shown} is not an exact decimal string`);
  }
  return value as DecimalString;
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

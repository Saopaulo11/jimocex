/**
 * The boundary where database money becomes displayable text.
 *
 * ---------------------------------------------------------------------------
 * KNOWN DEFECT — read before using a numeric column anywhere.
 * ---------------------------------------------------------------------------
 *
 * The database stores every amount as `numeric(38,18)`, which is exact. The
 * Supabase JS client does not preserve that: PostgREST serialises `numeric` as
 * a bare JSON number, `JSON.parse` turns it into an IEEE-754 double, and the
 * generated types declare these columns as `number` accordingly.
 *
 * A double holds about 15–17 significant digits. `numeric(38,18)` needs 38.
 * Demonstrated:
 *
 *     stored    1234567890123456.123456789012345678
 *     received  1234567890123456
 *
 * Eighteen fractional digits are discarded silently, before any application
 * code sees the value — so converting to a string afterwards cannot recover
 * them. `toDecimalString` below is honest about this: it makes the value
 * type-correct, it does not make it exact.
 *
 * Why this is survivable TODAY and must not stay that way:
 *
 *   * The only money currently read by the interface is reference
 *     configuration — tier ceilings (5000) and minimum order sizes (0.0001).
 *     Those are small and exactly representable, so nothing on screen is wrong.
 *   * There are no balances, trades or transactions in the system yet, because
 *     no provider is connected. The first real balance is the first value that
 *     could be corrupted.
 *
 * The fix is to stop sending these columns as JSON numbers — casting them in
 * the PostgREST select (`available_balance::text`) or exposing a view that does
 * it — so the client receives the exact decimal as a string. That changes how
 * every money read in the product works, which is a backend-integration
 * decision rather than a styling one, so it is reported rather than applied
 * here.
 *
 * Server-side arithmetic is NOT affected: `limit-rules.ts` works in scaled
 * BigInt and never uses a float. What is affected is the value it is handed —
 * `limit-engine.ts` reads `tier_limits` through the same client and should be
 * reviewed alongside this.
 */

/**
 * Normalises a value arriving from the database into a decimal string.
 *
 * Accepts the `number` the client actually returns as well as the `string` it
 * should return, so call sites are already correct once the cast is in place.
 */
export function toDecimalString(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "0";
  if (typeof value === "string") return value;

  // `toFixed` would introduce its own rounding and cap at 100 places; the
  // default conversion keeps whatever survived, which is all there is.
  return Number.isFinite(value) ? String(value) : "0";
}

/** True when an amount is anything other than zero, without parsing it. */
export function isNonZero(value: string | number | null | undefined): boolean {
  const text = toDecimalString(value);
  return !/^-?0*(\.0*)?$/.test(text.trim());
}

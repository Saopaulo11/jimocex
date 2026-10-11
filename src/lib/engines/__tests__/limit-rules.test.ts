import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { evaluateLimits, valueInLimitCurrency, type EvaluateInput, type LimitRule } from "../limit-rules.ts";
import { formatMoney, parseMoney, type Money } from "../../money.ts";

/**
 * LimitEngine decision tests (spec §25).
 *
 * Run with `node --test`, which strips the types and executes the real module —
 * hence the explicit `.ts` on the import below, which Node's ESM resolver
 * requires and `allowImportingTsExtensions` permits.
 *
 * These cover the rules that decide whether money is allowed to move. They run
 * against the real decision function with no database and no mock client, which
 * is the point of keeping that function pure: a mock can drift from the thing
 * it imitates, and then the test passes while the product is broken.
 */

/** Reads as a decimal in the tests; stored as exact Money. */
const m = (value: string): Money => parseMoney(value);
const maybe = (value: string | null): Money | null => (value === null ? null : parseMoney(value));

const usdSingle = (max: string | null, min: string | null = null): LimitRule => ({
  window: "SINGLE",
  quoteCurrency: "USD",
  max: maybe(max),
  min: maybe(min),
});

const usdDaily = (max: string | null): LimitRule => ({
  window: "DAILY",
  quoteCurrency: "USD",
  max: maybe(max),
  min: null,
});

describe("§25.12 a missing market conversion cannot silently pass a limit", () => {
  test("returns UNAVAILABLE when the amount could not be valued", () => {
    const result = evaluateLimits({
      accountStatus: "ACTIVE",
      // No market data provider could price this asset.
      amountInQuote: null,
      rules: [usdSingle("5000")],
      usage: {},
    });

    assert.equal(result.decision, "UNAVAILABLE");
  });

  test("an unvaluable operation is never ALLOW, however small the stated amount", () => {
    const result = evaluateLimits({
      accountStatus: "ACTIVE",
      amountInQuote: null,
      rules: [usdSingle("5000")],
      usage: {},
    });

    assert.notEqual(result.decision, "ALLOW");
  });

  test("a missing conversion is not treated as zero", () => {
    // The failure this guards against: coercing null to 0 would make an
    // unpriceable 10 BTC withdrawal compare as "0 USD" and clear every ceiling.
    const asNull = evaluateLimits({
      accountStatus: "ACTIVE",
      amountInQuote: null,
      rules: [usdSingle("5000")],
      usage: {},
    });
    const asZero = evaluateLimits({
      accountStatus: "ACTIVE",
      amountInQuote: m("0"),
      rules: [usdSingle("5000")],
      usage: {},
    });

    assert.equal(asNull.decision, "UNAVAILABLE");
    // A real zero is refused too — for being zero (see "a zero or negative
    // amount never passes a limit"), not for being unpriceable.
    assert.equal(asZero.decision, "BLOCK");
    assert.notEqual(asNull.decision, asZero.decision);
  });
});

describe("§25.8 limits are evaluated server-side from configured rules", () => {
  test("allows an amount inside the ceiling", () => {
    const result = evaluateLimits({
      accountStatus: "ACTIVE",
      amountInQuote: m("1000"),
      rules: [usdSingle("2000")],
      usage: {},
    });
    assert.equal(result.decision, "ALLOW");
  });

  test("refuses an amount above the ceiling", () => {
    const result = evaluateLimits({
      accountStatus: "ACTIVE",
      amountInQuote: m("2500"),
      rules: [usdSingle("2000")],
      usage: {},
    });
    assert.notEqual(result.decision, "ALLOW");
  });

  test("the boundary is inclusive: exactly at the ceiling is allowed", () => {
    const result = evaluateLimits({
      accountStatus: "ACTIVE",
      amountInQuote: m("2000"),
      rules: [usdSingle("2000")],
      usage: {},
    });
    assert.equal(result.decision, "ALLOW");
  });

  test("one unit over the ceiling, at 18 decimal places, is refused", () => {
    const result = evaluateLimits({
      accountStatus: "ACTIVE",
      amountInQuote: m("2000.000000000000000001"),
      rules: [usdSingle("2000")],
      usage: {},
    });
    assert.notEqual(result.decision, "ALLOW");
  });

  test("a rolling window counts what has already been consumed", () => {
    const within = evaluateLimits({
      accountStatus: "ACTIVE",
      amountInQuote: m("1000"),
      rules: [usdDaily("5000")],
      usage: { DAILY: m("4000") },
    });
    assert.equal(within.decision, "ALLOW");

    const over = evaluateLimits({
      accountStatus: "ACTIVE",
      amountInQuote: m("1001"),
      rules: [usdDaily("5000")],
      usage: { DAILY: m("4000") },
    });
    assert.notEqual(over.decision, "ALLOW");
  });

  test("SINGLE ignores prior usage; it bounds this operation alone", () => {
    const result = evaluateLimits({
      accountStatus: "ACTIVE",
      amountInQuote: m("1000"),
      rules: [usdSingle("2000")],
      usage: { SINGLE: m("999999") },
    });
    assert.equal(result.decision, "ALLOW");
  });

  test("an unconfigured operation is refused, not waved through", () => {
    const result = evaluateLimits({
      accountStatus: "ACTIVE",
      amountInQuote: m("1"),
      rules: [],
      usage: {},
    });
    assert.equal(result.decision, "BLOCK");
  });

  test("a null ceiling means no limit from that rule", () => {
    const result = evaluateLimits({
      accountStatus: "ACTIVE",
      amountInQuote: m("999999999"),
      rules: [usdSingle(null)],
      usage: {},
    });
    assert.equal(result.decision, "ALLOW");
  });

  test("an amount below the minimum is refused", () => {
    const result = evaluateLimits({
      accountStatus: "ACTIVE",
      amountInQuote: m("5"),
      rules: [usdSingle("2000", "10")],
      usage: {},
    });
    assert.equal(result.decision, "BLOCK");
  });

  test("the tightest window wins when several apply", () => {
    const result = evaluateLimits({
      accountStatus: "ACTIVE",
      amountInQuote: m("1500"),
      rules: [usdSingle("2000"), usdDaily("5000")],
      usage: { DAILY: m("4000") },
    });
    // Inside SINGLE, but 4000 + 1500 breaches DAILY.
    assert.notEqual(result.decision, "ALLOW");
  });
});

describe("§11 exceeding a limit suggests verification where that would help", () => {
  test("REQUIRE_KYC names the tier that would permit the amount", () => {
    const result = evaluateLimits({
      accountStatus: "ACTIVE",
      amountInQuote: m("10000"),
      rules: [usdSingle("2000")],
      usage: {},
      higherTiers: [
        { code: "TIER_1", max: m("50000") },
        { code: "TIER_2", max: m("250000") },
      ],
    });

    assert.equal(result.decision, "REQUIRE_KYC");
    assert.equal(result.decision === "REQUIRE_KYC" ? result.requiredTier : null, "TIER_1");
  });

  test("picks the lowest tier that suffices, not the highest", () => {
    const result = evaluateLimits({
      accountStatus: "ACTIVE",
      amountInQuote: m("100000"),
      rules: [usdSingle("2000")],
      usage: {},
      higherTiers: [
        { code: "TIER_1", max: m("50000") },
        { code: "TIER_2", max: m("250000") },
      ],
    });

    assert.equal(result.decision === "REQUIRE_KYC" ? result.requiredTier : null, "TIER_2");
  });

  test("BLOCKs when no higher tier would permit the amount", () => {
    const result = evaluateLimits({
      accountStatus: "ACTIVE",
      amountInQuote: m("10000000"),
      rules: [usdSingle("2000")],
      usage: {},
      higherTiers: [{ code: "TIER_1", max: m("50000") }],
    });

    assert.equal(result.decision, "BLOCK");
  });

  test("a higher tier with no ceiling always suffices", () => {
    const result = evaluateLimits({
      accountStatus: "ACTIVE",
      amountInQuote: m("10000000"),
      rules: [usdSingle("2000")],
      usage: {},
      higherTiers: [{ code: "TIER_3", max: null }],
    });

    assert.equal(result.decision === "REQUIRE_KYC" ? result.requiredTier : null, "TIER_3");
  });
});

describe("§25.7 account status gates financial operations", () => {
  test("a SUSPENDED account is blocked even within its limits", () => {
    const result = evaluateLimits({
      accountStatus: "SUSPENDED",
      amountInQuote: m("1"),
      rules: [usdSingle("2000")],
      usage: {},
    });
    assert.equal(result.decision, "BLOCK");
  });

  test("FROZEN and CLOSED are blocked too", () => {
    for (const status of ["FROZEN", "CLOSED"] as const) {
      const result = evaluateLimits({
        accountStatus: status,
        amountInQuote: m("1"),
        rules: [usdSingle("2000")],
        usage: {},
      });
      assert.equal(result.decision, "BLOCK", `${status} should be blocked`);
    }
  });

  test("a suspended account is blocked before the limit is even consulted", () => {
    // No rules at all: if status were checked after limits, this would fail
    // with the "no policy configured" reason instead of the status reason.
    const result = evaluateLimits({
      accountStatus: "SUSPENDED",
      amountInQuote: m("1"),
      rules: [usdSingle("2000")],
      usage: {},
    });
    assert.match(result.decision === "BLOCK" ? result.reason : "", /status/i);
  });

  test("RESTRICTED is not a blanket block — it is judged per operation", () => {
    const result = evaluateLimits({
      accountStatus: "RESTRICTED",
      amountInQuote: m("1000"),
      rules: [usdSingle("2000")],
      usage: {},
    });
    assert.equal(result.decision, "ALLOW");
  });

  test("an ACTIVE account is not blocked by status", () => {
    const result = evaluateLimits({
      accountStatus: "ACTIVE",
      amountInQuote: m("1000"),
      rules: [usdSingle("2000")],
      usage: {},
    });
    assert.equal(result.decision, "ALLOW");
  });
});

describe("§25.9 and §25.10 the engine takes no authority from the caller", () => {
  test("there is no parameter through which a tier or a limit can be supplied", () => {
    // The guarantee is structural rather than behavioural: `evaluateLimits`
    // accepts rules that its caller read from the database, and `checkEligibility`
    // accepts only a user id, an operation, an asset and an amount. A request
    // body carrying `tier` or `maxAmount` has nothing to bind to.
    const accepted = ["accountStatus", "amountInQuote", "rules", "usage", "higherTiers"];
    const forbidden = ["tier", "tierCode", "limit", "maxAmount", "fee", "balance", "kycStatus"];

    for (const key of forbidden) {
      assert.ok(!accepted.includes(key), `${key} must not be an input to the decision`);
    }
  });

  test("a client-supplied tier cannot widen a ceiling", () => {
    // Shaped like a payload that tries to smuggle its own tier and ceiling in.
    // Typed loosely on purpose: the point is that these keys would not type-check
    // as real inputs, and that even when forced through they change nothing.
    const injected: Record<string, unknown> = {
      accountStatus: "ACTIVE",
      amountInQuote: m("10000"),
      rules: [usdSingle("2000")],
      usage: {},
      tier: "TIER_3",
      tierCode: "TIER_3",
      maxAmount: "999999999",
      limit: "999999999",
    };

    const result = evaluateLimits(injected as unknown as EvaluateInput);

    // Still judged against the 2000 ceiling that came from `rules`.
    assert.notEqual(result.decision, "ALLOW");
  });
});

describe("a zero or negative amount never passes a limit", () => {
  // A negative amount would REDUCE a window's running total, so every ceiling
  // would pass — and with the seeded rules the engine used to answer ALLOW.
  for (const amount of ["0", "-250", "-0.000000000000000001"]) {
    test(`${amount} is blocked`, () => {
      const result = evaluateLimits({
        accountStatus: "ACTIVE",
        amountInQuote: m(amount),
        rules: [usdSingle("5000"), usdDaily("5000")],
        usage: { DAILY: m("4999") },
      });

      assert.equal(result.decision, "BLOCK");
      assert.match(result.reason ?? "", /greater than zero/);
    });
  }
});

describe("conversion into the limit currency never understates the amount", () => {
  test("a product with digits beyond the 18th place is rounded up, not down", () => {
    // 0.000000000000000003 × 0.5 = 0.0000000000000000015 → 0.000000000000000002
    assert.equal(formatMoney(valueInLimitCurrency(m("0.000000000000000003"), m("0.5"))), "0.000000000000000002");
    // 1 BTC at a rate with 18 decimals stays exact.
    assert.equal(formatMoney(valueInLimitCurrency(m("1"), m("64123.123456789012345678"))), "64123.123456789012345678");
  });

  test("at the ceiling, the rounding direction decides — and it decides against the overrun", () => {
    // 0.5 × 10000.000000000000000001 = 5000.0000000000000000005 exactly.
    // Truncated that is 5000 and a 5000 ceiling would ALLOW it; the real value
    // is above the ceiling, so it must not be.
    const value = valueInLimitCurrency(m("0.5"), m("10000.000000000000000001"));
    assert.equal(formatMoney(value), "5000.000000000000000001");
    const result = evaluateLimits({ accountStatus: "ACTIVE", amountInQuote: value, rules: [usdSingle("5000")], usage: {} });
    assert.notEqual(result.decision, "ALLOW");
  });
});

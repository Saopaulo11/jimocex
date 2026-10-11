import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  ZERO,
  absMoney,
  addMoney,
  compareMoney,
  divideMoney,
  equalsMoney,
  formatMoney,
  fromDatabase,
  greaterThan,
  isNegative,
  isPositive,
  isZero,
  lessThan,
  maxMoney,
  minMoney,
  moneyFromUnits,
  multiplyMoney,
  negateMoney,
  parseMoney,
  percentageOf,
  subtractMoney,
  sumMoney,
  toDatabase,
  tryParseMoney,
} from "../money.ts";

/**
 * Tests for the financial boundary.
 *
 * The defect this module exists to close is specific and measurable: PostgREST
 * serialises numeric(38,18) as a JSON number, JSON.parse makes it a double, and
 * the low-order digits are gone. The first suite reproduces that loss so the
 * rest of the file is testing against a demonstrated failure rather than a
 * theoretical one.
 */

describe("the defect this module closes", () => {
  test("a JSON number cannot carry a numeric(38,18)", () => {
    const stored = "1234567890123456.123456789012345678";
    const throughJson = String(JSON.parse(`{"v":${stored}}`).v);

    assert.notEqual(throughJson, stored);
    assert.equal(throughJson, "1234567890123456");
  });

  test("the same value survives as a string", () => {
    const stored = "1234567890123456.123456789012345678";
    assert.equal(formatMoney(parseMoney(stored)), stored);
  });

  test("one wei survives", () => {
    const wei = "0.000000000000000001";
    assert.equal(formatMoney(parseMoney(wei)), wei);
    // What it becomes as a JSON number — not even the same notation.
    assert.equal(String(JSON.parse(`{"v":${wei}}`).v), "1e-18");
  });
});

describe("parseMoney", () => {
  test("round-trips exact decimals", () => {
    for (const value of [
      "0",
      "1",
      "0.1",
      "0.2",
      "0.3",
      "12345.6789",
      "0.000000000000000001",
      "99999999999999999999.999999999999999999",
      "-42.5",
    ]) {
      assert.equal(formatMoney(parseMoney(value)), value, `round-trip ${value}`);
    }
  });

  test("normalises leading plus, leading zeros and bare decimals", () => {
    assert.equal(formatMoney(parseMoney("+5")), "5");
    assert.equal(formatMoney(parseMoney("007")), "7");
    assert.equal(formatMoney(parseMoney(".5")), "0.5");
    assert.equal(formatMoney(parseMoney("5.")), "5");
    assert.equal(formatMoney(parseMoney("  12.25  ")), "12.25");
  });

  test("negative zero formats as zero", () => {
    assert.equal(formatMoney(parseMoney("-0.000")), "0");
  });

  test("rejects anything that is not an exact decimal", () => {
    for (const bad of ["", " ", "abc", "1,000", "Infinity", "NaN", "0x10", "1/2", "--1", "1.2.3"]) {
      assert.throws(() => parseMoney(bad), RangeError, `should reject ${JSON.stringify(bad)}`);
    }
  });

  test("rejects exponent notation, which is how a float stringifies", () => {
    for (const bad of ["1e18", "1E18", "1e-18", "1.5e3"]) {
      assert.throws(() => parseMoney(bad), RangeError);
    }
  });

  test("rejects a number argument outright", () => {
    // @ts-expect-error — the point of the test is the runtime guard.
    assert.throws(() => parseMoney(1.5), TypeError);
  });

  test("truncates beyond 18 places by default, and can round instead", () => {
    const tooPrecise = "0.1234567890123456789";
    assert.equal(formatMoney(parseMoney(tooPrecise)), "0.123456789012345678");
    assert.equal(formatMoney(parseMoney(tooPrecise, "up")), "0.123456789012345679");
    assert.equal(formatMoney(parseMoney("0.0000000000000000005", "half-up")), "0.000000000000000001");
    assert.equal(formatMoney(parseMoney("0.0000000000000000004", "half-up")), "0");
    assert.equal(formatMoney(parseMoney("0.0000000000000000009", "half-up")), "0.000000000000000001");
    assert.equal(formatMoney(parseMoney("0.00000000000000000049", "half-up")), "0");
  });
});

describe("fromDatabase — the gate", () => {
  test("parses a string exactly", () => {
    const value = fromDatabase("1234.5678", "wallets.available_balance");
    assert.equal(formatMoney(value), "1234.5678");
  });

  test("passes null through for a nullable column", () => {
    assert.equal(fromDatabase(null, "tier_limits.max_amount"), null);
  });

  test("THROWS on a number, naming the column", () => {
    // The whole safety property: a dropped ::text cast must fail loudly on the
    // first read, not quietly approve an operation against a rounded ceiling.
    assert.throws(
      // @ts-expect-error — simulating a select that forgot the cast.
      () => fromDatabase(1234.5678, "wallets.available_balance"),
      (error: Error) => {
        assert.ok(error instanceof TypeError);
        assert.match(error.message, /wallets\.available_balance/);
        assert.match(error.message, /available_balance::text/);
        return true;
      },
    );
  });

  test("throws on any other type", () => {
    for (const bad of [true, {}, [], Symbol("x")]) {
      // @ts-expect-error — runtime guard.
      assert.throws(() => fromDatabase(bad, "trades.price"), TypeError);
    }
  });
});

describe("arithmetic is exact", () => {
  test("0.1 + 0.2 is exactly 0.3, which it is not in floating point", () => {
    assert.equal(formatMoney(addMoney(parseMoney("0.1"), parseMoney("0.2"))), "0.3");
    assert.notEqual(0.1 + 0.2, 0.3);
  });

  test("addition, subtraction and negation", () => {
    assert.equal(formatMoney(addMoney(parseMoney("1.5"), parseMoney("2.25"))), "3.75");
    assert.equal(formatMoney(subtractMoney(parseMoney("1.5"), parseMoney("2.25"))), "-0.75");
    assert.equal(formatMoney(negateMoney(parseMoney("-3"))), "3");
    assert.equal(formatMoney(absMoney(parseMoney("-3.5"))), "3.5");
  });

  test("sum over many values does not drift", () => {
    // 0.1 added ten times is 1 exactly here; as doubles it is 0.9999999999999999.
    const tenth = parseMoney("0.1");
    const values = Array.from({ length: 10 }, () => tenth);
    assert.equal(formatMoney(sumMoney(values)), "1");

    let asFloat = 0;
    for (let i = 0; i < 10; i += 1) asFloat += 0.1;
    assert.notEqual(asFloat, 1);
  });

  test("multiplication rescales correctly", () => {
    // 2.5 BTC at 50,000 = 125,000
    assert.equal(
      formatMoney(multiplyMoney(parseMoney("2.5"), parseMoney("50000"))),
      "125000",
    );
    assert.equal(formatMoney(multiplyMoney(parseMoney("0.1"), parseMoney("0.1"))), "0.01");
  });

  test("multiplication truncates rather than inventing value", () => {
    // A product needing a 19th place: truncation is the default because a
    // payout rounded up pays value the platform does not hold.
    const a = parseMoney("0.000000000000000001");
    const b = parseMoney("0.5");
    assert.equal(formatMoney(multiplyMoney(a, b)), "0");
    assert.equal(formatMoney(multiplyMoney(a, b, "up")), "0.000000000000000001");
  });

  test("division keeps the scale", () => {
    assert.equal(formatMoney(divideMoney(parseMoney("1"), parseMoney("4"))), "0.25");
    assert.equal(
      formatMoney(divideMoney(parseMoney("1"), parseMoney("3"))),
      "0.333333333333333333",
    );
  });

  test("division by zero throws rather than yielding Infinity", () => {
    assert.throws(() => divideMoney(parseMoney("1"), ZERO), RangeError);
  });

  test("percentageOf rounds up, so a fee is never under-charged by a step", () => {
    assert.equal(formatMoney(percentageOf(parseMoney("1000"), parseMoney("0.5"))), "5");
    assert.equal(formatMoney(percentageOf(parseMoney("100"), parseMoney("0.2"))), "0.2");
    // A fraction of the smallest unit still charges one unit, not zero.
    assert.equal(
      formatMoney(percentageOf(parseMoney("0.000000000000000001"), parseMoney("50"))),
      "0.000000000000000001",
    );
  });

  test("signs are handled correctly in division", () => {
    assert.equal(formatMoney(divideMoney(parseMoney("-1"), parseMoney("4"))), "-0.25");
    assert.equal(formatMoney(divideMoney(parseMoney("1"), parseMoney("-4"))), "-0.25");
    assert.equal(formatMoney(divideMoney(parseMoney("-1"), parseMoney("-4"))), "0.25");
  });
});

describe("comparison", () => {
  test("ordering", () => {
    const a = parseMoney("1.5");
    const b = parseMoney("2.5");
    assert.equal(compareMoney(a, b), -1);
    assert.equal(compareMoney(b, a), 1);
    assert.equal(compareMoney(a, parseMoney("1.5")), 0);
    assert.ok(lessThan(a, b));
    assert.ok(greaterThan(b, a));
    assert.ok(equalsMoney(a, parseMoney("1.500")));
  });

  test("predicates", () => {
    assert.ok(isZero(ZERO));
    assert.ok(isPositive(parseMoney("0.000000000000000001")));
    assert.ok(isNegative(parseMoney("-0.000000000000000001")));
    assert.ok(!isZero(parseMoney("0.000000000000000001")));
  });

  test("min and max", () => {
    const a = parseMoney("1");
    const b = parseMoney("2");
    assert.equal(formatMoney(minMoney(a, b)), "1");
    assert.equal(formatMoney(maxMoney(a, b)), "2");
  });

  test("a difference below float resolution is still detected", () => {
    // These two are the same number as doubles. They are not the same here.
    const a = parseMoney("1000000000000000.000000000000000001");
    const b = parseMoney("1000000000000000.000000000000000002");
    assert.notEqual(compareMoney(a, b), 0);
    assert.equal(Number("1000000000000000.000000000000000001"), Number("1000000000000000.000000000000000002"));
  });
});

describe("formatting", () => {
  test("decimals truncate, never round up", () => {
    const value = parseMoney("1.999999");
    assert.equal(formatMoney(value, { decimals: 2 }), "1.99");
    assert.equal(formatMoney(value, { decimals: 0 }), "1");
  });

  test("minDecimals pads", () => {
    assert.equal(formatMoney(parseMoney("5"), { minDecimals: 2 }), "5.00");
    assert.equal(formatMoney(parseMoney("5.1"), { decimals: 4, minDecimals: 4 }), "5.1000");
  });

  test("grouping is opt-in", () => {
    assert.equal(formatMoney(parseMoney("1234567.89")), "1234567.89");
    assert.equal(formatMoney(parseMoney("1234567.89"), { group: true }), "1,234,567.89");
  });

  test("toDatabase renders a value PostgreSQL will accept unchanged", () => {
    const value = parseMoney("1234567890123456.123456789012345678");
    assert.equal(toDatabase(value), "1234567890123456.123456789012345678");
  });
});

describe("construction helpers", () => {
  test("moneyFromUnits", () => {
    assert.equal(formatMoney(moneyFromUnits(5)), "5");
    assert.equal(formatMoney(moneyFromUnits(0n)), "0");
    assert.throws(() => moneyFromUnits(1.5), RangeError);
  });

  test("tryParseMoney returns null instead of throwing", () => {
    assert.equal(tryParseMoney("abc"), null);
    assert.equal(tryParseMoney(5), null);
    assert.equal(tryParseMoney(null), null);
    assert.equal(formatMoney(tryParseMoney("1.5")!), "1.5");
  });
});

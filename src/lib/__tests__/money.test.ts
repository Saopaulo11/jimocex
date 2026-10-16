import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  ZERO,
  absMoney,
  addMoney,
  compareMoney,
  divideMoney,
  equalsMoney,
  asDecimalString,
  formatMoney,
  fromDatabase,
  fromDatabaseNullable,
  greaterThan,
  hasAtMostDecimals,
  isNegative,
  isPositive,
  isZero,
  lessThan,
  maxMoney,
  minMoney,
  moneyFromUnits,
  multiplyMoney,
  negateMoney,
  parseAmountInput,
  parseJsonExact,
  parseMoney,
  percentageOf,
  subtractMoney,
  sumMoney,
  toDatabase,
  toDecimalString,
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

  test("passes null through only where the column is declared nullable", () => {
    assert.equal(fromDatabaseNullable(null, "tier_limits.max_amount"), null);
    assert.equal(formatMoney(fromDatabaseNullable("5000", "tier_limits.max_amount")!), "5000");
  });

  test("THROWS on null through the non-null gate, naming the column", () => {
    // @ts-expect-error — a nullable value through the non-null gate.
    assert.throws(() => fromDatabase(null, "wallets.available_balance"), /wallets\.available_balance is NULL/);
  });

  test("THROWS on a missing key instead of reading it as 'no value'", () => {
    // A select string that drifted from the code reading it. Read as null,
    // a missing max_amount would mean "no ceiling" and the limit engine would
    // allow everything; it must fail instead.
    const row = {} as { max_amount: string | null };
    assert.throws(() => fromDatabaseNullable(row.max_amount, "tier_limits.max_amount"), /missing/);
    const balance = {} as { available_balance: string };
    assert.throws(() => fromDatabase(balance.available_balance, "wallets.available_balance"), /missing/);
  });

  test("THROWS on more than 18 decimals instead of truncating", () => {
    // The one input on which the read gate used to change a value silently.
    assert.throws(
      () => fromDatabase("0.0000000000000000019", "wallets.available_balance"),
      /wallets\.available_balance: "0\.0000000000000000019" has more than 18 decimal places/,
    );
    assert.throws(() => fromDatabaseNullable("-1.0000000000000000001", "t.c"), RangeError);
    // Trailing zeros beyond 18 places are not precision.
    assert.equal(formatMoney(fromDatabase("1.50000000000000000000", "t.c")), "1.5");
  });

  test("THROWS on anything numeric::text never produces", () => {
    for (const bad of [" 1", "1 ", "+1", ".5", "5.", "1e5", "0x10"]) {
      assert.throws(() => fromDatabase(bad, "t.c"), RangeError, JSON.stringify(bad));
    }
  });

  test("THROWS on PostgreSQL's NaN, naming the column", () => {
    assert.throws(() => fromDatabase("NaN", "trades.price"), /trades\.price: "NaN" is not an exact decimal/);
    assert.throws(() => fromDatabase("Infinity", "trades.price"), RangeError);
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

describe("the smallest and largest values survive every hop", () => {
  // numeric(38,18): eighteen fractional digits, twenty integer digits.
  const EDGES = [
    "0",
    "0.000000000000000001",
    "-0.000000000000000001",
    "1.000000000000000001",
    "99999999999999999999.999999999999999999",
    "-99999999999999999999.999999999999999999",
    "1234567890123456.123456789012345678",
  ];

  test("decimal string -> Money -> database string, unchanged", () => {
    for (const edge of EDGES) {
      assert.equal(toDatabase(parseMoney(edge)), edge);
      assert.equal(toDatabase(fromDatabase(edge, "t.c")), edge);
    }
  });

  test("arithmetic at the edges is exact", () => {
    const unit = parseMoney("0.000000000000000001");
    const max = parseMoney("99999999999999999999.999999999999999999");
    assert.equal(formatMoney(subtractMoney(max, unit)), "99999999999999999999.999999999999999998");
    assert.equal(formatMoney(addMoney(parseMoney("1"), unit)), "1.000000000000000001");
    // A million units, one at a time: exactly 0.000000000001, no drift.
    let total = ZERO;
    for (let i = 0; i < 1_000_000; i++) total = addMoney(total, unit);
    assert.equal(formatMoney(total), "0.000000000001");
  });

  test("a deterministic sweep of random decimals round-trips exactly", () => {
    // xorshift: reproducible, no Math.random, so a failure can be replayed.
    let state = 0x2545f491n;
    const next = (): bigint => {
      state ^= (state << 13n) & 0xffffffffn;
      state ^= state >> 17n;
      state ^= (state << 5n) & 0xffffffffn;
      return state;
    };
    for (let i = 0; i < 5_000; i++) {
      const whole = (next() * next() * next()) % 10n ** 20n;
      const fraction = ((next() * next() * next()) % 10n ** 18n).toString().padStart(18, "0");
      const sign = next() % 2n === 0n ? "" : "-";
      const text = `${sign}${whole}.${fraction}`;

      // The canonical form: trailing fractional zeros dropped, no "-0".
      const trimmed = fraction.replace(/0+$/, "");
      const magnitude = trimmed ? `${whole}.${trimmed}` : `${whole}`;
      const expected = magnitude === "0" ? "0" : `${sign}${magnitude}`;

      assert.equal(toDatabase(parseMoney(text)), expected, text);
      assert.equal(toDatabase(fromDatabase(expected, "t.c")), expected, text);
    }
  });
});

describe("toDatabase — the gate on the way in", () => {
  test("returns the exact decimal, never exponent notation", () => {
    assert.equal(toDatabase(parseMoney("0.000000000000000001")), "0.000000000000000001");
    assert.equal(toDatabase(ZERO), "0");
  });

  test("refuses a value numeric(38,18) cannot hold, instead of letting PostgreSQL error later", () => {
    assert.throws(
      () => toDatabase(parseMoney("100000000000000000000"), { column: "deposits.amount" }),
      /deposits\.amount: 100000000000000000000 does not fit numeric\(38,18\)/,
    );
    assert.throws(() => toDatabase(parseMoney("-100000000000000000000")), RangeError);
  });

  test("refuses digits a narrower column would round away silently", () => {
    const percent = { precision: 10, scale: 6 };
    assert.equal(toDatabase(parseMoney("0.125"), { numeric: percent }), "0.125");
    assert.equal(toDatabase(parseMoney("99.999999"), { numeric: percent }), "99.999999");
    assert.throws(
      () => toDatabase(parseMoney("0.1234565"), { numeric: percent, column: "fee_rules.percentage" }),
      /fee_rules\.percentage: 0\.1234565 has more than 6 decimal places/,
    );
    assert.throws(() => toDatabase(parseMoney("10000"), { numeric: percent }), /does not fit numeric\(10,6\)/);
  });

  test("refuses anything that is not Money at runtime", () => {
    // @ts-expect-error — a float forced through a cast.
    assert.throws(() => toDatabase(1.5, { column: "deposits.amount" }), /deposits\.amount: toDatabase expects Money/);
    // @ts-expect-error — a decimal string that skipped parseMoney.
    assert.throws(() => toDatabase("1.5"), TypeError);
  });
});

describe("DecimalString producers", () => {
  test("toDecimalString is exact", () => {
    assert.equal(toDecimalString(parseMoney("-1.50")), "-1.5");
  });

  test("asDecimalString names the field when handed a Money", () => {
    assert.throws(() => asDecimalString(parseMoney("1.5"), "ticker.price"), /ticker\.price is a bigint/);
    assert.throws(() => asDecimalString({}, "ticker.price"), /ticker\.price: object is not an exact decimal/);
  });

  test("asDecimalString accepts a plain decimal unchanged and refuses the rest", () => {
    assert.equal(asDecimalString("0.000000016180339887", "ticker.price"), "0.000000016180339887");
    assert.throws(() => asDecimalString(0.1, "ticker.price"), /ticker\.price is a JavaScript number/);
    for (const bad of ["1e-8", "NaN", "", "1,5", "0x10", null, undefined]) {
      assert.throws(() => asDecimalString(bad, "ticker.price"), RangeError, String(bad));
    }
  });
});

describe("rounding direction", () => {
  test("parse: magnitude modes keep the sign, directional modes follow the number line", () => {
    const cases: [string, string, string][] = [
      // input, mode, expected
      ["0.0000000000000000015", "truncate", "0.000000000000000001"],
      ["0.0000000000000000015", "up", "0.000000000000000002"],
      ["0.0000000000000000015", "half-up", "0.000000000000000002"],
      ["0.0000000000000000015", "floor", "0.000000000000000001"],
      ["0.0000000000000000015", "ceil", "0.000000000000000002"],
      ["-0.0000000000000000015", "truncate", "-0.000000000000000001"],
      ["-0.0000000000000000015", "up", "-0.000000000000000002"],
      ["-0.0000000000000000015", "half-up", "-0.000000000000000002"],
      ["-0.0000000000000000015", "floor", "-0.000000000000000002"],
      ["-0.0000000000000000015", "ceil", "-0.000000000000000001"],
      ["-0.0000000000000000001", "floor", "-0.000000000000000001"],
      ["-0.0000000000000000001", "ceil", "0"],
    ];
    for (const [input, mode, expected] of cases) {
      assert.equal(formatMoney(parseMoney(input, mode as never)), expected, `${input} ${mode}`);
    }
  });

  test("divide and multiply agree with parse on every mode", () => {
    const three = parseMoney("3");
    const minusOne = parseMoney("-1");
    // -1/3 = -0.333…: truncate/ceil toward zero, up/floor away from it.
    assert.equal(formatMoney(divideMoney(minusOne, three, "truncate")), "-0.333333333333333333");
    assert.equal(formatMoney(divideMoney(minusOne, three, "ceil")), "-0.333333333333333333");
    assert.equal(formatMoney(divideMoney(minusOne, three, "floor")), "-0.333333333333333334");
    assert.equal(formatMoney(divideMoney(minusOne, three, "up")), "-0.333333333333333334");
    assert.equal(formatMoney(divideMoney(parseMoney("1"), three, "ceil")), "0.333333333333333334");
    const tiny = parseMoney("0.000000000000000001");
    const half = parseMoney("-0.5");
    assert.equal(formatMoney(multiplyMoney(tiny, half, "floor")), "-0.000000000000000001");
    assert.equal(formatMoney(multiplyMoney(tiny, half, "ceil")), "0");
  });
});

describe("formatMoney validates its options", () => {
  const value = parseMoney("1.23");
  for (const bad of [-1, 1.5, 19, Number.NaN, Number.POSITIVE_INFINITY]) {
    test(`decimals ${bad} is refused`, () => {
      assert.throws(() => formatMoney(value, { decimals: bad }), RangeError);
      assert.throws(() => formatMoney(value, { minDecimals: bad }), RangeError);
    });
  }
  test("minDecimals beyond decimals is refused rather than padded with invented zeros", () => {
    assert.throws(() => formatMoney(parseMoney("1.123456"), { decimals: 2, minDecimals: 4 }), RangeError);
    assert.equal(formatMoney(parseMoney("1.1"), { decimals: 4, minDecimals: 4 }), "1.1000");
  });

  test("a negative value that truncates to zero shows no sign", () => {
    assert.equal(formatMoney(parseMoney("-0.001"), { decimals: 2, minDecimals: 2 }), "0.00");
  });
});

describe("hasAtMostDecimals", () => {
  test("accepts a value within the precision", () => {
    assert.equal(hasAtMostDecimals(parseMoney("60000.00"), 2), true);
    assert.equal(hasAtMostDecimals(parseMoney("0.5"), 8), true);
    assert.equal(hasAtMostDecimals(parseMoney("100"), 0), true);
  });
  test("rejects a value finer than the precision", () => {
    assert.equal(hasAtMostDecimals(parseMoney("60000.001"), 2), false);
    assert.equal(hasAtMostDecimals(parseMoney("0.000000001"), 8), false);
  });
  test("handles a negative value by magnitude", () => {
    assert.equal(hasAtMostDecimals(parseMoney("-1.25"), 2), true);
    assert.equal(hasAtMostDecimals(parseMoney("-1.253"), 2), false);
  });
  test("rejects an out-of-range places argument", () => {
    assert.throws(() => hasAtMostDecimals(parseMoney("1"), 19), RangeError);
  });
});

describe("parseAmountInput — what a customer types", () => {
  const usdt = { maxDecimals: 6 };
  const ok = (raw: string, options = usdt): string => {
    const result = parseAmountInput(raw, options);
    assert.ok(result.ok, `${JSON.stringify(raw)} should be accepted`);
    return formatMoney(result.value);
  };
  const refused = (raw: string, options = usdt): string => {
    const result = parseAmountInput(raw, options);
    assert.ok(!result.ok, `${JSON.stringify(raw)} should be refused`);
    return result.problem;
  };

  test("accepts plain decimals within the asset's precision", () => {
    assert.equal(ok("250"), "250");
    assert.equal(ok(" 0.5 "), "0.5");
    assert.equal(ok(".5"), "0.5");
    assert.equal(ok("5."), "5");
    assert.equal(ok("0.000001"), "0.000001");
    assert.equal(ok("1.500000000"), "1.5");
    assert.equal(ok("0.000000000000000001", { maxDecimals: 18 }), "0.000000000000000001");
    assert.equal(ok("99999999999999999999.999999999999999999", { maxDecimals: 18 }), "99999999999999999999.999999999999999999");
  });

  test("refuses with a stable reason", () => {
    assert.equal(refused(""), "empty");
    assert.equal(refused("   "), "empty");
    assert.equal(refused("-5"), "malformed");
    assert.equal(refused("+5"), "malformed");
    assert.equal(refused("1e3"), "malformed");
    assert.equal(refused("1,000"), "malformed");
    assert.equal(refused("10,5"), "malformed");
    assert.equal(refused("."), "malformed");
    assert.equal(refused("１２"), "malformed");
    assert.equal(refused("٣"), "malformed");
    assert.equal(refused("NaN"), "malformed");
    assert.equal(refused("0"), "not_positive");
    assert.equal(refused("0.000000"), "not_positive");
    assert.equal(refused("0.0000001"), "too_many_decimals");
    assert.equal(refused("10.005", { maxDecimals: 2 }), "too_many_decimals");
    assert.equal(refused("100000000000000000000", { maxDecimals: 18 }), "too_large");
  });

  test("a programming error in the precision is not a customer error", () => {
    assert.throws(() => parseAmountInput("1", { maxDecimals: 19 }), RangeError);
    assert.throws(() => parseAmountInput("1", { maxDecimals: -1 }), RangeError);
  });
});

describe("parseJsonExact — a provider's JSON body", () => {
  test("keeps every number's exact digits", () => {
    const body = '{"amount": 1234567890123456.123456789012345678, "fee": 0.000000000000000001, "n": [0.1, 2, -0]}';
    // What JSON.parse does to the same body, for contrast.
    assert.equal(JSON.parse(body).amount, 1234567890123456);
    assert.deepEqual(parseJsonExact(body), {
      amount: "1234567890123456.123456789012345678",
      fee: "0.000000000000000001",
      n: ["0.1", "2", "-0"],
    });
  });

  test("expands exponent notation exactly", () => {
    const cases: [string, string][] = [
      ["1e-8", "0.00000001"],
      ["1.5E-7", "0.00000015"],
      ["-2.5e-18", "-0.0000000000000000025"],
      ["1.23456789e+3", "1234.56789"],
      ["5e2", "500"],
      ["0.0001e2", "0.01"],
      ["12e0", "12"],
    ];
    for (const [source, expected] of cases) {
      assert.equal(parseJsonExact(source), expected, source);
    }
  });

  test("leaves strings, booleans and null alone", () => {
    assert.deepEqual(parseJsonExact('{"a":"1.5","b":true,"c":null}'), { a: "1.5", b: true, c: null });
  });

  test("refuses an exponent that would expand far past any amount", () => {
    assert.throws(() => parseJsonExact("1e999999"), RangeError);
    // An untrusted body of many small numbers with large exponents must not
    // expand into megabytes.
    assert.throws(() => parseJsonExact("[1e400]"), RangeError);
    assert.throws(() => parseJsonExact("[1e-400]"), RangeError);
    assert.equal(parseJsonExact("1e64"), "1" + "0".repeat(64));
    assert.throws(() => parseJsonExact("1e65"), RangeError);
  });

  test("every number it yields is accepted by parseMoney", () => {
    const value = parseJsonExact('{"p": 1.6180339887e-8}') as { p: string };
    assert.equal(formatMoney(parseMoney(value.p)), "0.000000016180339887");
  });
});

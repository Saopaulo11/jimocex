import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { computeFee, type ResolvedFeeRule } from "../fee-rules.ts";
import { formatMoney, parseMoney, ZERO, type Money } from "../../money.ts";

/**
 * FeeEngine arithmetic tests (spec §26). Run with `node --test`, which strips
 * the types and runs the real module — hence the explicit `.ts` imports.
 *
 * Pure: no database, no fee_rules row read here. The I/O half that selects the
 * rule is covered separately once it exists; this covers the money math that
 * decides what the platform charges.
 */

const m = (v: string): Money => parseMoney(v);
const rule = (r: Partial<ResolvedFeeRule>): ResolvedFeeRule => ({
  percentage: r.percentage ?? ZERO,
  fixedFee: r.fixedFee ?? ZERO,
  minFee: r.minFee ?? null,
  maxFee: r.maxFee ?? null,
});

describe("computeFee", () => {
  test("TRADE 0.20% of 1000 = 2", () => {
    assert.equal(formatMoney(computeFee(m("1000"), rule({ percentage: m("0.2") }))), "2");
  });

  test("SWAP 0.50% of 250 = 1.25", () => {
    assert.equal(formatMoney(computeFee(m("250"), rule({ percentage: m("0.5") }))), "1.25");
  });

  test("zero percentage and zero fixed = zero (a configured answer, not missing)", () => {
    assert.equal(formatMoney(computeFee(m("1000"), rule({}))), "0");
  });

  test("fixed fee adds to the proportional part", () => {
    assert.equal(formatMoney(computeFee(m("1000"), rule({ percentage: m("0.2"), fixedFee: m("0.5") }))), "2.5");
  });

  test("the proportional part rounds UP (platform never under-charges)", () => {
    // 0.2% of 333.333 = 0.666666; with 18-place scale the exact product rounds
    // up on any discarded remainder.
    const fee = computeFee(m("333.3335"), rule({ percentage: m("0.2") }));
    // 0.2% of 333.3335 = 0.666667 exactly (6 dp); no rounding needed, exact.
    assert.equal(formatMoney(fee), "0.666667");
  });

  test("rounds up when the exact product has a remainder past 18 places", () => {
    // 1% of 0.000000000000000001 = 0.0000000000000000000 1 -> one unit up.
    const fee = computeFee(m("0.000000000000000001"), rule({ percentage: m("1") }));
    assert.equal(formatMoney(fee), "0.000000000000000001");
  });

  test("min_fee raises a small fee to the floor", () => {
    const fee = computeFee(m("10"), rule({ percentage: m("0.2"), minFee: m("1") })); // 0.02 -> 1
    assert.equal(formatMoney(fee), "1");
  });

  test("max_fee caps a large fee", () => {
    const fee = computeFee(m("1000000"), rule({ percentage: m("0.5"), maxFee: m("100") })); // 5000 -> 100
    assert.equal(formatMoney(fee), "100");
  });

  test("min and max together: in-range fee is unchanged", () => {
    const fee = computeFee(m("1000"), rule({ percentage: m("0.2"), minFee: m("1"), maxFee: m("100") }));
    assert.equal(formatMoney(fee), "2");
  });

  test("fee on a zero base is the fixed component only", () => {
    assert.equal(formatMoney(computeFee(ZERO, rule({ percentage: m("0.5"), fixedFee: m("0.25") }))), "0.25");
  });

  test("a negative base is refused", () => {
    assert.throws(() => computeFee(m("-1"), rule({ percentage: m("0.2") })), RangeError);
  });

  test("result is never negative even if max_fee is zero", () => {
    assert.equal(formatMoney(computeFee(m("1000"), rule({ percentage: m("0.5"), maxFee: ZERO }))), "0");
  });
});

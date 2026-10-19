import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { addMoney, parseMoney, toDecimalString, type DecimalString, type Money } from "../../money.ts";
import type { ExecutionFill, ExecutionSnapshot } from "../../execution/types.ts";
import {
  checkDiscreteFill,
  cumulativeFillId,
  deriveCumulativeFill,
  isCumulativeFillId,
  type FillTarget,
  type SettledFill,
} from "../fills.ts";

/**
 * Fill validation and the cumulative-delta rule (Slice 14A). Pure; run with
 * `node --test`. Figures: BTC-USDT, a 0.010 BTC order at 80000 with a 0.2% fee.
 */

const m = (v: string): Money => parseMoney(v);
const d = (v: string): DecimalString => toDecimalString(parseMoney(v));

const target = (over: Partial<FillTarget> = {}): FillTarget => ({
  side: "BUY",
  amount: m("0.010"),
  filledAmount: m("0"),
  terminal: false,
  submitted: true,
  ...over,
});

const fill = (over: Partial<ExecutionFill> = {}): ExecutionFill => ({
  externalFillId: "venue-trade-1",
  externalOrderId: "ext-1",
  side: "BUY",
  price: d("80000"),
  amount: d("0.003"),
  quoteAmount: d("240"),
  fee: d("0.48"),
  feeAsset: "USDT",
  executedAt: new Date("2026-10-19T12:00:00Z"),
  ...over,
});

const snapshot = (over: Partial<ExecutionSnapshot> = {}): ExecutionSnapshot => ({
  externalOrderId: "ext-1",
  side: "BUY",
  status: "PARTIALLY_FILLED",
  cumulativeBase: d("0.003"),
  cumulativeQuote: d("240"),
  cumulativeFee: d("0.48"),
  feeAsset: "USDT",
  observedAt: new Date("2026-10-19T12:00:00Z"),
  ...over,
});

/** What apply_fill would leave behind: the settled trades and the order's filled amount. */
function settle(settled: SettledFill[], f: ExecutionFill): SettledFill[] {
  return [...settled, { providerTradeId: f.externalFillId, base: m(f.amount), quote: m(f.quoteAmount), fee: m(f.fee) }];
}
const filledOf = (settled: SettledFill[]) => settled.reduce((sum, s) => addMoney(sum, s.base), m("0"));

describe("discrete fill validation", () => {
  test("a valid fill passes", () => assert.deepEqual(checkDiscreteFill(target(), fill(), []), { ok: true }));

  test("zero fill is refused (17)", () => {
    assert.deepEqual(checkDiscreteFill(target(), fill({ amount: d("0") }), []), { ok: false, problem: "NOT_POSITIVE" });
    assert.deepEqual(checkDiscreteFill(target(), fill({ quoteAmount: d("0") }), []), { ok: false, problem: "NOT_POSITIVE" });
  });

  test("negative fill is refused (18)", () => {
    assert.deepEqual(checkDiscreteFill(target(), fill({ amount: "-0.003" as DecimalString }), []), { ok: false, problem: "NOT_POSITIVE" });
    assert.deepEqual(checkDiscreteFill(target(), fill({ fee: "-0.01" as DecimalString }), []), { ok: false, problem: "INVALID_FEE" });
  });

  test("a fill larger than the order is refused (19)", () => {
    assert.deepEqual(checkDiscreteFill(target(), fill({ amount: d("0.011") }), []), { ok: false, problem: "OVER_FILL" });
  });

  test("a fill that would take the cumulative past the order is refused (25)", () => {
    assert.deepEqual(checkDiscreteFill(target({ filledAmount: m("0.008") }), fill({ amount: d("0.003") }), []), {
      ok: false,
      problem: "OVER_FILL",
    });
  });

  test("the exact final fill is accepted (24)", () => {
    assert.deepEqual(checkDiscreteFill(target({ filledAmount: m("0.007") }), fill({ amount: d("0.003") }), []), { ok: true });
  });

  test("a fill on a terminal order is refused", () => {
    assert.deepEqual(checkDiscreteFill(target({ terminal: true }), fill(), []), { ok: false, problem: "ORDER_TERMINAL" });
  });

  test("a fill on an order never submitted to a venue is refused (022: OPEN takes no fill)", () => {
    assert.deepEqual(checkDiscreteFill(target({ submitted: false }), fill(), []), { ok: false, problem: "NOT_SUBMITTED" });
    assert.deepEqual(deriveCumulativeFill(target({ submitted: false }), snapshot(), []), { kind: "REJECT", problem: "NOT_SUBMITTED" });
  });

  test("a side mismatch is refused", () => {
    assert.deepEqual(checkDiscreteFill(target(), fill({ side: "SELL" }), []), { ok: false, problem: "SIDE_MISMATCH" });
  });

  test("a discrete fill may not use the reserved cumulative id scheme", () => {
    const spoof = fill({ externalFillId: cumulativeFillId("ext-1", m("0")) });
    assert.deepEqual(checkDiscreteFill(target(), spoof, []), { ok: false, problem: "RESERVED_FILL_ID" });
  });

  test("an order already settled in cumulative mode refuses a discrete fill", () => {
    const settled: SettledFill[] = [{ providerTradeId: cumulativeFillId("ext-1", m("0")), base: m("0.003"), quote: m("240"), fee: m("0.48") }];
    assert.deepEqual(checkDiscreteFill(target({ filledAmount: m("0.003") }), fill(), settled), { ok: false, problem: "MIXED_FILL_MODES" });
  });
});

describe("cumulative snapshots become deltas exactly once", () => {
  test("0.003 → 0.006 → 0.010 settles 0.003, 0.003, 0.004 (23)", () => {
    let settled: SettledFill[] = [];
    const steps: [string, string, string, string, string, string][] = [
      // cumulative base, quote, fee → expected delta base, quote, fee
      ["0.003", "240", "0.48", "0.003", "240", "0.48"],
      ["0.006", "480", "0.96", "0.003", "240", "0.48"],
      ["0.010", "800", "1.60", "0.004", "320", "0.64"],
    ];
    const ids: string[] = [];
    for (const [cb, cq, cf, db, dq, df] of steps) {
      const derived = deriveCumulativeFill(
        target({ filledAmount: filledOf(settled) }),
        snapshot({ cumulativeBase: d(cb), cumulativeQuote: d(cq), cumulativeFee: d(cf) }),
        settled,
      );
      assert.equal(derived.kind, "FILL");
      if (derived.kind !== "FILL") return;
      assert.equal(derived.fill.amount, d(db));
      assert.equal(derived.fill.quoteAmount, d(dq));
      assert.equal(derived.fill.fee, d(df));
      assert.equal(derived.fill.price, d("80000"));
      ids.push(derived.fill.externalFillId);
      settled = settle(settled, derived.fill);
    }
    assert.equal(toDecimalString(filledOf(settled)), "0.01");
    // Each id is keyed on the settled base it starts from: 0, 0.003, 0.006.
    assert.deepEqual(ids, ["cumulative:ext-1:0", "cumulative:ext-1:0.003", "cumulative:ext-1:0.006"]);
  });

  test("the same snapshot again adds nothing (22)", () => {
    const settled: SettledFill[] = [{ providerTradeId: cumulativeFillId("ext-1", m("0")), base: m("0.003"), quote: m("240"), fee: m("0.48") }];
    assert.deepEqual(deriveCumulativeFill(target({ filledAmount: m("0.003") }), snapshot(), settled), { kind: "NOTHING_NEW" });
  });

  test("two derivations from the same stale settled state carry the same id — one settles, one is a duplicate", () => {
    const stale = target({ filledAmount: m("0.003") });
    const settled: SettledFill[] = [{ providerTradeId: cumulativeFillId("ext-1", m("0")), base: m("0.003"), quote: m("240"), fee: m("0.48") }];
    const a = deriveCumulativeFill(stale, snapshot({ cumulativeBase: d("0.005"), cumulativeQuote: d("400"), cumulativeFee: d("0.80") }), settled);
    const b = deriveCumulativeFill(stale, snapshot({ cumulativeBase: d("0.006"), cumulativeQuote: d("480"), cumulativeFee: d("0.96") }), settled);
    assert.ok(a.kind === "FILL" && b.kind === "FILL");
    assert.equal(a.fill.externalFillId, b.fill.externalFillId);
  });

  test("a snapshot behind what is settled is a regression, not a zero (20)", () => {
    const settled: SettledFill[] = [{ providerTradeId: cumulativeFillId("ext-1", m("0")), base: m("0.006"), quote: m("480"), fee: m("0.96") }];
    assert.deepEqual(deriveCumulativeFill(target({ filledAmount: m("0.006") }), snapshot(), settled), {
      kind: "REJECT",
      problem: "REGRESSION",
    });
  });

  test("a cumulative above the order amount is refused (19/25)", () => {
    const derived = deriveCumulativeFill(target(), snapshot({ cumulativeBase: d("0.011"), cumulativeQuote: d("880"), cumulativeFee: d("1.76") }), []);
    assert.deepEqual(derived, { kind: "REJECT", problem: "OVER_FILL" });
  });

  test("more base with no more quote, or a shrinking fee, is inconsistent", () => {
    const settled: SettledFill[] = [{ providerTradeId: cumulativeFillId("ext-1", m("0")), base: m("0.003"), quote: m("240"), fee: m("0.48") }];
    const t = target({ filledAmount: m("0.003") });
    assert.deepEqual(deriveCumulativeFill(t, snapshot({ cumulativeBase: d("0.006") }), settled), { kind: "REJECT", problem: "INCONSISTENT" });
    assert.deepEqual(
      deriveCumulativeFill(t, snapshot({ cumulativeBase: d("0.006"), cumulativeQuote: d("480"), cumulativeFee: d("0.10") }), settled),
      { kind: "REJECT", problem: "INCONSISTENT" },
    );
    // Same base, different quote: the venue contradicts itself.
    assert.deepEqual(deriveCumulativeFill(t, snapshot({ cumulativeQuote: d("241") }), settled), { kind: "REJECT", problem: "INCONSISTENT" });
  });

  test("negative or malformed totals are refused", () => {
    assert.deepEqual(deriveCumulativeFill(target(), snapshot({ cumulativeBase: "-0.003" as DecimalString }), []), {
      kind: "REJECT",
      problem: "INCONSISTENT",
    });
    assert.deepEqual(deriveCumulativeFill(target(), snapshot({ cumulativeQuote: "1e3" as DecimalString }), []), {
      kind: "REJECT",
      problem: "INCONSISTENT",
    });
  });

  test("the order row and its trades must agree — a straddled read is refused, not guessed", () => {
    assert.deepEqual(deriveCumulativeFill(target({ filledAmount: m("0.003") }), snapshot({ cumulativeBase: d("0.006") }), []), {
      kind: "REJECT",
      problem: "STATE_MISMATCH",
    });
  });

  test("an order with discrete fills refuses a snapshot", () => {
    const settled: SettledFill[] = [{ providerTradeId: "venue-trade-1", base: m("0.003"), quote: m("240"), fee: m("0.48") }];
    assert.deepEqual(deriveCumulativeFill(target({ filledAmount: m("0.003") }), snapshot({ cumulativeBase: d("0.006") }), settled), {
      kind: "REJECT",
      problem: "MIXED_FILL_MODES",
    });
  });

  test("after the order is terminal: a replay is harmless, anything more is refused (29/30)", () => {
    const settled: SettledFill[] = [{ providerTradeId: cumulativeFillId("ext-1", m("0")), base: m("0.003"), quote: m("240"), fee: m("0.48") }];
    const cancelled = target({ filledAmount: m("0.003"), terminal: true });
    assert.deepEqual(deriveCumulativeFill(cancelled, snapshot(), settled), { kind: "NOTHING_NEW" });
    assert.deepEqual(
      deriveCumulativeFill(cancelled, snapshot({ cumulativeBase: d("0.004"), cumulativeQuote: d("320"), cumulativeFee: d("0.64") }), settled),
      { kind: "REJECT", problem: "ORDER_TERMINAL" },
    );
  });

  test("a side mismatch is refused", () => {
    assert.deepEqual(deriveCumulativeFill(target(), snapshot({ side: "SELL" }), []), { kind: "REJECT", problem: "SIDE_MISMATCH" });
  });
});

describe("BUY and SELL normalize the same way (38/39)", () => {
  for (const side of ["BUY", "SELL"] as const) {
    test(`${side}: the derived fill carries the side, base, venue quote and fee`, () => {
      const derived = deriveCumulativeFill(target({ side }), snapshot({ side }), []);
      assert.equal(derived.kind, "FILL");
      if (derived.kind !== "FILL") return;
      assert.equal(derived.fill.side, side);
      assert.equal(derived.fill.amount, d("0.003"));
      assert.equal(derived.fill.quoteAmount, d("240"));
      assert.equal(derived.fill.fee, d("0.48"));
      assert.equal(derived.fill.feeAsset, "USDT");
    });
  }
});

describe("cumulative ids", () => {
  test("canonical: the same settled base always gives the same id", () => {
    assert.equal(cumulativeFillId("ext-1", m("0.0030")), cumulativeFillId("ext-1", m("0.003")));
    assert.ok(isCumulativeFillId(cumulativeFillId("ext-1", m("0"))));
    assert.ok(!isCumulativeFillId("venue-trade-1"));
  });
  test("scoped to the venue order: two orders never share an id", () => {
    assert.notEqual(cumulativeFillId("ext-1", m("0")), cumulativeFillId("ext-2", m("0")));
  });
});

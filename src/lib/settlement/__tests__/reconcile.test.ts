import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { formatMoney, parseMoney, toDecimalString, type DecimalString } from "../../money.ts";
import type { ExecutionFill, OrderSide } from "../../execution/types.ts";
import {
  classifyApplyFillError,
  decideReconciliation,
  deriveFillDelta,
  mapExecutionFillToApplyFill,
} from "../types.ts";

/**
 * Pure settlement helpers (Slice 6C): mapping, SQL-error taxonomy, cumulative
 * delta, reconciliation decisions. No gateway, no database. Run with
 * `node --test`; money imports are relative because node --test does not
 * resolve `@/`.
 */

const d = (s: string): DecimalString => toDecimalString(parseMoney(s));

const fill = (over: Partial<ExecutionFill> = {}): ExecutionFill => ({
  externalFillId: "f1",
  externalOrderId: "ext-1",
  side: "BUY" as OrderSide,
  price: d("60000"),
  amount: d("0.1"),
  quoteAmount: d("6000"),
  fee: d("12"),
  feeAsset: "USDT",
  executedAt: new Date("2026-01-01T00:00:00Z"),
  ...over,
});

describe("mapExecutionFillToApplyFill", () => {
  test("parses the fill's exact decimals and carries the resolved ids", () => {
    const input = mapExecutionFillToApplyFill(fill(), { orderId: "order-9", feeAssetId: "asset-usdt" });
    assert.equal(input.orderId, "order-9");
    assert.equal(input.providerTradeId, "f1");
    assert.equal(formatMoney(input.baseAmount), "0.1");
    assert.equal(formatMoney(input.executionPrice), "60000");
    assert.equal(formatMoney(input.feeAmount), "12");
    assert.equal(input.feeAssetId, "asset-usdt");
  });

  test("uses the venue's quoteAmount directly — never price x amount", () => {
    // A venue report whose quote is NOT price*amount; settlement must trust the
    // reported quote, not recompute 60000 * 0.1 = 6000.
    const input = mapExecutionFillToApplyFill(
      fill({ price: d("60000"), amount: d("0.1"), quoteAmount: d("5999.5") }),
      { orderId: "o", feeAssetId: null },
    );
    assert.equal(formatMoney(input.quoteAmount), "5999.5");
  });

  test("a zero-fee fill carries a null fee asset", () => {
    const input = mapExecutionFillToApplyFill(fill({ fee: d("0") }), { orderId: "o", feeAssetId: null });
    assert.equal(formatMoney(input.feeAmount), "0");
    assert.equal(input.feeAssetId, null);
  });
});

describe("classifyApplyFillError — bounded, never leaks the raw message", () => {
  const cases: { error: { code?: string | null; message?: string | null }; code: string; retryable: boolean; reconcile: boolean }[] = [
    { error: { code: "23503", message: "apply_fill: unknown order abc" }, code: "ORDER_NOT_FOUND", retryable: false, reconcile: true },
    { error: { code: "23001", message: "order X is FILLED and cannot take a new fill" }, code: "ORDER_NOT_SETTLEABLE", retryable: false, reconcile: true },
    { error: { code: "23514", message: "apply_fill: fill of 0.5 exceeds order X remaining (0.1 of 1)" }, code: "OVER_FILL", retryable: false, reconcile: true },
    { error: { code: "23514", message: "apply_fill: the fee must be denominated in the pair quote asset Y" }, code: "INVALID_FEE", retryable: false, reconcile: false },
    { error: { code: "23514", message: "apply_fill: BUY fill consumes 5 quote but only 4 is reserved" }, code: "INSUFFICIENT_RESERVATION", retryable: false, reconcile: true },
    { error: { code: "23514", message: "apply_fill: quote 1 is inconsistent with price 2 x base 3" }, code: "INVALID_PRECISION", retryable: false, reconcile: false },
    { error: { code: "23514", message: "apply_fill: base amount must be a positive number, got 0" }, code: "INVALID_FILL", retryable: false, reconcile: false },
    { error: { code: "40001", message: "could not serialize access" }, code: "DATABASE_ERROR", retryable: true, reconcile: false },
    { error: { code: "40P01", message: "deadlock detected" }, code: "DATABASE_ERROR", retryable: true, reconcile: false },
    { error: { code: "08006", message: "connection failure" }, code: "DATABASE_ERROR", retryable: true, reconcile: false },
    { error: { code: "", message: null }, code: "DATABASE_ERROR", retryable: true, reconcile: false },
    { error: { code: "XX000", message: "internal error" }, code: "UNKNOWN", retryable: false, reconcile: true },
  ];

  for (const c of cases) {
    test(`${c.error.code || "(none)"} → ${c.code}`, () => {
      const result = classifyApplyFillError(c.error);
      assert.equal(result.code, c.code);
      assert.equal(result.retryable, c.retryable);
      assert.equal(result.reconcile, c.reconcile);
      // The raw SQL message is never propagated.
      if (c.error.message) assert.notEqual(result.message, c.error.message);
    });
  }
});

describe("deriveFillDelta — cumulative snapshot → unsettled delta", () => {
  test("positive delta is the amount not yet settled", () => {
    assert.equal(formatMoney(deriveFillDelta(parseMoney("0.70"), parseMoney("0.40"))), "0.3");
  });
  test("a fully-caught-up snapshot yields zero", () => {
    assert.equal(formatMoney(deriveFillDelta(parseMoney("0.4"), parseMoney("0.4"))), "0");
  });
  test("a snapshot behind internal state never goes negative", () => {
    assert.equal(formatMoney(deriveFillDelta(parseMoney("0.3"), parseMoney("0.4"))), "0");
  });
});

describe("decideReconciliation", () => {
  test("unseen fills on a live order → SETTLE them", () => {
    const action = decideReconciliation({
      providerStatus: "PARTIALLY_FILLED",
      providerFills: [fill({ externalFillId: "a" }), fill({ externalFillId: "b" })],
      appliedProviderTradeIds: ["a"],
      internalStatus: "PARTIALLY_FILLED",
    });
    assert.ok(action.kind === "SETTLE" && action.fills.length === 1 && action.fills[0]?.externalFillId === "b");
  });

  test("all fills already applied → NOOP", () => {
    const action = decideReconciliation({
      providerStatus: "PARTIALLY_FILLED",
      providerFills: [fill({ externalFillId: "a" })],
      appliedProviderTradeIds: ["a"],
      internalStatus: "PARTIALLY_FILLED",
    });
    assert.equal(action.kind, "NOOP");
  });

  test("venue FILLED but no settleable fills → RECONCILE_REQUIRED", () => {
    const action = decideReconciliation({
      providerStatus: "FILLED",
      providerFills: [],
      appliedProviderTradeIds: [],
      internalStatus: "OPEN",
    });
    assert.equal(action.kind, "RECONCILE_REQUIRED");
  });

  test("internal terminal but venue reports a new fill → INCIDENT", () => {
    const action = decideReconciliation({
      providerStatus: "FILLED",
      providerFills: [fill({ externalFillId: "new" })],
      appliedProviderTradeIds: [],
      internalStatus: "FILLED",
    });
    assert.equal(action.kind, "INCIDENT");
  });
});

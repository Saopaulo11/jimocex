import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { toDecimalString, parseMoney, type DecimalString } from "../../money.ts";
import {
  ExecutionError,
  dedupeFills,
  mapExternalStatus,
  toErrorInfo,
  type ExecutionFill,
  type ExternalOrderStatus,
  type OrderSide,
} from "../types.ts";

/**
 * Provider-neutral execution type tests (Slice 5). Pure — no provider, no
 * network. Run with `node --test`. Money imports are relative because node
 * --test runs this file directly and does not resolve `@/`.
 */

const d = (s: string): DecimalString => toDecimalString(parseMoney(s));

const fill = (over: Partial<ExecutionFill> = {}): ExecutionFill => ({
  externalFillId: "fill-1",
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

describe("mapExternalStatus", () => {
  const cases: [ExternalOrderStatus, string | null][] = [
    ["ACCEPTED", "OPEN"],
    ["OPEN", "OPEN"],
    ["PARTIALLY_FILLED", "PARTIALLY_FILLED"],
    ["FILLED", "FILLED"],
    ["CANCELLED", "CANCELLED"],
    ["REJECTED", "REJECTED"],
    ["EXPIRED", "EXPIRED"],
    ["UNKNOWN", null],
  ];
  for (const [external, internal] of cases) {
    test(`${external} → ${internal ?? "null (reconcile)"}`, () => {
      assert.equal(mapExternalStatus(external), internal);
    });
  }
});

describe("dedupeFills", () => {
  test("drops a replayed fill by externalFillId, keeping the first", () => {
    const fills = [
      fill({ externalFillId: "f1", amount: d("0.1") }),
      fill({ externalFillId: "f2", amount: d("0.2") }),
      fill({ externalFillId: "f1", amount: d("0.1") }), // replay
    ];
    const out = dedupeFills(fills);
    assert.equal(out.length, 2);
    assert.deepEqual(
      out.map((f) => f.externalFillId),
      ["f1", "f2"],
    );
  });

  test("an empty list stays empty", () => {
    assert.deepEqual(dedupeFills([]), []);
  });
});

describe("ExecutionError / toErrorInfo", () => {
  test("carries a kind and safe flags, projected to a serializable info shape", () => {
    const err = new ExecutionError("TIMEOUT", "call exceeded 10ms", {
      retryable: false,
      ambiguous: true,
      providerName: "stub",
    });
    const info = toErrorInfo(err);
    assert.deepEqual(info, {
      kind: "TIMEOUT",
      retryable: false,
      ambiguous: true,
      message: "call exceeded 10ms",
    });
    // The serializable info intentionally omits providerName and the stack.
    assert.equal(Object.keys(info).sort().join(","), "ambiguous,kind,message,retryable");
  });
});

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { parseMoney, type Money } from "../../money.ts";
import {
  TERMINAL_PHASES,
  canTransition,
  checkOrderRecord,
  checkTransition,
  classifyVenueStatus,
  decideFinalization,
  phaseAfterFill,
  phaseFromStatus,
  type OrderPhase,
  type OrderRecord,
} from "../lifecycle.ts";
import { venueClientOrderIdFor, type ExternalOrderStatus } from "../types.ts";

/**
 * Order lifecycle (Slice 14A): the legal-transition table, record consistency,
 * what a venue status means for reserved money, and when a remainder may be
 * released. Pure; run with `node --test`.
 */

const m = (v: string): Money => parseMoney(v);

const PHASES: readonly OrderPhase[] = ["OPEN", "SUBMITTED", "PARTIALLY_FILLED", "FILLED", "CANCELLED", "REJECTED", "EXPIRED"];

describe("legal transitions", () => {
  const legal: [OrderPhase, OrderPhase][] = [
    ["OPEN", "SUBMITTED"], // 1
    ["OPEN", "CANCELLED"], // 2
    ["SUBMITTED", "PARTIALLY_FILLED"], // 3
    ["SUBMITTED", "FILLED"], // 4
    ["SUBMITTED", "CANCELLED"], // 5
    ["PARTIALLY_FILLED", "PARTIALLY_FILLED"], // 6
    ["PARTIALLY_FILLED", "FILLED"], // 7
    ["PARTIALLY_FILLED", "CANCELLED"], // 8
  ];
  for (const [from, to] of legal) {
    test(`${from} → ${to}`, () => assert.deepEqual(checkTransition(from, to), { ok: true }));
  }

  test("FILLED is terminal (9)", () => {
    for (const to of PHASES) assert.equal(canTransition("FILLED", to), false, `FILLED → ${to}`);
  });

  test("CANCELLED is terminal (10)", () => {
    for (const to of PHASES) assert.equal(canTransition("CANCELLED", to), false, `CANCELLED → ${to}`);
  });

  test("REJECTED and EXPIRED are terminal too", () => {
    for (const from of ["REJECTED", "EXPIRED"] as const) {
      for (const to of PHASES) assert.equal(canTransition(from, to), false, `${from} → ${to}`);
    }
  });

  test("exactly the eight legal moves exist — nothing else", () => {
    const all = PHASES.flatMap((from) => PHASES.filter((to) => canTransition(from, to)).map((to) => `${from}→${to}`));
    assert.equal(all.length, legal.length);
  });
});

describe("illegal transitions fail closed", () => {
  const illegal: [OrderPhase, OrderPhase][] = [
    ["OPEN", "FILLED"], // 11
    ["OPEN", "PARTIALLY_FILLED"], // 12
    ["CANCELLED", "OPEN"], // 13
    ["FILLED", "OPEN"], // 14
    ["FILLED", "CANCELLED"], // 15
    ["CANCELLED", "FILLED"], // 16
    ["SUBMITTED", "OPEN"],
    ["PARTIALLY_FILLED", "SUBMITTED"],
    ["PARTIALLY_FILLED", "OPEN"],
    ["OPEN", "REJECTED"],
    ["SUBMITTED", "EXPIRED"],
  ];
  for (const [from, to] of illegal) {
    test(`${from} → ${to} is refused, with a reason`, () => {
      const check = checkTransition(from, to);
      assert.equal(check.ok, false);
      assert.ok(!check.ok && check.reason.includes(`${from} → ${to}`));
    });
  }
});

describe("phaseAfterFill — the phase a settled fill moves an order to", () => {
  const amount = m("0.010");

  test("SUBMITTED + partial → PARTIALLY_FILLED; + rest → FILLED", () => {
    assert.deepEqual(phaseAfterFill("SUBMITTED", m("0.003"), amount), { ok: true, phase: "PARTIALLY_FILLED" });
    assert.deepEqual(phaseAfterFill("PARTIALLY_FILLED", m("0.006"), amount), { ok: true, phase: "PARTIALLY_FILLED" });
    assert.deepEqual(phaseAfterFill("PARTIALLY_FILLED", m("0.010"), amount), { ok: true, phase: "FILLED" });
    assert.deepEqual(phaseAfterFill("SUBMITTED", m("0.010"), amount), { ok: true, phase: "FILLED" });
  });

  test("a fill on an order never sent to a venue is refused (no OPEN → FILLED / PARTIALLY_FILLED)", () => {
    assert.equal(phaseAfterFill("OPEN", m("0.003"), amount).ok, false);
    assert.equal(phaseAfterFill("OPEN", m("0.010"), amount).ok, false);
  });

  test("a fill on a terminal order is refused", () => {
    for (const phase of TERMINAL_PHASES) assert.equal(phaseAfterFill(phase, m("0.010"), amount).ok, false, phase);
  });

  test("over-fill and non-positive totals are refused", () => {
    assert.equal(phaseAfterFill("PARTIALLY_FILLED", m("0.011"), amount).ok, false);
    assert.equal(phaseAfterFill("SUBMITTED", m("0"), amount).ok, false);
    assert.equal(phaseAfterFill("SUBMITTED", m("-0.001"), amount).ok, false);
  });
});

describe("stored statuses", () => {
  test("each stored status maps to its phase; PENDING maps to nothing", () => {
    for (const s of ["OPEN", "SUBMITTED", "PARTIALLY_FILLED", "FILLED", "CANCELLED", "REJECTED", "EXPIRED"] as const) {
      assert.equal(phaseFromStatus(s), s);
    }
    assert.equal(phaseFromStatus("PENDING"), null);
  });

  test("the stored SUBMITTED status (022) is the SUBMITTED phase", () => {
    assert.equal(phaseFromStatus("SUBMITTED"), "SUBMITTED");
  });
});

const record = (over: Partial<OrderRecord> = {}): OrderRecord => ({
  orderId: "order-1",
  userId: "user-1",
  pair: "BTC-USDT",
  side: "BUY",
  type: "LIMIT",
  phase: "OPEN",
  price: m("80000"),
  amount: m("0.010"),
  filledAmount: m("0"),
  lockedAmount: m("801.60"),
  externalOrderId: null,
  ...over,
});

describe("checkOrderRecord — inconsistent persisted state is never acted on", () => {
  test("consistent records pass", () => {
    assert.ok(checkOrderRecord(record()).ok);
    assert.ok(checkOrderRecord(record({ phase: "SUBMITTED" })).ok);
    assert.ok(checkOrderRecord(record({ phase: "SUBMITTED", externalOrderId: "ext-1" })).ok);
    assert.ok(checkOrderRecord(record({ phase: "PARTIALLY_FILLED", filledAmount: m("0.003"), externalOrderId: "ext-1" })).ok);
    assert.ok(checkOrderRecord(record({ phase: "FILLED", filledAmount: m("0.010"), lockedAmount: m("0"), externalOrderId: "ext-1" })).ok);
    assert.ok(checkOrderRecord(record({ phase: "CANCELLED", lockedAmount: m("0") })).ok);
  });

  const bad: [string, Partial<OrderRecord>][] = [
    ["OPEN with fills", { filledAmount: m("0.001") }],
    ["OPEN with a venue id", { externalOrderId: "ext-1" }],
    ["SUBMITTED with fills", { phase: "SUBMITTED", filledAmount: m("0.001") }],
    ["PARTIALLY_FILLED with nothing filled", { phase: "PARTIALLY_FILLED", externalOrderId: "ext-1" }],
    ["PARTIALLY_FILLED without a venue id", { phase: "PARTIALLY_FILLED", filledAmount: m("0.003") }],
    ["FILLED short of the amount", { phase: "FILLED", filledAmount: m("0.009"), lockedAmount: m("0"), externalOrderId: "ext-1" }],
    ["FILLED still holding funds", { phase: "FILLED", filledAmount: m("0.010"), externalOrderId: "ext-1" }],
    ["CANCELLED still holding funds", { phase: "CANCELLED" }],
    ["filled beyond the amount", { phase: "PARTIALLY_FILLED", filledAmount: m("0.011"), externalOrderId: "ext-1" }],
    ["negative lock", { lockedAmount: m("-1") }],
    ["LIMIT without a price", { price: null }],
  ];
  for (const [name, over] of bad) {
    test(name, () => assert.equal(checkOrderRecord(record(over)).ok, false));
  }
});

describe("venue status classes (31)", () => {
  const cases: [ExternalOrderStatus, string][] = [
    ["ACCEPTED", "LIVE"],
    ["OPEN", "LIVE"],
    ["PARTIALLY_FILLED", "LIVE"],
    ["CANCEL_PENDING", "LIVE"],
    ["FILLED", "FILLED"],
    ["CANCELLED", "ENDED"],
    ["REJECTED", "ENDED"],
    ["EXPIRED", "ENDED"],
    ["UNKNOWN", "UNKNOWN"],
  ];
  for (const [status, cls] of cases) {
    test(`${status} → ${cls}`, () => assert.equal(classifyVenueStatus(status), cls));
  }
  test("a cancel the venue has not confirmed is still LIVE — it can fill", () => {
    assert.equal(classifyVenueStatus("CANCEL_PENDING"), "LIVE");
  });
});

describe("decideFinalization — when the remainder may be released", () => {
  const base = { phase: "PARTIALLY_FILLED" as OrderPhase, amount: m("0.010"), internalFilled: m("0.003") };

  test("venue ended and every fill settled → release the remainder", () => {
    assert.deepEqual(decideFinalization({ ...base, venueStatus: "CANCELLED", venueFilled: m("0.003") }), { kind: "RELEASE_REMAINDER" });
    assert.deepEqual(decideFinalization({ ...base, venueStatus: "EXPIRED", venueFilled: m("0.003") }), { kind: "RELEASE_REMAINDER" });
  });

  test("venue executed more than is settled → settle first, release nothing", () => {
    assert.deepEqual(decideFinalization({ ...base, venueStatus: "CANCELLED", venueFilled: m("0.006") }), {
      kind: "SETTLE_MISSING_FILLS",
    });
  });

  test("a cancel accepted but not confirmed → release nothing", () => {
    assert.deepEqual(decideFinalization({ ...base, venueStatus: "CANCEL_PENDING", venueFilled: m("0.003") }), { kind: "NOT_ENDED" });
    assert.deepEqual(decideFinalization({ ...base, venueStatus: "OPEN", venueFilled: m("0.003") }), { kind: "NOT_ENDED" });
  });

  test("unknown venue status → release nothing", () => {
    assert.deepEqual(decideFinalization({ ...base, venueStatus: "UNKNOWN", venueFilled: m("0.003") }), { kind: "UNRESOLVED" });
  });

  test("more settled than the venue executed → incident", () => {
    assert.equal(decideFinalization({ ...base, venueStatus: "CANCELLED", venueFilled: m("0.001") }).kind, "INCIDENT");
  });

  test("venue FILLED for less than the order → incident", () => {
    assert.equal(decideFinalization({ ...base, venueStatus: "FILLED", venueFilled: m("0.003") }).kind, "INCIDENT");
  });

  test("terminal internal order → nothing to decide", () => {
    assert.deepEqual(
      decideFinalization({ ...base, phase: "CANCELLED", venueStatus: "CANCELLED", venueFilled: m("0.003") }),
      { kind: "ALREADY_TERMINAL" },
    );
  });

  test("an order never sent to a venue has no venue state to finalize on", () => {
    assert.equal(decideFinalization({ ...base, phase: "OPEN", internalFilled: m("0"), venueStatus: "CANCELLED", venueFilled: m("0") }).kind, "INCIDENT");
  });
});

describe("venue idempotency reference", () => {
  test("deterministic and derived from the internal order id, not the customer's form key", () => {
    assert.equal(venueClientOrderIdFor("3f0c…-order"), venueClientOrderIdFor("3f0c…-order"));
    assert.notEqual(venueClientOrderIdFor("order-a"), venueClientOrderIdFor("order-b"));
  });
});

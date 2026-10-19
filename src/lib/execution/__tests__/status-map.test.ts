import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { normalizeProviderStatus, providerStatusTable } from "../status-map.ts";
import type { ExternalOrderStatus } from "../types.ts";

/**
 * Provider status mapping (Slice 14A). The table below is a NEUTRAL FIXTURE —
 * invented raw strings, not any real venue's vocabulary (no LP documentation is
 * available). What is under test is the mechanism: listed statuses map exactly,
 * anything else is UNKNOWN. Pure; run with `node --test`.
 */

const FIXTURE = providerStatusTable({
  venue_new: "ACCEPTED",
  venue_resting: "OPEN",
  venue_partial: "PARTIALLY_FILLED",
  venue_done: "FILLED",
  venue_cancelling: "CANCEL_PENDING",
  venue_cancelled: "CANCELLED",
  venue_refused: "REJECTED",
  venue_lapsed: "EXPIRED",
});

describe("known statuses map exactly (31)", () => {
  const cases: [string, ExternalOrderStatus][] = [
    ["venue_new", "ACCEPTED"],
    ["venue_resting", "OPEN"],
    ["venue_partial", "PARTIALLY_FILLED"],
    ["venue_done", "FILLED"],
    ["venue_cancelling", "CANCEL_PENDING"],
    ["venue_cancelled", "CANCELLED"],
    ["venue_refused", "REJECTED"],
    ["venue_lapsed", "EXPIRED"],
  ];
  for (const [raw, status] of cases) {
    test(`${raw} → ${status}`, () => assert.equal(normalizeProviderStatus(FIXTURE, raw), status));
  }
});

describe("anything unlisted is UNKNOWN — never FILLED, never CANCELLED (32)", () => {
  const unknown: unknown[] = [
    "venue_settled", // a status the venue added later
    "VENUE_DONE", // case differs: lookups are exact
    " venue_done",
    "",
    "__proto__",
    "constructor",
    "toString",
    null,
    undefined,
    42,
    { status: "venue_done" },
  ];
  for (const raw of unknown) {
    test(`${typeof raw === "string" ? JSON.stringify(raw) : String(raw)} → UNKNOWN`, () => {
      const status = normalizeProviderStatus(FIXTURE, raw);
      assert.equal(status, "UNKNOWN");
      assert.notEqual(status, "FILLED");
      assert.notEqual(status, "CANCELLED");
    });
  }
});

describe("a table is checked when the adapter builds it", () => {
  test("an entry that maps to a non-neutral status is refused", () => {
    assert.throws(() => providerStatusTable({ venue_done: "SETTLED" as ExternalOrderStatus }), /not a neutral status/);
  });
  test("a blank raw status is refused", () => {
    assert.throws(() => providerStatusTable({ " ": "OPEN" }), /blank/);
  });
  test("an empty table maps everything to UNKNOWN", () => {
    assert.equal(normalizeProviderStatus(providerStatusTable({}), "venue_done"), "UNKNOWN");
  });
});

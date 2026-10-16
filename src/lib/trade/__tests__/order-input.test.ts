import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { formatMoney } from "../../money.ts";
import { parseOrderAmounts } from "../order-input.ts";

/**
 * Trust-boundary input parsing (spec §19, §20). Pure — no database, no session.
 * Run with `node --test`. The money import is relative because node --test runs
 * this file directly and does not resolve `@/`.
 */

describe("parseOrderAmounts", () => {
  test("a valid LIMIT order parses price and amount to exact Money", () => {
    const r = parseOrderAmounts({ type: "LIMIT", priceInput: "60000", amountInput: "0.5" });
    assert.ok(r.ok);
    assert.equal(r.price !== null && formatMoney(r.price), "60000");
    assert.equal(formatMoney(r.amount), "0.5");
  });

  test("a MARKET order carries no price", () => {
    const r = parseOrderAmounts({ type: "MARKET", priceInput: "", amountInput: "0.5" });
    assert.ok(r.ok);
    assert.equal(r.price, null);
  });

  test("an empty amount is rejected with a message, never a zero", () => {
    const r = parseOrderAmounts({ type: "LIMIT", priceInput: "60000", amountInput: "" });
    assert.ok(!r.ok);
    assert.match(r.message, /amount/i);
  });

  test("a non-numeric amount is rejected", () => {
    const r = parseOrderAmounts({ type: "LIMIT", priceInput: "60000", amountInput: "1.2.3" });
    assert.ok(!r.ok);
  });

  test("a negative amount is rejected (there is no sign to type)", () => {
    const r = parseOrderAmounts({ type: "LIMIT", priceInput: "60000", amountInput: "-1" });
    assert.ok(!r.ok);
  });

  test("a zero amount is rejected", () => {
    const r = parseOrderAmounts({ type: "LIMIT", priceInput: "60000", amountInput: "0" });
    assert.ok(!r.ok);
    assert.match(r.message, /greater than zero/);
  });

  test("a locale comma is refused rather than guessed", () => {
    const r = parseOrderAmounts({ type: "LIMIT", priceInput: "60000", amountInput: "0,5" });
    assert.ok(!r.ok);
  });

  test("a LIMIT order with a missing price is rejected", () => {
    const r = parseOrderAmounts({ type: "LIMIT", priceInput: "", amountInput: "0.5" });
    assert.ok(!r.ok);
    assert.match(r.message, /price/i);
  });

  test("a LIMIT order with a non-positive price is rejected", () => {
    const r = parseOrderAmounts({ type: "LIMIT", priceInput: "0", amountInput: "0.5" });
    assert.ok(!r.ok);
    assert.match(r.message, /price/i);
  });

  test("an exponent is refused (not a plain decimal)", () => {
    const r = parseOrderAmounts({ type: "LIMIT", priceInput: "6e4", amountInput: "0.5" });
    assert.ok(!r.ok);
  });
});

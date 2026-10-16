import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  orderNotional,
  reserveForOrder,
  validateOrderIntent,
  type OrderIntent,
  type PairSpec,
  type ValidatedOrder,
} from "../order-rules.ts";
import { formatMoney, parseMoney, type Money } from "../../money.ts";

/**
 * Order-placement decision tests (spec §19). Pure: no database, no provider.
 * Run with `node --test`.
 */

const m = (v: string): Money => parseMoney(v);

// BTC-USDT shape from the seed: price_precision 2, amount_precision 8,
// min_order_size 0.0001.
const pair = (over: Partial<PairSpec> = {}): PairSpec => ({
  symbol: "BTC-USDT",
  baseAsset: "BTC",
  quoteAsset: "USDT",
  tradingEnabled: true,
  pricePrecision: 2,
  amountPrecision: 8,
  minOrderSize: m("0.0001"),
  maxOrderSize: null,
  ...over,
});

const intent = (over: Partial<OrderIntent> = {}): OrderIntent => ({
  side: "BUY",
  type: "LIMIT",
  amount: m("0.5"),
  price: m("60000"),
  ...over,
});

const validated = (over: Partial<ValidatedOrder> = {}): ValidatedOrder => ({
  side: "BUY",
  type: "LIMIT",
  amount: m("0.5"),
  price: m("60000"),
  ...over,
});

describe("validateOrderIntent", () => {
  test("a well-formed LIMIT order passes", () => {
    const r = validateOrderIntent(intent(), pair());
    assert.equal(r.ok, true);
    assert.ok(r.ok && r.order.type === "LIMIT");
  });

  test("trading disabled is refused", () => {
    const r = validateOrderIntent(intent(), pair({ tradingEnabled: false }));
    assert.deepEqual(r, { ok: false, problem: "TRADING_DISABLED" });
  });

  test("MARKET is refused: no feed, no execution venue", () => {
    const r = validateOrderIntent(intent({ type: "MARKET", price: null }), pair());
    assert.deepEqual(r, { ok: false, problem: "MARKET_UNSUPPORTED" });
  });

  test("LIMIT without a price is refused", () => {
    const r = validateOrderIntent(intent({ price: null }), pair());
    assert.deepEqual(r, { ok: false, problem: "PRICE_REQUIRED" });
  });

  test("a non-positive price is refused", () => {
    const r = validateOrderIntent(intent({ price: m("0") }), pair());
    assert.deepEqual(r, { ok: false, problem: "PRICE_NOT_POSITIVE" });
  });

  test("a price finer than price_precision is refused", () => {
    const r = validateOrderIntent(intent({ price: m("60000.001") }), pair()); // 3 dp > 2
    assert.deepEqual(r, { ok: false, problem: "PRICE_PRECISION" });
  });

  test("an amount finer than amount_precision is refused", () => {
    const r = validateOrderIntent(intent({ amount: m("0.000000001") }), pair()); // 9 dp > 8
    assert.deepEqual(r, { ok: false, problem: "AMOUNT_PRECISION" });
  });

  test("a non-positive amount is refused", () => {
    const r = validateOrderIntent(intent({ amount: m("0") }), pair());
    assert.deepEqual(r, { ok: false, problem: "AMOUNT_NOT_POSITIVE" });
  });

  test("below the pair minimum is refused", () => {
    const r = validateOrderIntent(intent({ amount: m("0.00005") }), pair());
    assert.deepEqual(r, { ok: false, problem: "BELOW_MIN" });
  });

  test("at exactly the minimum passes", () => {
    const r = validateOrderIntent(intent({ amount: m("0.0001") }), pair());
    assert.equal(r.ok, true);
  });

  test("above the pair maximum is refused", () => {
    const r = validateOrderIntent(intent({ amount: m("11") }), pair({ maxOrderSize: m("10") }));
    assert.deepEqual(r, { ok: false, problem: "ABOVE_MAX" });
  });

  test("a SELL order validates the same way", () => {
    const r = validateOrderIntent(intent({ side: "SELL" }), pair());
    assert.ok(r.ok && r.order.side === "SELL");
  });
});

describe("orderNotional", () => {
  test("price × amount in the quote asset", () => {
    assert.equal(formatMoney(orderNotional(validated())), "30000"); // 60000 × 0.5
  });
});

describe("reserveForOrder", () => {
  test("BUY locks QUOTE = notional + fee", () => {
    const r = reserveForOrder(validated({ side: "BUY" }), m("60")); // fee 60 USDT
    assert.equal(r.lockAsset, "QUOTE");
    assert.equal(formatMoney(r.lockAmount), "30060");
    assert.equal(formatMoney(r.notional), "30000");
  });

  test("SELL locks BASE = amount; fee comes from proceeds, not reserved now", () => {
    const r = reserveForOrder(validated({ side: "SELL" }), m("60"));
    assert.equal(r.lockAsset, "BASE");
    assert.equal(formatMoney(r.lockAmount), "0.5");
    assert.equal(formatMoney(r.notional), "30000");
  });

  test("BUY with a zero fee locks exactly the notional", () => {
    const r = reserveForOrder(validated({ side: "BUY" }), m("0"));
    assert.equal(formatMoney(r.lockAmount), "30000");
  });
});

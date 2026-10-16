import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { formatMoney, parseMoney } from "../../money.ts";
import { allocationPercent, usdPriceOf, valueInUsd } from "../valuation.ts";

/**
 * Pure valuation tests (Slice 7.3). No database, no provider — just the price
 * resolution and the exact money math. Run with `node --test`; money is
 * imported relatively because node --test does not resolve `@/`.
 */

const prices = new Map<string, string>([
  ["BTC-USDT", "62000"],
  ["ETH-USDT", "3000"],
  ["USD-BRL", "5.4"],
  ["EUR-USD", "1.085"],
  ["USDC-USDT", "1.0001"],
]);

describe("usdPriceOf", () => {
  test("USD and the dollar-stablecoins anchor at ~1", () => {
    assert.equal(formatMoney(usdPriceOf("USD", prices)!), "1");
    assert.equal(formatMoney(usdPriceOf("USDT", prices)!), "1");
    assert.equal(formatMoney(usdPriceOf("USDC", prices)!), "1.0001");
  });

  test("a crypto priced in USDT resolves to that USDT price", () => {
    assert.equal(formatMoney(usdPriceOf("BTC", prices)!), "62000");
    assert.equal(formatMoney(usdPriceOf("ETH", prices)!), "3000");
  });

  test("a currency that is the quote of a USD pair is inverted", () => {
    // 1 BRL = 1/5.4 USD ≈ 0.185185…
    assert.equal(formatMoney(usdPriceOf("BRL", prices)!, { decimals: 6 }), "0.185185");
  });

  test("a currency priced as base against USD is taken directly", () => {
    assert.equal(formatMoney(usdPriceOf("EUR", prices)!), "1.085");
  });

  test("an asset with no path to USD is null", () => {
    assert.equal(usdPriceOf("DOGE", prices), null);
  });
});

describe("valueInUsd and allocationPercent", () => {
  test("values an amount at a price, exactly", () => {
    assert.equal(formatMoney(valueInUsd(parseMoney("0.5"), usdPriceOf("BTC", prices))!), "31000");
  });

  test("an unpriced holding has a null value", () => {
    assert.equal(valueInUsd(parseMoney("100"), null), null);
  });

  test("allocation is the share of the total, as a percentage", () => {
    assert.equal(allocationPercent(parseMoney("25"), parseMoney("100")), "25");
    assert.equal(allocationPercent(parseMoney("1"), parseMoney("3"))!.startsWith("33.33"), true);
  });

  test("allocation of a zero total is null, not a division by zero", () => {
    assert.equal(allocationPercent(parseMoney("5"), parseMoney("0")), null);
  });
});

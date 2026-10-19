import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { DEFAULT_MARKET_DATA_PROVIDER, MARKET_DATA_PROVIDER_NAMES, resolveMarketDataProvider } from "../selection.ts";

/**
 * Provider selection (Slice 13A). The rule that matters: the demo source is used
 * only when someone chose it — by name, or with the brand's explicit
 * `demoMarketData` opt-in — and nothing ever falls back to it.
 */

describe("explicit choice wins", () => {
  for (const name of MARKET_DATA_PROVIDER_NAMES) {
    test(`JIMOCEX_MARKET_DATA_PROVIDER=${name}`, () => {
      assert.deepEqual(resolveMarketDataProvider(name, false), { name, unknown: null });
      assert.deepEqual(resolveMarketDataProvider(name, true), { name, unknown: null });
    });
  }
});

describe("when nothing is named", () => {
  test("the public market data is the default", () => {
    assert.equal(DEFAULT_MARKET_DATA_PROVIDER, "binance");
    assert.deepEqual(resolveMarketDataProvider(undefined, false), { name: "binance", unknown: null });
  });

  test("the demo source needs the brand's explicit opt-in", () => {
    assert.deepEqual(resolveMarketDataProvider(undefined, true), { name: "prototype", unknown: null });
  });
});

describe("no silent fallback", () => {
  for (const typo of ["Binance", "BINANCE", "real", "live", "prototype ", "demo", "", "binance-public"]) {
    test(`an unknown name ${JSON.stringify(typo)} is "unavailable", never a working-looking provider`, () => {
      for (const demo of [false, true]) {
        assert.deepEqual(resolveMarketDataProvider(typo, demo), { name: "unavailable", unknown: typo });
      }
    });
  }

  test("only an explicit choice of the demo source, or the brand opt-in, yields it", () => {
    const inputs: [string | undefined, boolean][] = [];
    for (const name of [undefined, ...MARKET_DATA_PROVIDER_NAMES, "x"]) for (const demo of [false, true]) inputs.push([name, demo]);
    for (const [name, demo] of inputs) {
      const picked = resolveMarketDataProvider(name, demo).name;
      const chosen = name === "prototype" || (name === undefined && demo);
      assert.equal(picked === "prototype", chosen, `${String(name)} / demo=${demo}`);
    }
  });
});

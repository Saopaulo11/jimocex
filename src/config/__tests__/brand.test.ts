import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { brand, brandName, product, wordmarkText } from "../brand.ts";

/**
 * Brand/product configuration tests (Slice 4). Pure — the config module has no
 * I/O and no imports. Run with `node --test`. These guard three things: the
 * default (JimoCex) config is well-formed, the shape a white-label client must
 * fill stays valid, and — most importantly — nothing secret is in a module that
 * ships to the browser.
 */

describe("default brand configuration", () => {
  test("loads with the expected JimoCex identity", () => {
    assert.equal(brand.name, "JimoCex");
    assert.equal(brandName(), "JimoCex");
    assert.equal(brand.companyName, "JimoCex");
    assert.ok(brand.tagline.length > 0);
    assert.ok(brand.description.length > 0);
  });

  test("the wordmark renders the brand name, split or plain", () => {
    assert.equal(wordmarkText(), "JimoCex"); // the default split
    assert.equal(wordmarkText({ primary: "Jimo", accent: "Cex" }), "JimoCex");
    assert.equal(wordmarkText("Acme Exchange"), "Acme Exchange");
  });

  test("required brand string fields are present and non-empty", () => {
    for (const field of ["name", "tagline", "description", "companyName", "supportEmail", "supportUrl", "favicon"] as const) {
      assert.equal(typeof brand[field], "string", `${field} must be a string`);
      assert.ok((brand[field] as string).length > 0, `${field} must not be empty`);
    }
    for (const key of ["full", "mark", "monochromeMark"] as const) {
      assert.ok(brand.logo[key].length > 0, `logo.${key} must not be empty`);
    }
  });

  test("theme colours are valid hex and the scheme is dark or light", () => {
    assert.match(brand.theme.accentColor, /^#[0-9a-fA-F]{6}$/);
    assert.match(brand.theme.backgroundColor, /^#[0-9a-fA-F]{6}$/);
    assert.ok(brand.theme.colorScheme === "dark" || brand.theme.colorScheme === "light");
  });

  test("legal and social links are well-formed", () => {
    for (const link of [...brand.legalLinks, ...brand.socialLinks]) {
      assert.ok(link.label.length > 0);
      assert.ok(link.href.length > 0);
    }
  });
});

describe("default product configuration", () => {
  test("flags are booleans and enabledMarkets is 'all' or a symbol list", () => {
    assert.equal(typeof product.enabledTrading, "boolean");
    assert.equal(typeof product.enabledLimitOrders, "boolean");
    assert.equal(typeof product.enabledMarketOrders, "boolean");
    assert.equal(typeof product.enabledExchange, "boolean");
    assert.equal(typeof product.demoMarketData, "boolean");
    assert.ok(product.enabledMarkets === "all" || Array.isArray(product.enabledMarkets));
  });

  test("market orders are off by default — no execution venue is connected", () => {
    assert.equal(product.enabledMarketOrders, false);
  });
});

describe("the client-shipped config carries nothing privileged", () => {
  // This module is imported into the browser bundle. Prove, structurally, that
  // no secret or financial control can hide in it: no suspicious KEY, and no
  // VALUE that looks like a credential or a service-role reference.
  const serialized = JSON.stringify({ brand, product });

  test("no secret/credential/financial-control keys", () => {
    const forbiddenKey = /(secret|password|credential|service[_-]?role|api[_-]?key|private[_-]?key|\bfee\b|\blimit\b|\btier\b)/i;
    const keys = new Set<string>();
    const walk = (value: unknown): void => {
      if (value && typeof value === "object") {
        for (const [k, v] of Object.entries(value)) {
          keys.add(k);
          walk(v);
        }
      }
    };
    walk({ brand, product });
    for (const key of keys) {
      assert.doesNotMatch(key, forbiddenKey, `config key "${key}" looks privileged and must not live in client config`);
    }
  });

  test("no value looks like a secret or a service-role token", () => {
    assert.doesNotMatch(serialized, /service_role/i);
    assert.doesNotMatch(serialized, /sk_[a-z0-9]/i);
    assert.doesNotMatch(serialized, /SUPABASE_SERVICE_ROLE|ANON_KEY|BEGIN (RSA|PRIVATE) KEY/i);
    // A JWT-shaped triple (header.payload.signature) would be a leaked token.
    assert.doesNotMatch(serialized, /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/);
  });
});

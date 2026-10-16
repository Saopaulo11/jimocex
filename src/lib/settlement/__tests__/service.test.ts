import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { formatMoney, parseMoney, toDecimalString, type DecimalString } from "../../money.ts";
import type { ExecutionFill, OrderSide } from "../../execution/types.ts";
import { SettlementService } from "../service.ts";
import type { ApplyFillInput, SettlementGateway } from "../types.ts";

/**
 * SettlementService tests (Slice 6C). The gateway is a DETERMINISTIC TEST DOUBLE
 * — never a production provider, never a real Supabase client. It returns only
 * what each test configures, so these exercise the service's resolution,
 * idempotency, mapping and error classification with no database. Run with
 * `node --test`.
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

type Cfg = {
  order?: { orderId: string; side: OrderSide } | null;
  assetId?: string | null;
  existingTrade?: string | null;
  applyResult?: { ok: true; tradeId: string } | { ok: false; code?: string | null; message?: string | null };
  applyThrows?: boolean;
};

/** Deterministic test double for the settlement gateway. */
class FakeGateway implements SettlementGateway {
  readonly applyInputs: ApplyFillInput[] = [];
  readonly resolvedAssets: string[] = [];
  private readonly cfg: Cfg;

  constructor(cfg: Cfg = {}) {
    this.cfg = cfg;
  }

  async resolveOrderByExternalId(): Promise<{ orderId: string; side: OrderSide } | null> {
    return this.cfg.order === undefined ? { orderId: "order-1", side: "BUY" } : this.cfg.order;
  }

  async resolveAssetId(symbol: string): Promise<string | null> {
    this.resolvedAssets.push(symbol);
    return this.cfg.assetId === undefined ? "asset-usdt" : this.cfg.assetId;
  }

  async findTradeByProviderTradeId(): Promise<string | null> {
    return this.cfg.existingTrade ?? null;
  }

  async applyFill(
    input: ApplyFillInput,
  ): Promise<{ ok: true; tradeId: string } | { ok: false; code?: string | null; message?: string | null }> {
    this.applyInputs.push(input);
    if (this.cfg.applyThrows) throw new Error("transport boom");
    return this.cfg.applyResult ?? { ok: true, tradeId: "trade-1" };
  }
}

describe("settleFill — success and idempotency", () => {
  test("a valid fill settles and returns the trade id", async () => {
    const gw = new FakeGateway();
    const result = await new SettlementService(gw).settleFill(fill());
    assert.equal(result.code, "SUCCESS");
    assert.ok(result.code === "SUCCESS" && result.tradeId === "trade-1");
  });

  test("the order id passed to apply_fill comes from the gateway, not the fill", async () => {
    const gw = new FakeGateway({ order: { orderId: "server-resolved-order", side: "BUY" } });
    await new SettlementService(gw).settleFill(fill({ externalOrderId: "ext-whatever" }));
    assert.equal(gw.applyInputs.length, 1);
    assert.equal(gw.applyInputs[0]?.orderId, "server-resolved-order");
  });

  test("a fill already settled returns DUPLICATE and calls apply_fill zero times", async () => {
    const gw = new FakeGateway({ existingTrade: "trade-existing" });
    const result = await new SettlementService(gw).settleFill(fill());
    assert.ok(result.code === "DUPLICATE" && result.tradeId === "trade-existing");
    assert.equal(gw.applyInputs.length, 0);
  });

  test("a zero-fee fill resolves no asset and passes a null fee asset", async () => {
    const gw = new FakeGateway();
    await new SettlementService(gw).settleFill(fill({ fee: d("0") }));
    assert.equal(gw.resolvedAssets.length, 0);
    assert.equal(gw.applyInputs[0]?.feeAssetId, null);
    assert.equal(formatMoney(gw.applyInputs[0]!.quoteAmount), "6000");
  });
});

describe("settleFill — resolution and validation failures", () => {
  test("an unmapped external order id is ORDER_NOT_FOUND (cannot settle an arbitrary order)", async () => {
    const gw = new FakeGateway({ order: null });
    const result = await new SettlementService(gw).settleFill(fill());
    assert.ok(result.code === "ORDER_NOT_FOUND" && result.reconcile === true);
    assert.equal(gw.applyInputs.length, 0);
  });

  test("a fill whose side disagrees with the order is INVALID_FILL (provider inconsistency)", async () => {
    const gw = new FakeGateway({ order: { orderId: "order-1", side: "SELL" } });
    const result = await new SettlementService(gw).settleFill(fill({ side: "BUY" }));
    assert.ok(result.code === "INVALID_FILL" && result.reconcile === true);
    assert.equal(gw.applyInputs.length, 0);
  });

  test("an unknown fee asset is INVALID_FEE", async () => {
    const gw = new FakeGateway({ assetId: null });
    const result = await new SettlementService(gw).settleFill(fill({ fee: d("12"), feeAsset: "WAT" }));
    assert.ok(result.code === "INVALID_FEE");
    assert.equal(gw.applyInputs.length, 0);
  });
});

describe("settleFill — apply_fill error classification", () => {
  const sqlCase = async (code: string, message: string) => {
    const gw = new FakeGateway({ applyResult: { ok: false, code, message } });
    return new SettlementService(gw).settleFill(fill());
  };

  test("over-fill → OVER_FILL", async () => {
    const r = await sqlCase("23514", "apply_fill: fill of 0.5 exceeds order X remaining");
    assert.equal(r.code, "OVER_FILL");
  });

  test("terminal order → ORDER_NOT_SETTLEABLE (internal FILLED + new fill)", async () => {
    const r = await sqlCase("23001", "order X is FILLED and cannot take a new fill");
    assert.equal(r.code, "ORDER_NOT_SETTLEABLE");
  });

  test("insufficient reservation → INSUFFICIENT_RESERVATION", async () => {
    const r = await sqlCase("23514", "apply_fill: BUY fill consumes 5 quote but only 4 is reserved");
    assert.equal(r.code, "INSUFFICIENT_RESERVATION");
  });

  test("fee not in quote asset → INVALID_FEE", async () => {
    const r = await sqlCase("23514", "apply_fill: the fee must be denominated in the pair quote asset Y");
    assert.equal(r.code, "INVALID_FEE");
  });

  test("transient serialization failure → DATABASE_ERROR (retryable)", async () => {
    const r = await sqlCase("40001", "could not serialize access due to concurrent update");
    assert.ok(r.code === "DATABASE_ERROR" && r.retryable === true);
  });

  test("the raw SQL message is never surfaced", async () => {
    const r = await sqlCase("23514", "apply_fill: base amount must be a positive number, got -1 /*secret*/");
    assert.ok(r.code === "INVALID_FILL" && "message" in r);
    assert.doesNotMatch((r as { message: string }).message, /secret|apply_fill|-1/);
  });

  test("a gateway that throws (transport failure) → DATABASE_ERROR (retryable)", async () => {
    const gw = new FakeGateway({ applyThrows: true });
    const r = await new SettlementService(gw).settleFill(fill());
    assert.ok(r.code === "DATABASE_ERROR" && r.retryable === true);
  });
});

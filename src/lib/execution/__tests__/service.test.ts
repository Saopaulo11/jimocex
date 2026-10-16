import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { toDecimalString, parseMoney, type DecimalString } from "../../money.ts";
import { ExecutionService } from "../service.ts";
import {
  ExecutionError,
  type ExecutionCancelAck,
  type ExecutionFill,
  type ExecutionOrderAck,
  type ExecutionOrderRequest,
  type ExecutionOrderView,
  type ExecutionProvider,
  type ExternalOrderRef,
} from "../types.ts";

/**
 * Execution Service tests (Slice 5). Pure: the provider is a DETERMINISTIC TEST
 * DOUBLE (`StubExecutionProvider`) — explicitly a test fixture, never a
 * production provider and never a simulated venue. It only returns what each
 * test tells it to, so these exercise the service's timeout, classification,
 * idempotency and dedupe behaviour with no network. Run with `node --test`.
 */

const d = (s: string): DecimalString => toDecimalString(parseMoney(s));

const request = (over: Partial<ExecutionOrderRequest> = {}): ExecutionOrderRequest => ({
  clientOrderId: "cid-1",
  pair: "BTC-USDT",
  side: "BUY",
  type: "LIMIT",
  price: d("60000"),
  amount: d("0.1"),
  ...over,
});

type Handlers = {
  placeOrder?: (req: ExecutionOrderRequest) => Promise<ExecutionOrderAck>;
  cancelOrder?: (ref: ExternalOrderRef) => Promise<ExecutionCancelAck>;
  getOrder?: (ref: ExternalOrderRef) => Promise<ExecutionOrderView>;
  getOpenOrders?: () => Promise<ExecutionOrderView[]>;
  getFills?: (ref: ExternalOrderRef) => Promise<ExecutionFill[]>;
};

/** Named deterministic test double. Not a production provider. */
class StubExecutionProvider implements ExecutionProvider {
  readonly name = "stub";
  readonly calls = {
    placeOrder: [] as ExecutionOrderRequest[],
    cancelOrder: [] as ExternalOrderRef[],
    getOrder: [] as ExternalOrderRef[],
    getFills: [] as ExternalOrderRef[],
  };

  private readonly handlers: Handlers;

  constructor(handlers: Handlers = {}) {
    this.handlers = handlers;
  }

  isConfigured(): boolean {
    return true;
  }

  async placeOrder(req: ExecutionOrderRequest): Promise<ExecutionOrderAck> {
    this.calls.placeOrder.push(req);
    if (!this.handlers.placeOrder) throw new ExecutionError("PROVIDER_ERROR", "no placeOrder handler");
    return this.handlers.placeOrder(req);
  }

  async cancelOrder(ref: ExternalOrderRef): Promise<ExecutionCancelAck> {
    this.calls.cancelOrder.push(ref);
    if (!this.handlers.cancelOrder) throw new ExecutionError("PROVIDER_ERROR", "no cancelOrder handler");
    return this.handlers.cancelOrder(ref);
  }

  async getOrder(ref: ExternalOrderRef): Promise<ExecutionOrderView> {
    this.calls.getOrder.push(ref);
    if (!this.handlers.getOrder) throw new ExecutionError("PROVIDER_ERROR", "no getOrder handler");
    return this.handlers.getOrder(ref);
  }

  async getOpenOrders(): Promise<ExecutionOrderView[]> {
    if (!this.handlers.getOpenOrders) throw new ExecutionError("PROVIDER_ERROR", "no getOpenOrders handler");
    return this.handlers.getOpenOrders();
  }

  async getFills(ref: ExternalOrderRef): Promise<ExecutionFill[]> {
    this.calls.getFills.push(ref);
    if (!this.handlers.getFills) throw new ExecutionError("PROVIDER_ERROR", "no getFills handler");
    return this.handlers.getFills(ref);
  }
}

const ack = (over: Partial<ExecutionOrderAck> = {}): ExecutionOrderAck => ({
  externalOrderId: "ext-1",
  clientOrderId: "cid-1",
  status: "ACCEPTED",
  acceptedAt: new Date("2026-01-01T00:00:00Z"),
  ...over,
});

const view = (over: Partial<ExecutionOrderView> = {}): ExecutionOrderView => ({
  externalOrderId: "ext-1",
  clientOrderId: "cid-1",
  status: "OPEN",
  filledAmount: d("0"),
  remainingAmount: d("0.1"),
  avgFillPrice: null,
  ...over,
});

describe("submitOrder", () => {
  test("provider success returns the external order id", async () => {
    const provider = new StubExecutionProvider({ placeOrder: async () => ack({ externalOrderId: "ext-42" }) });
    const svc = new ExecutionService(provider);
    const result = await svc.submitOrder(request());
    assert.ok(result.ok);
    assert.equal(result.value.externalOrderId, "ext-42"); // caller persists this to provider_order_id
    assert.equal(result.value.status, "ACCEPTED");
  });

  test("the internal clientOrderId is always passed to the venue", async () => {
    const provider = new StubExecutionProvider({ placeOrder: async () => ack() });
    const svc = new ExecutionService(provider);
    await svc.submitOrder(request({ clientOrderId: "cid-abc" }));
    assert.equal(provider.calls.placeOrder.length, 1);
    assert.equal(provider.calls.placeOrder[0]?.clientOrderId, "cid-abc");
  });

  test("provider rejection is classified as REJECTED, not surfaced raw", async () => {
    const provider = new StubExecutionProvider({
      placeOrder: async () => {
        throw new ExecutionError("REJECTED", "venue rejected: price outside band");
      },
    });
    const svc = new ExecutionService(provider);
    const result = await svc.submitOrder(request());
    assert.ok(!result.ok);
    assert.equal(result.error.kind, "REJECTED");
    assert.equal(result.error.retryable, false);
  });

  test("a hung venue times out, classified and flagged ambiguous (reconcile, do not resubmit)", async () => {
    const provider = new StubExecutionProvider({ placeOrder: () => new Promise<ExecutionOrderAck>(() => {}) });
    const svc = new ExecutionService(provider, { defaultTimeoutMs: 20 });
    const result = await svc.submitOrder(request());
    assert.ok(!result.ok);
    assert.equal(result.error.kind, "TIMEOUT");
    assert.equal(result.error.ambiguous, true);
  });

  test("a duplicate submit with the same clientOrderId yields the same external order (venue idempotency)", async () => {
    // Model a venue that is idempotent on clientOrderId: same key → same order.
    const byKey = new Map<string, string>();
    let n = 0;
    const provider = new StubExecutionProvider({
      placeOrder: async (req) => {
        const existing = byKey.get(req.clientOrderId);
        if (existing) return ack({ externalOrderId: existing, status: "OPEN" });
        const id = `ext-${++n}`;
        byKey.set(req.clientOrderId, id);
        return ack({ externalOrderId: id });
      },
    });
    const svc = new ExecutionService(provider);
    const first = await svc.submitOrder(request({ clientOrderId: "cid-dup" }));
    const second = await svc.submitOrder(request({ clientOrderId: "cid-dup" }));
    assert.ok(first.ok && second.ok);
    assert.equal(first.value.externalOrderId, second.value.externalOrderId); // one order, not two
  });

  test("a raw (non-ExecutionError) provider failure maps to PROVIDER_ERROR with no leaked detail", async () => {
    const provider = new StubExecutionProvider({
      placeOrder: async () => {
        throw new Error("connect ECONNREFUSED https://venue.internal/api?key=SECRET123");
      },
    });
    const svc = new ExecutionService(provider);
    const result = await svc.submitOrder(request());
    assert.ok(!result.ok);
    assert.equal(result.error.kind, "PROVIDER_ERROR");
    assert.equal(result.error.message, "the execution provider returned an unexpected error");
    assert.doesNotMatch(result.error.message, /venue\.internal|SECRET123|ECONNREFUSED/);
  });

  test("an unconfigured venue surfaces UNAVAILABLE", async () => {
    const provider = new StubExecutionProvider({
      placeOrder: async () => {
        throw new ExecutionError("UNAVAILABLE", "no execution provider is configured");
      },
    });
    const svc = new ExecutionService(provider);
    const result = await svc.submitOrder(request());
    assert.ok(!result.ok && result.error.kind === "UNAVAILABLE");
  });
});

describe("getOrder — provider truth for reconciliation", () => {
  test("reports a partial fill", async () => {
    const provider = new StubExecutionProvider({
      getOrder: async () => view({ status: "PARTIALLY_FILLED", filledAmount: d("0.04"), remainingAmount: d("0.06"), avgFillPrice: d("60000") }),
    });
    const svc = new ExecutionService(provider);
    const result = await svc.getOrder({ externalOrderId: "ext-1" });
    assert.ok(result.ok);
    assert.equal(result.value.status, "PARTIALLY_FILLED");
    assert.equal(result.value.filledAmount, "0.04");
  });

  test("reports a full fill", async () => {
    const provider = new StubExecutionProvider({
      getOrder: async () => view({ status: "FILLED", filledAmount: d("0.1"), remainingAmount: d("0"), avgFillPrice: d("60000") }),
    });
    const svc = new ExecutionService(provider);
    const result = await svc.getOrder({ externalOrderId: "ext-1" });
    assert.ok(result.ok && result.value.status === "FILLED");
  });

  test("reconcileByClientOrderId queries the venue by the internal key", async () => {
    const provider = new StubExecutionProvider({ getOrder: async () => view() });
    const svc = new ExecutionService(provider);
    await svc.reconcileByClientOrderId("cid-xyz");
    assert.equal(provider.calls.getOrder[0]?.clientOrderId, "cid-xyz");
  });
});

describe("cancel/fill race — the service returns venue truth, it never guesses", () => {
  test("a cancel can land while a partial fill exists; reconcile yields the venue's final view", async () => {
    // Venue: the order partially filled, then the remainder was cancelled.
    const provider = new StubExecutionProvider({
      cancelOrder: async (): Promise<ExecutionCancelAck> => ({ externalOrderId: "ext-1", status: "CANCELLED" }),
      getOrder: async () =>
        view({ status: "CANCELLED", filledAmount: d("0.04"), remainingAmount: d("0"), avgFillPrice: d("60000") }),
      getFills: async () => [
        {
          externalFillId: "f1",
          externalOrderId: "ext-1",
          side: "BUY",
          price: d("60000"),
          amount: d("0.04"),
          quoteAmount: d("2400"),
          fee: d("4.8"),
          feeAsset: "USDT",
          executedAt: new Date("2026-01-01T00:00:00Z"),
        },
      ],
    });
    const svc = new ExecutionService(provider);

    const cancel = await svc.cancelOrder({ externalOrderId: "ext-1" });
    assert.ok(cancel.ok && cancel.value.status === "CANCELLED");

    // The authoritative resolution is the venue's own view + fills, which the
    // settlement layer reconciles against the internal order — not a guess.
    const reconciled = await svc.getOrder({ externalOrderId: "ext-1" });
    assert.ok(reconciled.ok);
    assert.equal(reconciled.value.status, "CANCELLED");
    assert.equal(reconciled.value.filledAmount, "0.04"); // the partial fill is real and kept

    const fills = await svc.getFills({ externalOrderId: "ext-1" });
    assert.ok(fills.ok && fills.value.length === 1);
  });
});

describe("getFills — idempotent reconciliation", () => {
  test("a replayed fill is de-duplicated by externalFillId", async () => {
    const one: ExecutionFill = {
      externalFillId: "f1",
      externalOrderId: "ext-1",
      side: "BUY",
      price: d("60000"),
      amount: d("0.1"),
      quoteAmount: d("6000"),
      fee: d("12"),
      feeAsset: "USDT",
      executedAt: new Date("2026-01-01T00:00:00Z"),
    };
    const provider = new StubExecutionProvider({ getFills: async () => [one, { ...one }] });
    const svc = new ExecutionService(provider);
    const result = await svc.getFills({ externalOrderId: "ext-1" });
    assert.ok(result.ok);
    assert.equal(result.value.length, 1); // one settlement, not two
  });
});

describe("configuration", () => {
  test("isConfigured reflects the provider", () => {
    assert.equal(new ExecutionService(new StubExecutionProvider()).isConfigured(), true);
  });
});

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  ZERO,
  addMoney,
  compareMoney,
  isPositive,
  isZero,
  multiplyMoney,
  parseMoney,
  subtractMoney,
  toDecimalString,
  type DecimalString,
  type Money,
} from "../../money.ts";
import { SettlementService } from "../../settlement/service.ts";
import type { SettledFill } from "../../settlement/fills.ts";
import type { ApplyFillInput, SettlementGateway, SettlementOrder } from "../../settlement/types.ts";
import { OrderExecutionCoordinator, buildSubmitRequest, type OrderLifecycleGateway, type VenueEnd } from "../coordinator.ts";
import type { OrderPhase, OrderRecord } from "../lifecycle.ts";
import { ExecutionService } from "../service.ts";
import {
  ExecutionError,
  venueClientOrderIdFor,
  type ExecutionCancelAck,
  type ExecutionFill,
  type ExecutionOrderAck,
  type ExecutionOrderRequest,
  type ExecutionOrderView,
  type ExecutionProvider,
  type ExternalOrderRef,
  type ExternalOrderStatus,
  type FillReporting,
  type OrderSide,
} from "../types.ts";

/**
 * Order execution coordinator (Slice 14A), end to end over TEST DOUBLES — no
 * database, no network, no real venue:
 *
 *   * `ModelBook` — an in-memory model of the persisted order, trades and one
 *     customer's wallets. Its `applyFill` mirrors the contract of the SQL
 *     `apply_fill` (020): idempotent on provider_trade_id, refuses terminal
 *     orders and over-fills, draws the reservation down per fill and releases a
 *     residual on completion. Its lifecycle writes mirror migration 022's
 *     primitives (claim_order_for_submission, record_provider_order_id,
 *     finalize_venue_cancellation). The SQL itself is proven by the DB suite.
 *   * `ModelVenue` — a scripted execution venue. It executes only when a test
 *     tells it to; it is not a simulator and is not shipped.
 *
 * Figures: BTC-USDT, one customer with 10000 USDT and 1 BTC; a 0.010 BTC LIMIT
 * BUY at 80000 with a 0.2% fee reserves 801.60 USDT.
 */

const m = (v: string): Money => parseMoney(v);
const s = (v: Money): string => toDecimalString(v);
const NOW = new Date("2026-10-19T12:00:00Z");
const FEE_RATE = m("0.002");

type Asset = "USDT" | "BTC";
type ModelOrder = {
  orderId: string;
  userId: string;
  side: OrderSide;
  type: "LIMIT" | "MARKET";
  phase: OrderPhase;
  price: Money | null;
  amount: Money;
  filled: Money;
  locked: Money;
  lockAsset: Asset;
  externalOrderId: string | null;
};

/** In-memory persisted state; see the file comment. */
class ModelBook implements SettlementGateway, OrderLifecycleGateway {
  readonly orders = new Map<string, ModelOrder>();
  readonly trades = new Map<string, { tradeId: string; orderId: string; base: Money; quote: Money; fee: Money }>();
  readonly wallets: Record<Asset, { available: Money; locked: Money }> = {
    USDT: { available: m("10000"), locked: ZERO },
    BTC: { available: m("1"), locked: ZERO },
  };
  readonly released: Money[] = [];
  readonly finalizations: { orderId: string; end: VenueEnd }[] = [];
  applyCalls = 0;

  /** place_limit_order: the order row and its HOLD. */
  place(orderId: string, side: OrderSide, amount: string, price: string): ModelOrder {
    const notional = multiplyMoney(m(price), m(amount), "up");
    const lock = side === "BUY" ? addMoney(notional, multiplyMoney(notional, FEE_RATE, "up")) : m(amount);
    const lockAsset: Asset = side === "BUY" ? "USDT" : "BTC";
    this.move(lockAsset, subtractMoney(ZERO, lock), lock);
    const order: ModelOrder = { orderId, userId: "user-1", side, type: "LIMIT", phase: "OPEN", price: m(price), amount: m(amount), filled: ZERO, locked: lock, lockAsset, externalOrderId: null };
    this.orders.set(orderId, order);
    return order;
  }

  private move(asset: Asset, available: Money, locked: Money): void {
    const w = this.wallets[asset];
    w.available = addMoney(w.available, available);
    w.locked = addMoney(w.locked, locked);
    assert.ok(!isPositive(subtractMoney(ZERO, w.available)) && !isPositive(subtractMoney(ZERO, w.locked)), `${asset} wallet went negative`);
  }

  private terminal(o: ModelOrder): boolean {
    return o.phase === "FILLED" || o.phase === "CANCELLED" || o.phase === "REJECTED" || o.phase === "EXPIRED";
  }

  private release(o: ModelOrder): void {
    if (isPositive(o.locked)) {
      this.move(o.lockAsset, o.locked, subtractMoney(ZERO, o.locked));
      this.released.push(o.locked);
    }
    o.locked = ZERO;
  }

  /** The REQUIRED future customer-cancel rule: only an order never sent to a venue releases on request. */
  async userCancel(orderId: string): Promise<boolean> {
    const o = this.orders.get(orderId);
    if (!o || o.phase !== "OPEN") return false;
    this.release(o);
    o.phase = "CANCELLED";
    return true;
  }

  // --- OrderLifecycleGateway -------------------------------------------------
  async loadOrder(orderId: string): Promise<OrderRecord | null> {
    const o = this.orders.get(orderId);
    if (!o) return null;
    return {
      orderId: o.orderId,
      userId: o.userId,
      pair: "BTC-USDT",
      side: o.side,
      type: o.type,
      phase: o.phase,
      price: o.price,
      amount: o.amount,
      filledAmount: o.filled,
      lockedAmount: o.locked,
      externalOrderId: o.externalOrderId,
    };
  }
  /** claim_order_for_submission: this user's OPEN LIMIT order, reserved, nothing filled. */
  async claimSubmission(order: { orderId: string; userId: string }): Promise<boolean> {
    const o = this.orders.get(order.orderId);
    if (!o || o.userId !== order.userId || o.phase !== "OPEN" || o.type !== "LIMIT") return false;
    if (o.externalOrderId !== null || !isZero(o.filled) || !isPositive(o.locked)) return false;
    o.phase = "SUBMITTED";
    return true;
  }
  /** record_provider_order_id: set once, onto a SUBMITTED order of this user, unique. */
  async recordExternalOrderId(order: { orderId: string; userId: string }, externalOrderId: string): Promise<"RECORDED" | "ALREADY_RECORDED" | "CONFLICT"> {
    const o = this.orders.get(order.orderId);
    if (!o || o.userId !== order.userId) return "CONFLICT";
    if (o.externalOrderId !== null) return o.externalOrderId === externalOrderId ? "ALREADY_RECORDED" : "CONFLICT";
    if (o.phase !== "SUBMITTED") return "CONFLICT";
    for (const other of this.orders.values()) if (other.externalOrderId === externalOrderId) return "CONFLICT"; // UNIQUE
    o.externalOrderId = externalOrderId;
    return "RECORDED";
  }
  /** finalize_venue_cancellation: venue ended, its order, its final cumulative == settled == Σ trades. */
  async finalizeAfterVenueEnd(orderId: string, end: VenueEnd): Promise<"FINALIZED" | "ALREADY_FINALIZED" | "REFUSED"> {
    this.finalizations.push({ orderId, end });
    const o = this.orders.get(orderId);
    if (!o) return "REFUSED";
    if (o.phase === "CANCELLED") return "ALREADY_FINALIZED";
    if (o.phase !== "SUBMITTED" && o.phase !== "PARTIALLY_FILLED") return "REFUSED";
    if (o.externalOrderId !== end.externalOrderId) return "REFUSED";
    if (o.externalOrderId === null && (!isZero(end.venueFilled) || !isZero(o.filled))) return "REFUSED";
    if (compareMoney(o.filled, end.venueFilled) !== 0) return "REFUSED";
    let settled = ZERO;
    for (const t of this.trades.values()) if (t.orderId === orderId) settled = addMoney(settled, t.base);
    if (compareMoney(settled, o.filled) !== 0) return "REFUSED";
    this.release(o);
    o.phase = "CANCELLED";
    return "FINALIZED";
  }

  // --- SettlementGateway -----------------------------------------------------
  async resolveOrderByExternalId(externalOrderId: string): Promise<SettlementOrder | null> {
    for (const o of this.orders.values()) {
      if (o.externalOrderId === externalOrderId) {
        return { orderId: o.orderId, side: o.side, status: o.phase, amount: o.amount, filledAmount: o.filled };
      }
    }
    return null;
  }
  async listSettledFills(orderId: string): Promise<SettledFill[]> {
    return [...this.trades.entries()]
      .filter(([, t]) => t.orderId === orderId)
      .map(([providerTradeId, t]) => ({ providerTradeId, base: t.base, quote: t.quote, fee: t.fee }));
  }
  async resolveAssetId(symbol: string): Promise<string | null> {
    return symbol === "USDT" ? "asset-usdt" : symbol === "BTC" ? "asset-btc" : null;
  }
  async findTradeByProviderTradeId(providerTradeId: string): Promise<string | null> {
    return this.trades.get(providerTradeId)?.tradeId ?? null;
  }
  /** Mirrors apply_fill (020). */
  async applyFill(input: ApplyFillInput): Promise<{ ok: true; tradeId: string } | { ok: false; code?: string | null; message?: string | null }> {
    this.applyCalls += 1;
    const o = this.orders.get(input.orderId);
    if (!o) return { ok: false, code: "23503", message: "apply_fill: unknown order" };
    const existing = this.trades.get(input.providerTradeId);
    if (existing) return { ok: true, tradeId: existing.tradeId };
    if (this.terminal(o)) return { ok: false, code: "23001", message: "apply_fill: order is terminal" };
    if (!isPositive(input.baseAmount) || !isPositive(input.quoteAmount)) return { ok: false, code: "23514", message: "apply_fill: base amount must be a positive number" };
    if (compareMoney(addMoney(o.filled, input.baseAmount), o.amount) > 0) return { ok: false, code: "23514", message: "apply_fill: fill exceeds order remaining" };
    if (isPositive(input.feeAmount) && input.feeAssetId !== "asset-usdt") return { ok: false, code: "23514", message: "apply_fill: the fee must be denominated in the pair quote asset" };

    if (o.side === "BUY") {
      const consumed = addMoney(input.quoteAmount, input.feeAmount);
      if (compareMoney(consumed, o.locked) > 0) return { ok: false, code: "23514", message: "apply_fill: only so much is reserved" };
      this.move("USDT", ZERO, subtractMoney(ZERO, consumed));
      this.move("BTC", input.baseAmount, ZERO);
      o.locked = subtractMoney(o.locked, consumed);
    } else {
      if (compareMoney(input.baseAmount, o.locked) > 0) return { ok: false, code: "23514", message: "apply_fill: only so much is reserved" };
      this.move("BTC", ZERO, subtractMoney(ZERO, input.baseAmount));
      this.move("USDT", subtractMoney(input.quoteAmount, input.feeAmount), ZERO);
      o.locked = subtractMoney(o.locked, input.baseAmount);
    }
    o.filled = addMoney(o.filled, input.baseAmount);
    const completes = compareMoney(o.filled, o.amount) === 0;
    if (completes) this.release(o);
    o.phase = completes ? "FILLED" : "PARTIALLY_FILLED";
    const tradeId = `trade-${this.trades.size + 1}`;
    this.trades.set(input.providerTradeId, { tradeId, orderId: o.orderId, base: input.baseAmount, quote: input.quoteAmount, fee: input.feeAmount });
    return { ok: true, tradeId };
  }

  order(orderId = "order-1"): ModelOrder {
    const o = this.orders.get(orderId);
    assert.ok(o);
    return o;
  }
}

type VenueOrder = {
  externalOrderId: string;
  clientOrderId: string;
  side: OrderSide;
  amount: Money;
  status: ExternalOrderStatus;
  filled: Money;
  cumQuote: Money;
  cumFee: Money;
  fills: ExecutionFill[];
};

/** Scripted venue double. Executes only when a test calls `execute`. Not a simulator. */
class ModelVenue implements ExecutionProvider {
  readonly name = "model-venue";
  readonly fillReporting: FillReporting;
  configured = true;
  placeBehaviour: "ACCEPT" | "ACK_FILLED" | "REJECT" | "HANG_BEFORE_ACCEPT" | "HANG_AFTER_ACCEPT" | "UNKNOWN_STATUS" = "ACCEPT";
  cancelBehaviour: "PENDING" | "CONFIRM" | "REJECT" | "UNKNOWN_STATUS" = "CONFIRM";
  hideFills = false;
  readonly orders = new Map<string, VenueOrder>();
  readonly calls = { place: [] as ExecutionOrderRequest[], cancel: [] as ExternalOrderRef[] };
  private fillSeq = 0;

  constructor(fillReporting: FillReporting = "DISCRETE") {
    this.fillReporting = fillReporting;
  }

  isConfigured(): boolean {
    return this.configured;
  }

  private find(ref: ExternalOrderRef): VenueOrder {
    const found = ref.clientOrderId !== undefined
      ? this.orders.get(ref.clientOrderId)
      : [...this.orders.values()].find((o) => o.externalOrderId === ref.externalOrderId);
    if (!found) throw new ExecutionError("UNKNOWN_ORDER", "no such order");
    return found;
  }

  private ackOf(o: VenueOrder, status: ExternalOrderStatus = o.status): ExecutionOrderAck {
    return { externalOrderId: o.externalOrderId, clientOrderId: o.clientOrderId, status, acceptedAt: NOW };
  }

  async placeOrder(req: ExecutionOrderRequest): Promise<ExecutionOrderAck> {
    this.calls.place.push(req);
    if (this.placeBehaviour === "REJECT") throw new ExecutionError("REJECTED", "venue refused the order");
    const existing = this.orders.get(req.clientOrderId);
    if (existing) return this.ackOf(existing); // idempotent on our reference
    if (this.placeBehaviour === "HANG_BEFORE_ACCEPT") return new Promise<ExecutionOrderAck>(() => {});
    const o: VenueOrder = {
      externalOrderId: `ext-${this.orders.size + 1}`,
      clientOrderId: req.clientOrderId,
      side: req.side,
      amount: m(req.amount),
      status: "OPEN",
      filled: ZERO,
      cumQuote: ZERO,
      cumFee: ZERO,
      fills: [],
    };
    this.orders.set(req.clientOrderId, o);
    if (this.placeBehaviour === "HANG_AFTER_ACCEPT") return new Promise<ExecutionOrderAck>(() => {});
    if (this.placeBehaviour === "UNKNOWN_STATUS") return this.ackOf(o, "UNKNOWN");
    if (this.placeBehaviour === "ACK_FILLED") return this.ackOf(o, "FILLED");
    return this.ackOf(o, "ACCEPTED");
  }

  async cancelOrder(ref: ExternalOrderRef): Promise<ExecutionCancelAck> {
    this.calls.cancel.push(ref);
    const o = this.find(ref);
    if (this.cancelBehaviour === "REJECT") throw new ExecutionError("REJECTED", "venue refused the cancel");
    if (this.cancelBehaviour === "UNKNOWN_STATUS") return { externalOrderId: o.externalOrderId, status: "UNKNOWN" };
    if (o.status === "FILLED") return { externalOrderId: o.externalOrderId, status: "FILLED" };
    o.status = this.cancelBehaviour === "PENDING" ? "CANCEL_PENDING" : "CANCELLED";
    return { externalOrderId: o.externalOrderId, status: o.status };
  }

  async getOrder(ref: ExternalOrderRef): Promise<ExecutionOrderView> {
    const o = this.find(ref);
    return {
      externalOrderId: o.externalOrderId,
      clientOrderId: o.clientOrderId,
      status: o.status,
      filledAmount: s(o.filled) as DecimalString,
      remainingAmount: s(subtractMoney(o.amount, o.filled)) as DecimalString,
      avgFillPrice: null,
      cumulativeQuote: s(o.cumQuote) as DecimalString,
      cumulativeFee: s(o.cumFee) as DecimalString,
      feeAsset: "USDT",
    };
  }

  async getOpenOrders(): Promise<ExecutionOrderView[]> {
    return [];
  }

  async getFills(ref: ExternalOrderRef): Promise<ExecutionFill[]> {
    const o = this.find(ref);
    return this.hideFills ? [] : [...o.fills];
  }

  /** The venue executes `base` at `price` (test control). */
  execute(base: string, price: string, clientOrderId = venueClientOrderIdFor("order-1")): ExecutionFill {
    const o = this.orders.get(clientOrderId);
    assert.ok(o, "no venue order to execute");
    const quote = multiplyMoney(m(price), m(base), "up");
    const fee = multiplyMoney(quote, FEE_RATE, "up");
    const fill: ExecutionFill = {
      externalFillId: `vt-${++this.fillSeq}`,
      externalOrderId: o.externalOrderId,
      side: o.side,
      price: s(m(price)) as DecimalString,
      amount: s(m(base)) as DecimalString,
      quoteAmount: s(quote) as DecimalString,
      fee: s(fee) as DecimalString,
      feeAsset: "USDT",
      executedAt: NOW,
    };
    o.fills.push(fill);
    o.filled = addMoney(o.filled, m(base));
    o.cumQuote = addMoney(o.cumQuote, quote);
    o.cumFee = addMoney(o.cumFee, fee);
    o.status = compareMoney(o.filled, o.amount) === 0 ? "FILLED" : "PARTIALLY_FILLED";
    return fill;
  }
}

function setup(mode: FillReporting = "DISCRETE", side: OrderSide = "BUY") {
  const book = new ModelBook();
  const venue = new ModelVenue(mode);
  const execution = new ExecutionService(venue, { defaultTimeoutMs: 30 });
  const settlement = new SettlementService(book);
  const coordinator = new OrderExecutionCoordinator({ execution, gateway: book, settlement, now: () => NOW });
  book.place("order-1", side, "0.010", "80000");
  return { book, venue, settlement, coordinator };
}

const wallets = (book: ModelBook) => ({
  usdt: { available: s(book.wallets.USDT.available), locked: s(book.wallets.USDT.locked) },
  btc: { available: s(book.wallets.BTC.available), locked: s(book.wallets.BTC.locked) },
});

/* ------------------------------------------------------------------ submit */

describe("submit", () => {
  test("OPEN → SUBMITTED: the venue id is recorded and no money moves", async () => {
    const { book, venue, coordinator } = setup();
    const before = wallets(book);
    const outcome = await coordinator.submit("order-1");
    assert.deepEqual(outcome, { kind: "SUBMITTED", externalOrderId: "ext-1", fillsReported: false });
    assert.equal(book.order().phase, "SUBMITTED");
    assert.equal(book.order().externalOrderId, "ext-1");
    assert.deepEqual(wallets(book), before);
    assert.equal(book.trades.size, 0);
    assert.equal(venue.calls.place.length, 1);
  });

  test("the venue receives identity and intent only — no balance, fee, reserve or ledger field", async () => {
    const { venue, coordinator } = setup();
    await coordinator.submit("order-1");
    const req = venue.calls.place[0];
    assert.ok(req);
    assert.deepEqual(Object.keys(req).sort(), ["amount", "clientOrderId", "internalOrderId", "pair", "price", "remainingAmount", "side", "type"]);
    assert.equal(req.internalOrderId, "order-1");
    assert.equal(req.clientOrderId, venueClientOrderIdFor("order-1"));
    assert.deepEqual([req.pair, req.side, req.type, req.price, req.amount, req.remainingAmount], ["BTC-USDT", "BUY", "LIMIT", "80000", "0.01", "0.01"]);
  });

  test("an acceptance that already reports FILLED settles nothing — acceptance is not a fill (10, 40)", async () => {
    const { book, venue, coordinator } = setup();
    venue.placeBehaviour = "ACK_FILLED";
    const before = wallets(book);
    const outcome = await coordinator.submit("order-1");
    assert.deepEqual(outcome, { kind: "SUBMITTED", externalOrderId: "ext-1", fillsReported: true });
    assert.equal(s(book.order().filled), "0");
    assert.equal(book.trades.size, 0);
    assert.equal(book.applyCalls, 0);
    assert.deepEqual(wallets(book), before);
  });

  test("a duplicate submit does not reach the venue again (26)", async () => {
    const { venue, coordinator } = setup();
    await coordinator.submit("order-1");
    assert.deepEqual(await coordinator.submit("order-1"), { kind: "ALREADY_SUBMITTED" });
    assert.equal(venue.calls.place.length, 1);
    assert.equal(venue.orders.size, 1);
  });

  test("concurrent submits: one claim wins and the venue is called once", async () => {
    const { venue, coordinator } = setup();
    const outcomes = await Promise.all([coordinator.submit("order-1"), coordinator.submit("order-1")]);
    assert.deepEqual(outcomes.map((o) => o.kind).sort(), ["CLAIM_LOST", "SUBMITTED"]);
    assert.equal(venue.calls.place.length, 1);
  });

  test("no venue connected: the order is not touched (today's deployment)", async () => {
    const { book, venue, coordinator } = setup();
    venue.configured = false;
    assert.deepEqual(await coordinator.submit("order-1"), { kind: "NOT_CONNECTED" });
    assert.equal(book.order().phase, "OPEN");
    assert.equal(venue.calls.place.length, 0);
  });

  test("MARKET is never sent to a venue (MARKET stays unsupported)", async () => {
    const { book, venue, coordinator } = setup();
    Object.assign(book.order(), { type: "MARKET", price: null });
    assert.equal((await coordinator.submit("order-1")).kind, "NOT_SUBMITTABLE");
    assert.equal(buildSubmitRequest((await book.loadOrder("order-1"))!), null);
    assert.equal(venue.calls.place.length, 0);
    assert.equal(book.order().phase, "OPEN");
  });

  test("a terminal order is never submitted", async () => {
    const { book, venue, coordinator } = setup();
    await book.userCancel("order-1");
    assert.equal((await coordinator.submit("order-1")).kind, "NOT_SUBMITTABLE");
    assert.equal(venue.calls.place.length, 0);
  });

  test("BUY and SELL requests carry the side and the limit intent (38/39)", async () => {
    for (const side of ["BUY", "SELL"] as const) {
      const { book } = setup("DISCRETE", side);
      const req = buildSubmitRequest((await book.loadOrder("order-1"))!);
      assert.equal(req?.side, side);
      assert.equal(req?.type, "LIMIT");
    }
  });
});

describe("submit failures keep the reservation and never guess", () => {
  test("provider rejects: no fill, no trade, funds stay reserved — released only once the venue confirms it has no order (33)", async () => {
    const { book, venue, coordinator } = setup();
    venue.placeBehaviour = "REJECT";
    assert.deepEqual(await coordinator.submit("order-1"), { kind: "REJECTED_BY_VENUE" });
    assert.equal(book.order().phase, "SUBMITTED");
    assert.deepEqual(wallets(book).usdt, { available: "9198.4", locked: "801.6" });
    assert.equal(book.trades.size, 0);

    // Reconcile: the venue holds nothing under our reference and refuses the same request again.
    assert.deepEqual(await coordinator.reconcile("order-1"), { kind: "RELEASED", settled: 0 });
    assert.equal(book.order().phase, "CANCELLED");
    assert.deepEqual(wallets(book).usdt, { available: "10000", locked: "0" });
    assert.equal(book.trades.size, 0);
    assert.deepEqual(venue.calls.place.map((r) => r.clientOrderId), [venueClientOrderIdFor("order-1"), venueClientOrderIdFor("order-1")]);
  });

  test("timeout after the venue took it: not assumed rejected, not assumed accepted; reconcile finds it (34)", async () => {
    const { book, venue, coordinator } = setup();
    venue.placeBehaviour = "HANG_AFTER_ACCEPT";
    const outcome = await coordinator.submit("order-1");
    assert.equal(outcome.kind, "UNRESOLVED");
    assert.equal(book.order().phase, "SUBMITTED");
    assert.equal(book.order().externalOrderId, null);
    assert.deepEqual(wallets(book).usdt, { available: "9198.4", locked: "801.6" });

    // A second submit does not resend.
    assert.equal((await coordinator.submit("order-1")).kind, "UNRESOLVED");
    assert.equal(venue.calls.place.length, 1);

    assert.deepEqual(await coordinator.reconcile("order-1"), { kind: "IN_PROGRESS", settled: 0 });
    assert.equal(book.order().externalOrderId, "ext-1");
    assert.equal(venue.calls.place.length, 1);
  });

  test("timeout before the venue took it: reconcile resends under the SAME reference — one venue order", async () => {
    const { book, venue, coordinator } = setup();
    venue.placeBehaviour = "HANG_BEFORE_ACCEPT";
    assert.equal((await coordinator.submit("order-1")).kind, "UNRESOLVED");
    venue.placeBehaviour = "ACCEPT";
    const outcome = await coordinator.reconcile("order-1");
    assert.deepEqual(outcome, { kind: "RESUBMITTED", outcome: { kind: "SUBMITTED", externalOrderId: "ext-1", fillsReported: false } });
    assert.equal(venue.orders.size, 1);
    assert.equal(new Set(venue.calls.place.map((r) => r.clientOrderId)).size, 1);
    assert.equal(book.order().externalOrderId, "ext-1");
  });

  test("an unknown status on the acknowledgement fails closed (32)", async () => {
    const { book, venue, coordinator } = setup();
    venue.placeBehaviour = "UNKNOWN_STATUS";
    assert.equal((await coordinator.submit("order-1")).kind, "UNRESOLVED");
    assert.equal(book.order().externalOrderId, null);
    assert.equal(book.order().phase, "SUBMITTED");
    assert.equal(s(book.order().locked), "801.6");
    assert.equal(book.trades.size, 0);
  });
});

/* ------------------------------------------------------------------- fills */

describe("fills settle only through settlement, exactly once", () => {
  test("BUY partial then complete: the hold pays quote + fee, base is credited (38)", async () => {
    const { book, venue, coordinator } = setup();
    await coordinator.submit("order-1");
    venue.execute("0.003", "80000");
    assert.deepEqual(await coordinator.reconcile("order-1"), { kind: "IN_PROGRESS", settled: 1 });
    assert.equal(book.order().phase, "PARTIALLY_FILLED");
    assert.equal(s(book.order().locked), "561.12");
    assert.deepEqual(wallets(book), { usdt: { available: "9198.4", locked: "561.12" }, btc: { available: "1.003", locked: "0" } });

    venue.execute("0.007", "80000");
    assert.deepEqual(await coordinator.reconcile("order-1"), { kind: "FILLED", settled: 1 });
    assert.equal(book.order().phase, "FILLED");
    assert.deepEqual(wallets(book), { usdt: { available: "9198.4", locked: "0" }, btc: { available: "1.01", locked: "0" } });
  });

  test("price improvement: the completing fill releases the unused reservation", async () => {
    const { book, venue, coordinator } = setup();
    await coordinator.submit("order-1");
    venue.execute("0.010", "79900"); // 799 + 1.598 fee = 800.598 of 801.60 reserved
    assert.deepEqual(await coordinator.reconcile("order-1"), { kind: "FILLED", settled: 1 });
    assert.deepEqual(wallets(book).usdt, { available: "9199.402", locked: "0" });
    assert.equal(s(book.released[0]!), "1.002");
  });

  test("SELL: the held base is delivered, quote proceeds arrive net of the fee (39)", async () => {
    const { book, venue, coordinator } = setup("DISCRETE", "SELL");
    assert.deepEqual(wallets(book).btc, { available: "0.99", locked: "0.01" });
    await coordinator.submit("order-1");
    venue.execute("0.004", "80000"); // 320 quote, 0.64 fee
    await coordinator.reconcile("order-1");
    assert.deepEqual(wallets(book), { usdt: { available: "10319.36", locked: "0" }, btc: { available: "0.99", locked: "0.006" } });
  });

  test("replayed venue fills are duplicates — apply_fill is not called again (27/28)", async () => {
    const { book, venue, coordinator } = setup();
    await coordinator.submit("order-1");
    venue.execute("0.003", "80000");
    await coordinator.reconcile("order-1");
    const calls = book.applyCalls;
    assert.deepEqual(await coordinator.reconcile("order-1"), { kind: "IN_PROGRESS", settled: 0 });
    assert.equal(book.applyCalls, calls);
    assert.equal(book.trades.size, 1);
    assert.equal(s(book.order().filled), "0.003");
  });

  test("the same provider trade id with different figures: the first wins (21)", async () => {
    const { book, venue, settlement, coordinator } = setup();
    await coordinator.submit("order-1");
    const first = venue.execute("0.003", "80000");
    assert.equal((await settlement.settleFill(first)).code, "SUCCESS");
    const forged = { ...first, amount: "0.005" as DecimalString, quoteAmount: "400" as DecimalString };
    assert.equal((await settlement.settleFill(forged)).code, "DUPLICATE");
    assert.equal(s(book.order().filled), "0.003");
  });

  test("zero, negative and over-fills never reach apply_fill (17/18/25)", async () => {
    const { book, venue, settlement, coordinator } = setup();
    await coordinator.submit("order-1");
    const fill = venue.execute("0.003", "80000");
    for (const bad of [
      { ...fill, externalFillId: "z", amount: "0" as DecimalString },
      { ...fill, externalFillId: "n", amount: "-0.003" as DecimalString },
      { ...fill, externalFillId: "o", amount: "0.011" as DecimalString, quoteAmount: "880" as DecimalString },
    ]) {
      const result = await settlement.settleFill(bad);
      assert.notEqual(result.code, "SUCCESS");
    }
    assert.equal((await settlement.settleFill({ ...fill, externalFillId: "o2", amount: "0.011" as DecimalString, quoteAmount: "880" as DecimalString })).code, "OVER_FILL");
    assert.equal(book.applyCalls, 0);
    assert.equal(s(book.order().filled), "0");
  });

  test("a fill for an order never submitted cannot be settled (no OPEN → FILLED)", async () => {
    const { book, settlement } = setup();
    const orphan: ExecutionFill = {
      externalFillId: "vt-x",
      externalOrderId: "ext-nobody",
      side: "BUY",
      price: "80000" as DecimalString,
      amount: "0.003" as DecimalString,
      quoteAmount: "240" as DecimalString,
      fee: "0.48" as DecimalString,
      feeAsset: "USDT",
      executedAt: NOW,
    };
    assert.equal((await settlement.settleFill(orphan)).code, "ORDER_NOT_FOUND");
    assert.equal(book.order().phase, "OPEN");
    assert.equal(book.applyCalls, 0);
  });

  test("events after FILLED or CANCELLED move nothing (29/30)", async () => {
    const filled = setup();
    await filled.coordinator.submit("order-1");
    const done = filled.venue.execute("0.010", "80000");
    await filled.coordinator.reconcile("order-1");
    assert.equal((await filled.settlement.settleFill({ ...done, externalFillId: "vt-late", amount: "0.001" as DecimalString, quoteAmount: "80" as DecimalString })).code, "ORDER_NOT_SETTLEABLE");
    assert.equal((await filled.settlement.settleFill(done)).code, "DUPLICATE");
    assert.equal(s(filled.book.order().filled), "0.01");

    const cancelled = setup();
    await cancelled.coordinator.submit("order-1");
    await cancelled.coordinator.requestCancel("order-1");
    await cancelled.coordinator.reconcile("order-1");
    assert.equal(cancelled.book.order().phase, "CANCELLED");
    const late = cancelled.venue.execute("0.001", "80000");
    assert.equal((await cancelled.settlement.settleFill(late)).code, "ORDER_NOT_SETTLEABLE");
    assert.equal(cancelled.book.trades.size, 0);
    assert.deepEqual(wallets(cancelled.book).usdt, { available: "10000", locked: "0" });
    assert.equal((await cancelled.coordinator.reconcile("order-1")).kind, "TERMINAL");
  });
});

describe("cumulative venue: deltas from persisted state", () => {
  test("0.003 → 0.006 → 0.010 settles 0.003, 0.003, 0.004 and ends FILLED (23)", async () => {
    const { book, venue, coordinator } = setup("CUMULATIVE");
    await coordinator.submit("order-1");
    for (const [base, expected] of [["0.003", "IN_PROGRESS"], ["0.003", "IN_PROGRESS"], ["0.004", "FILLED"]] as const) {
      venue.execute(base, "80000");
      assert.deepEqual(await coordinator.reconcile("order-1"), { kind: expected, settled: 1 });
    }
    assert.deepEqual([...book.trades.values()].map((t) => s(t.base)), ["0.003", "0.003", "0.004"]);
    assert.deepEqual([...book.trades.keys()], ["cumulative:ext-1:0", "cumulative:ext-1:0.003", "cumulative:ext-1:0.006"]);
    assert.equal(book.order().phase, "FILLED");
    assert.deepEqual(wallets(book), { usdt: { available: "9198.4", locked: "0" }, btc: { available: "1.01", locked: "0" } });
  });

  test("the same snapshot twice settles once (22)", async () => {
    const { book, venue, coordinator } = setup("CUMULATIVE");
    await coordinator.submit("order-1");
    venue.execute("0.003", "80000");
    await coordinator.reconcile("order-1");
    assert.deepEqual(await coordinator.reconcile("order-1"), { kind: "IN_PROGRESS", settled: 0 });
    assert.equal(book.trades.size, 1);
    assert.equal(s(book.order().filled), "0.003");
  });

  test("an older snapshot after a newer one is refused (20)", async () => {
    const { book, venue, settlement, coordinator } = setup("CUMULATIVE");
    await coordinator.submit("order-1");
    venue.execute("0.006", "80000");
    await coordinator.reconcile("order-1");
    const stale = {
      externalOrderId: "ext-1",
      side: "BUY" as const,
      status: "PARTIALLY_FILLED" as const,
      cumulativeBase: "0.003" as DecimalString,
      cumulativeQuote: "240" as DecimalString,
      cumulativeFee: "0.48" as DecimalString,
      feeAsset: "USDT",
      observedAt: NOW,
    };
    assert.equal((await settlement.settleSnapshot(stale)).code, "STALE_SNAPSHOT");
    assert.equal(s(book.order().filled), "0.006");
  });

  test("two snapshots derived concurrently from the same state settle once — never their sum", async () => {
    const { book, venue, settlement, coordinator } = setup("CUMULATIVE");
    await coordinator.submit("order-1");
    venue.execute("0.003", "80000");
    await coordinator.reconcile("order-1");
    const snap = (base: string, quote: string, fee: string) => ({
      externalOrderId: "ext-1",
      side: "BUY" as const,
      status: "PARTIALLY_FILLED" as const,
      cumulativeBase: base as DecimalString,
      cumulativeQuote: quote as DecimalString,
      cumulativeFee: fee as DecimalString,
      feeAsset: "USDT",
      observedAt: NOW,
    });
    const [a, b] = await Promise.all([
      settlement.settleSnapshot(snap("0.005", "400", "0.8")),
      settlement.settleSnapshot(snap("0.006", "480", "0.96")),
    ]);
    assert.ok("tradeId" in a && "tradeId" in b && a.tradeId === b.tradeId, "both resolve to the one trade");
    assert.equal(book.trades.size, 2);
    // Exactly one of the two deltas was applied: 0.005 or 0.006, never 0.008.
    assert.ok(["0.005", "0.006"].includes(s(book.order().filled)));
    // The next pass catches up from wherever settlement left off.
    venue.execute("0.003", "80000"); // venue cumulative now 0.006
    await coordinator.reconcile("order-1");
    assert.equal(s(book.order().filled), "0.006");
  });

  test("an over-filling snapshot is refused (25)", async () => {
    const { book, settlement, coordinator } = setup("CUMULATIVE");
    await coordinator.submit("order-1");
    const result = await settlement.settleSnapshot({
      externalOrderId: "ext-1",
      side: "BUY",
      status: "FILLED",
      cumulativeBase: "0.011" as DecimalString,
      cumulativeQuote: "880" as DecimalString,
      cumulativeFee: "1.76" as DecimalString,
      feeAsset: "USDT",
      observedAt: NOW,
    });
    assert.equal(result.code, "OVER_FILL");
    assert.equal(book.applyCalls, 0);
  });
});

/* ------------------------------------------------------------------ cancel */

describe("cancel", () => {
  test("OPEN: no venue order exists, the venue is not called", async () => {
    const { venue, coordinator } = setup();
    assert.deepEqual(await coordinator.requestCancel("order-1"), { kind: "NOT_SUBMITTED" });
    assert.equal(venue.calls.cancel.length, 0);
  });

  test("a cancel the venue accepted releases nothing; a fill that follows is settled normally (35)", async () => {
    const { book, venue, coordinator } = setup();
    await coordinator.submit("order-1");
    venue.cancelBehaviour = "PENDING";
    assert.deepEqual(await coordinator.requestCancel("order-1"), { kind: "CANCEL_REQUESTED" });
    assert.equal(s(book.order().locked), "801.6");
    assert.equal(book.released.length, 0);

    // The venue fills the order before honouring the cancel.
    venue.execute("0.010", "80000");
    assert.deepEqual(await coordinator.reconcile("order-1"), { kind: "FILLED", settled: 1 });
    assert.equal(book.order().phase, "FILLED");
    assert.deepEqual(wallets(book), { usdt: { available: "9198.4", locked: "0" }, btc: { available: "1.01", locked: "0" } });
  });

  test("cancel after a partial fill releases only the remainder — never what the fill consumed (12)", async () => {
    const { book, venue, coordinator } = setup();
    await coordinator.submit("order-1");
    venue.execute("0.003", "80000");
    await coordinator.reconcile("order-1");
    assert.deepEqual(await coordinator.requestCancel("order-1"), { kind: "VENUE_ENDED" });
    assert.equal(book.released.length, 0, "the cancel request itself releases nothing");

    assert.deepEqual(await coordinator.reconcile("order-1"), { kind: "RELEASED", settled: 0 });
    assert.equal(book.order().phase, "CANCELLED");
    assert.equal(s(book.order().filled), "0.003");
    assert.deepEqual(book.released.map(s), ["561.12"]); // 0.007 × 80000 × 1.002
    // The release is asked with the venue's own final word, which the database checks.
    assert.deepEqual(book.finalizations.map((f) => ({ ...f.end, venueFilled: s(f.end.venueFilled) })), [
      { externalOrderId: "ext-1", venueStatus: "CANCELLED", venueFilled: "0.003" },
    ]);
    assert.deepEqual(wallets(book), { usdt: { available: "9759.52", locked: "0" }, btc: { available: "1.003", locked: "0" } });
  });

  test("venue cancelled but a fill is not settled yet: nothing is released until it is", async () => {
    const { book, venue, coordinator } = setup();
    await coordinator.submit("order-1");
    venue.execute("0.003", "80000");
    venue.hideFills = true; // the venue's fills feed lags
    await coordinator.requestCancel("order-1");
    assert.deepEqual(await coordinator.reconcile("order-1"), { kind: "PENDING_FILLS", settled: 0 });
    assert.equal(s(book.order().locked), "801.6");
    assert.equal(book.released.length, 0);

    venue.hideFills = false;
    assert.deepEqual(await coordinator.reconcile("order-1"), { kind: "RELEASED", settled: 1 });
    assert.deepEqual(book.released.map(s), ["561.12"]);
  });

  test("already filled (36)", async () => {
    const { venue, coordinator } = setup();
    await coordinator.submit("order-1");
    venue.execute("0.010", "80000");
    await coordinator.reconcile("order-1");
    assert.deepEqual(await coordinator.requestCancel("order-1"), { kind: "ALREADY_FILLED" });
    assert.equal(venue.calls.cancel.length, 0);
  });

  test("the venue answers the cancel with FILLED: too late, nothing released", async () => {
    const { book, venue, coordinator } = setup();
    await coordinator.submit("order-1");
    venue.execute("0.010", "80000");
    assert.deepEqual(await coordinator.requestCancel("order-1"), { kind: "FILLED_AT_VENUE" });
    assert.equal(book.released.length, 0);
    assert.deepEqual(await coordinator.reconcile("order-1"), { kind: "FILLED", settled: 1 });
  });

  test("already cancelled (37)", async () => {
    const { venue, coordinator } = setup();
    await coordinator.submit("order-1");
    await coordinator.requestCancel("order-1");
    await coordinator.reconcile("order-1");
    const calls = venue.calls.cancel.length;
    assert.deepEqual(await coordinator.requestCancel("order-1"), { kind: "ALREADY_CANCELLED" });
    assert.equal(venue.calls.cancel.length, calls);
  });

  test("the venue refuses the cancel: the order continues, nothing released", async () => {
    const { book, venue, coordinator } = setup();
    await coordinator.submit("order-1");
    venue.cancelBehaviour = "REJECT";
    assert.deepEqual(await coordinator.requestCancel("order-1"), { kind: "CANCEL_REJECTED" });
    assert.equal(book.order().phase, "SUBMITTED");
    assert.equal(s(book.order().locked), "801.6");
  });

  test("an unknown status in the cancel answer fails closed", async () => {
    const { book, venue, coordinator } = setup();
    await coordinator.submit("order-1");
    venue.cancelBehaviour = "UNKNOWN_STATUS";
    assert.equal((await coordinator.requestCancel("order-1")).kind, "UNRESOLVED");
    assert.equal(s(book.order().locked), "801.6");
  });

  test("the customer's cancel and the submission claim are exclusive — a lost claim calls no venue (35)", async () => {
    const { book, venue, coordinator } = setup();
    // The customer cancels between the coordinator's read and its claim.
    const claim = book.claimSubmission.bind(book);
    book.claimSubmission = async (order: { orderId: string; userId: string }) => {
      await book.userCancel(order.orderId);
      return claim(order);
    };
    assert.deepEqual(await coordinator.submit("order-1"), { kind: "CLAIM_LOST" });
    assert.equal(venue.calls.place.length, 0);
    assert.equal(book.order().phase, "CANCELLED");
    assert.deepEqual(wallets(book).usdt, { available: "10000", locked: "0" });
  });

  test("once submitted, the customer's own cancel cannot release the reservation (the rule the schema must enforce)", async () => {
    const { book, coordinator } = setup();
    await coordinator.submit("order-1");
    assert.equal(await book.userCancel("order-1"), false);
    assert.equal(s(book.order().locked), "801.6");
  });
});

describe("unknown venue state never moves money", () => {
  test("reconcile with an unknown venue status releases nothing (32)", async () => {
    const { book, venue, coordinator } = setup();
    await coordinator.submit("order-1");
    const vo = venue.orders.get(venueClientOrderIdFor("order-1"))!;
    vo.status = "UNKNOWN";
    assert.equal((await coordinator.reconcile("order-1")).kind, "UNRESOLVED");
    assert.equal(s(book.order().locked), "801.6");
    assert.equal(book.released.length, 0);
  });

  test("a venue that forgets an acknowledged order is an incident, not a release", async () => {
    const { book, venue, coordinator } = setup();
    await coordinator.submit("order-1");
    venue.orders.clear();
    assert.equal((await coordinator.reconcile("order-1")).kind, "INCIDENT");
    assert.equal(s(book.order().locked), "801.6");
  });
});

describe("022 port semantics through the coordinator (14B)", () => {
  test("a venue id the CAS refuses is an incident — nothing is overwritten (13/15)", async () => {
    const { book, coordinator } = setup();
    // Another order already holds the id this venue will hand out first.
    const other = book.place("order-2", "BUY", "0.001", "80000");
    Object.assign(other, { phase: "SUBMITTED", externalOrderId: "ext-1" });
    const outcome = await coordinator.submit("order-1");
    assert.equal(outcome.kind, "INCIDENT");
    assert.equal(book.order("order-1").externalOrderId, null);
    assert.equal(book.order("order-2").externalOrderId, "ext-1");
    assert.equal(s(book.order("order-1").locked), "801.6"); // still reserved
    assert.equal(book.finalizations.length, 0);
  });

  test("an ambiguous submit keeps SUBMITTED, invents no venue order, attempts no release", async () => {
    const { book, venue, coordinator } = setup();
    venue.placeBehaviour = "HANG_BEFORE_ACCEPT";
    assert.equal((await coordinator.submit("order-1")).kind, "UNRESOLVED");
    assert.equal(book.order().phase, "SUBMITTED");
    assert.equal(book.order().externalOrderId, null);
    assert.equal(s(book.order().locked), "801.6");
    assert.equal(book.finalizations.length, 0);
    assert.equal(venue.orders.size, 0);
  });

  test("a release another worker already made is reported as terminal — never as a second release (21)", async () => {
    const { book, venue, coordinator } = setup();
    await coordinator.submit("order-1");
    venue.execute("0.003", "80000");
    await coordinator.reconcile("order-1");
    await coordinator.requestCancel("order-1");
    // A concurrent reconcile finalizes between this one's read and its call.
    const finalize = book.finalizeAfterVenueEnd.bind(book);
    book.finalizeAfterVenueEnd = async (orderId: string, end: VenueEnd) => {
      await finalize(orderId, end);
      return finalize(orderId, end);
    };
    assert.deepEqual(await coordinator.reconcile("order-1"), { kind: "TERMINAL" });
    assert.deepEqual(book.released.map(s), ["561.12"]);
  });

  test("the claim carries the order's owner", async () => {
    const { book, coordinator } = setup();
    const seen: { orderId: string; userId: string }[] = [];
    const claim = book.claimSubmission.bind(book);
    book.claimSubmission = async (order: { orderId: string; userId: string }) => {
      seen.push({ orderId: order.orderId, userId: order.userId });
      return claim(order);
    };
    await coordinator.submit("order-1");
    assert.deepEqual(seen, [{ orderId: "order-1", userId: "user-1" }]);
  });
});

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { AppError } from "../../errors.ts";
import { formatMoney, parseMoney, type Money } from "../../money.ts";
import type { ResolvedFeeRule } from "../fee-rules.ts";
import type { LimitDecision } from "../limit-rules.ts";
import {
  cancelOrder,
  placeLimitOrder,
  previewOrder,
  type AuthorizedUser,
  type OrderEngineDeps,
  type PlaceLimitOrderInput,
  type RecordedOrder,
  type ResolvedPair,
} from "../order-engine.ts";

/**
 * Order-engine orchestration tests (spec §19, §20, §24).
 *
 * The engine is pure: every outside effect is a port on `OrderEngineDeps`, so
 * these tests drive the full decision sequence with fake deps — no database, no
 * session, no network. Run with `node --test`. The money import is relative
 * because node --test executes this file directly and does not resolve `@/`.
 *
 * What the fakes stand in for, and what they do NOT prove: the real atomic HOLD
 * lives in `place_limit_order` (migration 018) and is proven by the SQL
 * invariant suite (`scripts/test-db.sh`). These tests prove the engine's
 * contract — authorization, server-side validation/fee/reserve, the single
 * placeOrder call, and safe error mapping — not that a transaction committed.
 */

const m = (v: string): Money => parseMoney(v);

// BTC-USDT from the seed: price_precision 2, amount_precision 8, min 0.0001.
const pair = (over: Partial<ResolvedPair> = {}): ResolvedPair => ({
  symbol: "BTC-USDT",
  baseAsset: "BTC",
  quoteAsset: "USDT",
  tradingEnabled: true,
  pricePrecision: 2,
  amountPrecision: 8,
  minOrderSize: m("0.0001"),
  maxOrderSize: null,
  pairId: "pair-1",
  baseAssetId: "asset-btc",
  quoteAssetId: "asset-usdt",
  ...over,
});

const authorizedUser = (over: Partial<AuthorizedUser> = {}): AuthorizedUser => ({
  userId: "user-1",
  tierCode: "TIER_1",
  status: "ACTIVE",
  ...over,
});

const placeInput = (over: Partial<PlaceLimitOrderInput> = {}): PlaceLimitOrderInput => ({
  pairSymbol: "BTC-USDT",
  side: "BUY",
  type: "LIMIT",
  amount: m("0.5"),
  price: m("60000"),
  clientOrderId: null,
  ...over,
});

// 0.2% trade fee (the seeded TRADE rate), no fixed/min/max component.
const feeRule: ResolvedFeeRule = {
  percentage: m("0.2"),
  fixedFee: m("0"),
  minFee: null,
  maxFee: null,
};

const allow: LimitDecision = { decision: "ALLOW", evaluated: [] };

type PlaceParams = Parameters<OrderEngineDeps["placeOrder"]>[0];

/** What the database records for a freshly placed order: OPEN, holding exactly its lock. */
const recordedFrom = (params: PlaceParams): RecordedOrder => ({
  status: "OPEN",
  lockedAsset: params.lockAssetId === "asset-btc" ? "BTC" : "USDT",
  lockedAmount: params.lockAmount,
});

/**
 * A fully working set of deps with sensible defaults. Each call is recorded so a
 * test can assert exactly what the engine passed to the atomic place RPC. Pass
 * overrides to make one port fail or behave differently.
 */
function makeDeps(over: Partial<OrderEngineDeps> = {}): {
  deps: OrderEngineDeps;
  placeCalls: PlaceParams[];
} {
  const placeCalls: PlaceParams[] = [];
  const deps: OrderEngineDeps = {
    authorize: async () => authorizedUser(),
    loadPair: async () => pair(),
    checkLimits: async () => allow,
    resolveFeeRule: async () => feeRule,
    placeOrder: async (params) => {
      placeCalls.push(params);
      return { ok: true, orderId: "order-1" };
    },
    // Mirrors the database for a fresh order: it holds exactly what was placed.
    readOrder: async () => {
      const last = placeCalls.at(-1);
      return last ? recordedFrom(last) : null;
    },
    cancelOrderRpc: async () => true,
    ...over,
  };
  return { deps, placeCalls };
}

/** Run `fn` with console.error silenced, so an expected internal log is not noise. */
async function withSilencedErrors<T>(fn: () => Promise<T>): Promise<T> {
  const original = console.error;
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.error = original;
  }
}

/** The single recorded element of a capture array (asserts there is exactly one). */
function only<T>(arr: T[]): T {
  assert.equal(arr.length, 1);
  const v = arr[0];
  assert.ok(v !== undefined);
  return v;
}

describe("placeLimitOrder — authorization", () => {
  test("unauthenticated: the error is reported and nothing is placed", async () => {
    let placed = false;
    const { deps } = makeDeps({
      authorize: async () => {
        throw new AppError("UNAUTHENTICATED");
      },
      placeOrder: async () => {
        placed = true;
        return { ok: true, orderId: "x" };
      },
    });
    const r = await placeLimitOrder(deps, placeInput());
    assert.ok(!r.ok && r.code === "UNAUTHENTICATED");
    assert.equal(placed, false);
  });

  test("email not verified is reported as its own code", async () => {
    const { deps } = makeDeps({
      authorize: async () => {
        throw new AppError("EMAIL_NOT_VERIFIED");
      },
    });
    const r = await placeLimitOrder(deps, placeInput());
    assert.ok(!r.ok && r.code === "EMAIL_NOT_VERIFIED");
  });

  test("a suspended account is reported as its own code", async () => {
    const { deps } = makeDeps({
      authorize: async () => {
        throw new AppError("ACCOUNT_SUSPENDED");
      },
    });
    const r = await placeLimitOrder(deps, placeInput());
    assert.ok(!r.ok && r.code === "ACCOUNT_SUSPENDED");
  });

  test("an error code the engine does not report collapses to INTERNAL, never leaks", async () => {
    const { deps } = makeDeps({
      authorize: async () => {
        throw new AppError("FORBIDDEN", "internal: user 7 lacks role trader");
      },
    });
    const r = await placeLimitOrder(deps, placeInput());
    assert.ok(!r.ok && r.code === "INTERNAL");
    assert.doesNotMatch(r.message, /role|trader|user 7/);
  });
});

describe("placeLimitOrder — market and validation", () => {
  test("an unknown market is a validation failure, not a crash", async () => {
    const { deps } = makeDeps({ loadPair: async () => null });
    const r = await placeLimitOrder(deps, placeInput({ pairSymbol: "NOPE-USDT" }));
    assert.ok(!r.ok && r.code === "VALIDATION_FAILED");
  });

  test("a market with trading disabled is refused with TRADING_DISABLED", async () => {
    const { deps } = makeDeps({ loadPair: async () => pair({ tradingEnabled: false }) });
    const r = await placeLimitOrder(deps, placeInput());
    assert.ok(!r.ok && r.code === "TRADING_DISABLED");
  });

  test("a MARKET order is refused honestly: no execution venue", async () => {
    const { deps } = makeDeps();
    const r = await placeLimitOrder(deps, placeInput({ type: "MARKET", price: null }));
    assert.ok(!r.ok && r.code === "VALIDATION_FAILED");
    assert.match(r.message, /Market orders are not available/);
  });

  test("a non-positive amount is a validation failure", async () => {
    const { deps } = makeDeps();
    const r = await placeLimitOrder(deps, placeInput({ amount: m("0") }));
    assert.ok(!r.ok && r.code === "VALIDATION_FAILED");
  });

  test("a price finer than the market's precision is a validation failure", async () => {
    const { deps } = makeDeps();
    const r = await placeLimitOrder(deps, placeInput({ price: m("60000.001") })); // 3dp > 2
    assert.ok(!r.ok && r.code === "VALIDATION_FAILED");
  });

  test("below the market minimum size is a validation failure", async () => {
    const { deps } = makeDeps();
    const r = await placeLimitOrder(deps, placeInput({ amount: m("0.00005") }));
    assert.ok(!r.ok && r.code === "VALIDATION_FAILED");
    assert.match(r.message, /minimum size/);
  });
});

describe("placeLimitOrder — tier limits", () => {
  test("over the tier limit becomes LIMIT_EXCEEDED, and nothing is placed", async () => {
    let placed = false;
    const { deps } = makeDeps({
      checkLimits: async () => ({
        decision: "BLOCK",
        reason: "this amount exceeds the daily limit and no higher tier permits it",
        evaluated: [],
      }),
      placeOrder: async () => {
        placed = true;
        return { ok: true, orderId: "x" };
      },
    });
    const r = await placeLimitOrder(deps, placeInput());
    assert.ok(!r.ok && r.code === "LIMIT_EXCEEDED");
    assert.equal(placed, false);
  });

  test("below the operation minimum becomes LIMIT_BELOW_MINIMUM", async () => {
    const { deps } = makeDeps({
      checkLimits: async () => ({
        decision: "BLOCK",
        reason: "amount is below the minimum for this operation",
        evaluated: [],
      }),
    });
    const r = await placeLimitOrder(deps, placeInput());
    assert.ok(!r.ok && r.code === "LIMIT_BELOW_MINIMUM");
  });

  test("REQUIRE_KYC becomes KYC_REQUIRED", async () => {
    const { deps } = makeDeps({
      checkLimits: async () => ({
        decision: "REQUIRE_KYC",
        reason: "this amount exceeds the daily limit for your account tier",
        requiredTier: "TIER_2",
        evaluated: [],
      }),
    });
    const r = await placeLimitOrder(deps, placeInput());
    assert.ok(!r.ok && r.code === "KYC_REQUIRED");
  });

  test("an unvaluable amount refuses (LIMIT_CHECK_UNAVAILABLE) rather than guessing", async () => {
    const { deps } = makeDeps({
      checkLimits: async () => ({ decision: "UNAVAILABLE", reason: "no market data available" }),
    });
    const r = await placeLimitOrder(deps, placeInput());
    assert.ok(!r.ok && r.code === "LIMIT_CHECK_UNAVAILABLE");
  });

  test("the limit check is valued on the base asset and the session user id", async () => {
    const seen: { userId: string; assetSymbol: string; amount: Money }[] = [];
    const { deps } = makeDeps({
      checkLimits: async (args) => {
        seen.push(args);
        return allow;
      },
    });
    await placeLimitOrder(deps, placeInput({ side: "BUY", amount: m("0.5") }));
    const call = only(seen);
    assert.equal(call.userId, "user-1");
    assert.equal(call.assetSymbol, "BTC");
    assert.equal(formatMoney(call.amount), "0.5");
  });
});

describe("placeLimitOrder — fee, reserve, and the single atomic RPC", () => {
  test("BUY locks QUOTE = notional + fee and calls the RPC with server-computed params", async () => {
    const { deps, placeCalls } = makeDeps();
    const r = await placeLimitOrder(deps, placeInput({ side: "BUY" }));
    assert.ok(r.ok);
    assert.equal(r.status, "OPEN");
    assert.equal(r.reservedAsset, "USDT");
    assert.equal(formatMoney(r.reservedAmount), "30060"); // 60000×0.5 = 30000, +0.2% = 30060

    const c = only(placeCalls); // exactly one atomic place-and-hold
    assert.equal(c.userId, "user-1"); // from authorize(), never the input
    assert.equal(c.pairId, "pair-1");
    assert.equal(c.side, "BUY");
    assert.equal(c.lockAssetId, "asset-usdt"); // quote asset for a BUY
    assert.equal(formatMoney(c.lockAmount), "30060");
    assert.equal(formatMoney(c.fee), "60");
    assert.equal(formatMoney(c.price), "60000");
    assert.equal(formatMoney(c.amount), "0.5");
    assert.equal(c.clientOrderId, null);
  });

  test("SELL locks BASE = amount; the fee is computed but not added to the reserve", async () => {
    const { deps, placeCalls } = makeDeps();
    const r = await placeLimitOrder(deps, placeInput({ side: "SELL" }));
    assert.ok(r.ok);
    assert.equal(r.reservedAsset, "BTC");
    assert.equal(formatMoney(r.reservedAmount), "0.5");

    const c = only(placeCalls);
    assert.equal(c.side, "SELL");
    assert.equal(c.lockAssetId, "asset-btc"); // base asset for a SELL
    assert.equal(formatMoney(c.lockAmount), "0.5");
    assert.equal(formatMoney(c.fee), "60"); // still computed server-side
  });

  test("the fee comes from resolveFeeRule, not the client — the input has no fee field", async () => {
    const fixed: ResolvedFeeRule = {
      percentage: m("0"),
      fixedFee: m("25"),
      minFee: null,
      maxFee: null,
    };
    const { deps, placeCalls } = makeDeps({ resolveFeeRule: async () => fixed });
    const r = await placeLimitOrder(deps, placeInput({ side: "BUY" }));
    assert.ok(r.ok);
    assert.equal(formatMoney(only(placeCalls).fee), "25");
    assert.equal(formatMoney(r.reservedAmount), "30025"); // 30000 notional + 25 fixed fee
  });

  test("the fee rule is resolved for the quote asset and the user's tier", async () => {
    const seen: { quoteAssetId: string; tierCode: string }[] = [];
    const { deps } = makeDeps({
      resolveFeeRule: async (args) => {
        seen.push(args);
        return feeRule;
      },
    });
    await placeLimitOrder(deps, placeInput());
    assert.deepEqual(only(seen), { quoteAssetId: "asset-usdt", tierCode: "TIER_1" });
  });

  test("a status read of null is reported as OPEN", async () => {
    const { deps } = makeDeps({ readOrder: async () => null });
    const r = await placeLimitOrder(deps, placeInput());
    assert.ok(r.ok && r.status === "OPEN");
  });

  test("the reported status and reserve are the ones the database recorded", async () => {
    const { deps } = makeDeps({
      readOrder: async () => ({ status: "CANCELLED", lockedAsset: "USDT", lockedAmount: m("0") }),
    });
    const r = await placeLimitOrder(deps, placeInput());
    assert.ok(r.ok);
    assert.equal(r.status, "CANCELLED");
    assert.equal(formatMoney(r.reservedAmount), "0"); // what is held now, not what was asked
  });
});

describe("placeLimitOrder — insufficient funds and RPC failures", () => {
  test("the place RPC reporting insufficient funds becomes INSUFFICIENT_BALANCE", async () => {
    const { deps } = makeDeps({
      placeOrder: async () => ({ ok: false, reason: "INSUFFICIENT_BALANCE" }),
    });
    const r = await placeLimitOrder(deps, placeInput());
    assert.ok(!r.ok && r.code === "INSUFFICIENT_BALANCE");
  });

  test("the place RPC reporting the DB trading backstop becomes TRADING_DISABLED", async () => {
    const { deps } = makeDeps({
      placeOrder: async () => ({ ok: false, reason: "TRADING_DISABLED" }),
    });
    const r = await placeLimitOrder(deps, placeInput());
    assert.ok(!r.ok && r.code === "TRADING_DISABLED");
  });

  test("a raw error from the place RPC never leaks; it becomes a generic INTERNAL", async () => {
    const { deps } = makeDeps({
      placeOrder: async () => {
        throw new Error('duplicate key value violates unique constraint "trading_orders_pkey"');
      },
    });
    const r = await withSilencedErrors(() => placeLimitOrder(deps, placeInput()));
    assert.ok(!r.ok && r.code === "INTERNAL");
    assert.equal(r.message, "Something went wrong. Please try again.");
    assert.doesNotMatch(r.message, /constraint|trading_orders|duplicate/);
  });
});

describe("placeLimitOrder — idempotency (spec §20)", () => {
  // A stateful fake place RPC that mirrors place_limit_order's contract: the
  // first call with a client_order_id creates the order and records ONE hold; a
  // later call with the same key returns the original id and records no hold,
  // whatever the rest of the request says. The real guarantee is the SQL unique
  // (user_id, client_order_id) + the dedup_key on the HOLD; this models it.
  function idempotentPlace() {
    const holds: string[] = [];
    const byKey = new Map<string, string>();
    const rows = new Map<string, RecordedOrder>();
    let n = 0;
    const placeOrder: OrderEngineDeps["placeOrder"] = async (params) => {
      const key = params.clientOrderId;
      if (key !== null && byKey.has(key)) {
        return { ok: true, orderId: byKey.get(key)! }; // first wins, no second hold
      }
      const orderId = `order-${++n}`;
      if (key !== null) byKey.set(key, orderId);
      rows.set(orderId, recordedFrom(params));
      holds.push(`order:hold:${orderId}`);
      return { ok: true, orderId };
    };
    const readOrder: OrderEngineDeps["readOrder"] = async (orderId) => rows.get(orderId) ?? null;
    return { placeOrder, readOrder, holds };
  }

  test("a retry with the same client order id places one order and holds exactly once", async () => {
    const { placeOrder, readOrder, holds } = idempotentPlace();
    const { deps } = makeDeps({ placeOrder, readOrder });
    const input = placeInput({ clientOrderId: "idem-1" });

    const first = await placeLimitOrder(deps, input);
    const second = await placeLimitOrder(deps, input);

    assert.ok(first.ok && second.ok);
    assert.equal(first.orderId, second.orderId);
    assert.equal(holds.length, 1); // exactly one HOLD across both calls
  });

  test("the same key with different content returns the original order and holds once", async () => {
    const { placeOrder, readOrder, holds } = idempotentPlace();
    const { deps } = makeDeps({ placeOrder, readOrder });

    const first = await placeLimitOrder(deps, placeInput({ clientOrderId: "idem-2", amount: m("0.5") }));
    const second = await placeLimitOrder(deps, placeInput({ clientOrderId: "idem-2", amount: m("0.9") }));

    assert.ok(first.ok && second.ok);
    assert.equal(second.orderId, first.orderId); // first-wins; no ambiguity, no second hold
    assert.equal(holds.length, 1);
  });

  test("a first-wins replay reports the ORIGINAL order's reserve, not the retry's", async () => {
    const { placeOrder, readOrder } = idempotentPlace();
    const { deps } = makeDeps({ placeOrder, readOrder });

    // 0.5 BTC @ 60000 holds 30060 USDT; the retry asks for 0.9 BTC (54108 USDT)
    // and SELL, but the database kept the first order — so that is the answer.
    const first = await placeLimitOrder(deps, placeInput({ clientOrderId: "idem-3", amount: m("0.5") }));
    const retry = await placeLimitOrder(
      deps,
      placeInput({ clientOrderId: "idem-3", amount: m("0.9"), side: "SELL" }),
    );

    assert.ok(first.ok && retry.ok);
    assert.equal(retry.orderId, first.orderId);
    assert.equal(retry.reservedAsset, "USDT");
    assert.equal(formatMoney(retry.reservedAmount), "30060");
    assert.equal(formatMoney(retry.reservedAmount), formatMoney(first.reservedAmount));
  });

  test("the client order id is passed through to the RPC verbatim", async () => {
    const { deps, placeCalls } = makeDeps();
    await placeLimitOrder(deps, placeInput({ clientOrderId: "my-key-123" }));
    assert.equal(only(placeCalls).clientOrderId, "my-key-123");
  });
});

describe("cancelOrder", () => {
  test("cancelling the caller's own order releases and reports CANCELLED", async () => {
    const seen: { userId: string; orderId: string }[] = [];
    const { deps } = makeDeps({
      cancelOrderRpc: async (userId, orderId) => {
        seen.push({ userId, orderId });
        return true;
      },
    });
    const r = await cancelOrder(deps, { orderId: "order-9" });
    assert.ok(r.ok && r.status === "CANCELLED");
    assert.equal(r.orderId, "order-9");
    // The user id is the session's, never a client field — there is no such input.
    assert.deepEqual(only(seen), { userId: "user-1", orderId: "order-9" });
  });

  test("another user's order cannot be cancelled; the false result never says which", async () => {
    const { deps } = makeDeps({ cancelOrderRpc: async () => false });
    const r = await cancelOrder(deps, { orderId: "someone-elses-order" });
    assert.ok(!r.ok && r.code === "NOT_CANCELLABLE");
    assert.doesNotMatch(r.message, /not found|owner|another|exist/i);
  });

  test("a repeat cancel is a no-op, not an error", async () => {
    let n = 0;
    const { deps } = makeDeps({
      cancelOrderRpc: async () => {
        n += 1;
        return n === 1; // cancels once, then nothing left to cancel
      },
    });
    const first = await cancelOrder(deps, { orderId: "order-9" });
    const second = await cancelOrder(deps, { orderId: "order-9" });
    assert.ok(first.ok);
    assert.ok(!second.ok && second.code === "NOT_CANCELLABLE");
  });

  test("a terminal order (already filled/cancelled) is reported NOT_CANCELLABLE", async () => {
    const { deps } = makeDeps({ cancelOrderRpc: async () => false });
    const r = await cancelOrder(deps, { orderId: "terminal-order" });
    assert.ok(!r.ok && r.code === "NOT_CANCELLABLE");
  });

  test("an unauthenticated cancel is reported and the RPC is never called", async () => {
    let called = false;
    const { deps } = makeDeps({
      authorize: async () => {
        throw new AppError("UNAUTHENTICATED");
      },
      cancelOrderRpc: async () => {
        called = true;
        return true;
      },
    });
    const r = await cancelOrder(deps, { orderId: "order-9" });
    assert.ok(!r.ok && r.code === "UNAUTHENTICATED");
    assert.equal(called, false);
  });

  test("a raw error from the cancel RPC never leaks; it becomes a generic INTERNAL", async () => {
    const { deps } = makeDeps({
      cancelOrderRpc: async () => {
        throw new Error("deadlock detected on relation trading_orders");
      },
    });
    const r = await withSilencedErrors(() => cancelOrder(deps, { orderId: "order-9" }));
    assert.ok(!r.ok && r.code === "INTERNAL");
    assert.doesNotMatch(r.message, /deadlock|trading_orders/);
  });
});

describe("previewOrder — server-computed fee and reserve, without placing", () => {
  test("BUY preview reports notional, fee and the quote reserve", async () => {
    const { deps, placeCalls } = makeDeps();
    const r = await previewOrder(deps, placeInput({ side: "BUY" }));
    assert.ok(r.ok);
    assert.equal(formatMoney(r.preview.notional), "30000");
    assert.equal(formatMoney(r.preview.fee), "60");
    assert.equal(r.preview.reservedAsset, "USDT");
    assert.equal(formatMoney(r.preview.reservedAmount), "30060");
    assert.equal(placeCalls.length, 0); // a preview places nothing and holds nothing
  });

  test("SELL preview reserves the base amount, fee from proceeds", async () => {
    const { deps } = makeDeps();
    const r = await previewOrder(deps, placeInput({ side: "SELL" }));
    assert.ok(r.ok);
    assert.equal(r.preview.reservedAsset, "BTC");
    assert.equal(formatMoney(r.preview.reservedAmount), "0.5");
    assert.equal(formatMoney(r.preview.fee), "60");
  });

  test("preview does not run the tier-limit check (limits are enforced at placement)", async () => {
    const { deps } = makeDeps({
      checkLimits: async () => {
        throw new Error("checkLimits must not be called during a preview");
      },
    });
    const r = await previewOrder(deps, placeInput());
    assert.ok(r.ok); // succeeds despite checkLimits throwing — it is never invoked
  });

  test("an unauthenticated preview is reported, nothing is read further", async () => {
    const { deps } = makeDeps({
      authorize: async () => {
        throw new AppError("UNAUTHENTICATED");
      },
    });
    const r = await previewOrder(deps, placeInput());
    assert.ok(!r.ok && r.code === "UNAUTHENTICATED");
  });

  test("an invalid order previews as a validation failure", async () => {
    const { deps } = makeDeps();
    const r = await previewOrder(deps, placeInput({ amount: m("0") }));
    assert.ok(!r.ok && r.code === "VALIDATION_FAILED");
  });

  test("a trading-disabled market previews as TRADING_DISABLED", async () => {
    const { deps } = makeDeps({ loadPair: async () => pair({ tradingEnabled: false }) });
    const r = await previewOrder(deps, placeInput());
    assert.ok(!r.ok && r.code === "TRADING_DISABLED");
  });
});

describe("security — the engine never trusts privileged values from its input", () => {
  // The input type has no field for a user id, fee, wallet or reserve. These
  // tests force the point at runtime: even an input with those extra keys cast
  // in is ignored — the engine uses authorize()'s user and its own computed fee
  // and reserve. (A real caller cannot even express this; the cast proves the
  // engine reads none of it.)
  const tampered = (over: Record<string, unknown> = {}): PlaceLimitOrderInput =>
    ({
      ...placeInput({ side: "BUY" }),
      userId: "attacker",
      fee: "0",
      lockAmount: "1",
      lockAssetId: "someone-elses-wallet",
      reservedAmount: "0",
      tierCode: "TIER_99",
      status: "ACTIVE",
      ...over,
    }) as unknown as PlaceLimitOrderInput;

  test("the user id comes from authorize(), never the input", async () => {
    const { deps, placeCalls } = makeDeps({ authorize: async () => authorizedUser({ userId: "real-user" }) });
    await placeLimitOrder(deps, tampered());
    assert.equal(only(placeCalls).userId, "real-user");
  });

  test("the fee is recomputed server-side, never taken from the input", async () => {
    const { deps, placeCalls } = makeDeps();
    await placeLimitOrder(deps, tampered({ fee: "0" }));
    assert.equal(formatMoney(only(placeCalls).fee), "60"); // computed 0.2%, not the injected 0
  });

  test("the reserve is computed from the order, never taken from the input", async () => {
    const { deps, placeCalls } = makeDeps();
    await placeLimitOrder(deps, tampered({ lockAmount: "1" }));
    const c = only(placeCalls);
    assert.equal(formatMoney(c.lockAmount), "30060"); // notional + fee, not the injected 1
    assert.equal(c.lockAssetId, "asset-usdt"); // from the pair, not the injected wallet id
  });
});

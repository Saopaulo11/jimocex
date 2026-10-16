import "server-only";

import { moneySelect } from "@/lib/db/money-columns";
import { moneyArgs } from "@/lib/db/money-write";
import { fromDatabase, fromDatabaseNullable } from "@/lib/money";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireVerifiedUser } from "@/lib/auth/session";

import { checkEligibility } from "./limit-engine";
import {
  cancelOrder as engineCancelOrder,
  placeLimitOrder as enginePlaceLimitOrder,
  previewOrder as enginePreviewOrder,
  type AuthorizedUser,
  type CancelResult,
  type OrderEngineDeps,
  type OrderStatus,
  type PlaceLimitOrderInput,
  type PlaceResult,
  type PlaceRpcResult,
  type PreviewResult,
  type RecordedOrder,
  type ResolvedPair,
} from "./order-engine";
import type { ResolvedFeeRule } from "./fee-rules";

/**
 * The real wiring for the order engine (spec §19).
 *
 * `order-engine.ts` is a pure orchestrator over `OrderEngineDeps` ports. This
 * module is the only place those ports touch the outside world — the session,
 * the service-role database, the fee table. It is `server-only`, so it can
 * never reach the browser bundle, and it holds no decision logic of its own:
 * every rule lives in the engine or in the SQL function it calls.
 *
 * TRUST BOUNDARY. The user id comes from `requireVerifiedUser()` (the DAL,
 * which reads `auth.getUser()`), never from the request. It is the only user id
 * handed to any adapter. The service-role RPC `place_limit_order` receives that
 * verified id as `p_user_id`; a client has no way to name another wallet or
 * owner, because no client value reaches `p_user_id` or `p_lock_asset_id` — the
 * engine computes the lock asset from the resolved pair, and the fee and reserve
 * are recomputed here, server-side, with no field for a client to supply them.
 */

/** The TRADE fee is charged on the quote-asset notional (spec §26). */
const FEE_OPERATION = "TRADE" as const;
const LIMIT_OPERATION = "TRADE" as const;

type Admin = ReturnType<typeof createAdminClient>;

/**
 * Builds the live ports over a fresh service-role client. One client per call,
 * matching the per-request pattern the rest of the data layer uses; the client
 * is cheap to construct and must not be shared across requests.
 */
function buildServerDeps(): OrderEngineDeps {
  const admin = createAdminClient();

  return {
    authorize: () => authorize(),
    loadPair: (symbol) => loadPair(admin, symbol),
    checkLimits: ({ userId, assetSymbol, amount }) =>
      checkEligibility({ userId, operation: LIMIT_OPERATION, assetSymbol, amount }),
    resolveFeeRule: ({ quoteAssetId, tierCode }) => resolveFeeRule(admin, quoteAssetId, tierCode),
    placeOrder: (params) => placeOrder(admin, params),
    readOrder: (orderId) => readOrder(admin, orderId),
    cancelOrderRpc: (userId, orderId) => cancelOrderRpc(admin, userId, orderId),
  };
}

/**
 * Places a LIMIT order for the signed-in user. The only entry point a Server
 * Action needs. Identity, validation, limits, fee and reserve are all resolved
 * server-side; `input` carries no fee, lock, wallet or user id.
 */
export async function placeLimitOrder(input: PlaceLimitOrderInput): Promise<PlaceResult> {
  return enginePlaceLimitOrder(buildServerDeps(), input);
}

/**
 * Computes the fee and reserve the signed-in user's order would incur, without
 * placing it. Read-only: the form shows this before the customer commits, and it
 * runs the same server-side computation placement will.
 */
export async function previewLimitOrder(input: PlaceLimitOrderInput): Promise<PreviewResult> {
  return enginePreviewOrder(buildServerDeps(), input);
}

/** Cancels one of the signed-in user's own orders and releases its hold. */
export async function cancelOrder(input: { orderId: string }): Promise<CancelResult> {
  return engineCancelOrder(buildServerDeps(), input);
}

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

/** The verified, active, email-confirmed user, mapped to the engine's shape. */
async function authorize(): Promise<AuthorizedUser> {
  const viewer = await requireVerifiedUser();
  return {
    userId: viewer.userId,
    tierCode: viewer.profile.tier_code,
    status: viewer.profile.status,
  };
}

/**
 * Resolves a tradable pair to `ResolvedPair`. Only `is_active` pairs are real
 * markets, so an inactive or unknown symbol returns null — reported to the user
 * as "market not found" without revealing which. `trading_enabled` is carried
 * through unchanged: a visible-but-disabled market reaches the engine and is
 * refused there as TRADING_DISABLED.
 */
async function loadPair(admin: Admin, symbol: string): Promise<ResolvedPair | null> {
  const { data, error } = await admin
    .from("trading_pairs")
    .select(
      moneySelect(
        "trading_pairs",
        "id, symbol, trading_enabled, price_precision, amount_precision, min_order_size, max_order_size, base_asset_id, quote_asset_id, base:base_asset_id(symbol), quote:quote_asset_id(symbol)",
      ),
    )
    .eq("symbol", symbol)
    .eq("is_active", true)
    .maybeSingle()
    .overrideTypes<
      {
        id: string;
        symbol: string;
        trading_enabled: boolean;
        price_precision: number;
        amount_precision: number;
        min_order_size: string;
        max_order_size: string | null;
        base_asset_id: string;
        quote_asset_id: string;
        base: { symbol: string } | null;
        quote: { symbol: string } | null;
      },
      { merge: false }
    >();

  if (error) throw new Error(`loadPair(${symbol}): ${error.message}`);
  if (!data) return null;

  const base = data.base?.symbol;
  const quote = data.quote?.symbol;
  // A pair whose asset rows cannot be read is not a usable market; treat it as
  // not found rather than placing an order against an unknown asset.
  if (!base || !quote) return null;

  return {
    symbol: data.symbol,
    baseAsset: base,
    quoteAsset: quote,
    tradingEnabled: data.trading_enabled,
    pricePrecision: data.price_precision,
    amountPrecision: data.amount_precision,
    minOrderSize: fromDatabase(data.min_order_size, "trading_pairs.min_order_size"),
    maxOrderSize: fromDatabaseNullable(data.max_order_size, "trading_pairs.max_order_size"),
    pairId: data.id,
    baseAssetId: data.base_asset_id,
    quoteAssetId: data.quote_asset_id,
  };
}

/**
 * The most specific active TRADE fee rule for the quote asset and the user's
 * tier. `fee_rules` allows NULL asset_id / tier_code as "any", with a more
 * specific row overriding; this reads the four candidates and picks the most
 * specific, asset taking precedence over tier. A trade with no configured fee
 * policy is a server misconfiguration, not a free trade — it throws (reported as
 * INTERNAL) rather than charging nothing.
 */
async function resolveFeeRule(
  admin: Admin,
  quoteAssetId: string,
  tierCode: string,
): Promise<ResolvedFeeRule> {
  const { data, error } = await admin
    .from("fee_rules")
    .select(moneySelect("fee_rules", "asset_id, tier_code, percentage, fixed_fee, min_fee, max_fee"))
    .eq("operation", FEE_OPERATION)
    .eq("is_active", true)
    .or(`asset_id.eq.${quoteAssetId},asset_id.is.null`)
    .or(`tier_code.eq.${tierCode},tier_code.is.null`)
    .overrideTypes<
      {
        asset_id: string | null;
        tier_code: string | null;
        percentage: string;
        fixed_fee: string;
        min_fee: string | null;
        max_fee: string | null;
      }[],
      { merge: false }
    >();

  if (error) throw new Error(`resolveFeeRule: ${error.message}`);

  const specificity = (row: { asset_id: string | null; tier_code: string | null }): number =>
    (row.asset_id === quoteAssetId ? 2 : 0) + (row.tier_code === tierCode ? 1 : 0);

  const best = (data ?? []).reduce<(typeof data)[number] | null>((winner, row) => {
    if (winner === null || specificity(row) > specificity(winner)) return row;
    return winner;
  }, null);

  if (!best) {
    throw new Error(`resolveFeeRule: no active ${FEE_OPERATION} fee rule for asset ${quoteAssetId}, tier ${tierCode}`);
  }

  return {
    percentage: fromDatabase(best.percentage, "fee_rules.percentage"),
    fixedFee: fromDatabase(best.fixed_fee, "fee_rules.fixed_fee"),
    minFee: fromDatabaseNullable(best.min_fee, "fee_rules.min_fee"),
    maxFee: fromDatabaseNullable(best.max_fee, "fee_rules.max_fee"),
  };
}

/**
 * The single atomic place-and-hold RPC. Business failures the user can provoke
 * become a typed `PlaceRpcResult`; anything else throws, so the engine reports a
 * generic INTERNAL and the raw database error never reaches the caller.
 *
 * Idempotency under a race: `place_limit_order` checks for an existing order by
 * `(user_id, client_order_id)` before inserting, but two concurrent retries can
 * both pass that check and the second hits the unique constraint. On that
 * conflict we re-read the winner and return its id — the first-wins contract,
 * with no second hold.
 */
async function placeOrder(admin: Admin, params: Parameters<OrderEngineDeps["placeOrder"]>[0]): Promise<PlaceRpcResult> {
  const { data, error } = await admin.rpc(
    "place_limit_order",
    moneyArgs("place_limit_order", {
      p_user_id: params.userId,
      p_pair_id: params.pairId,
      p_side: params.side,
      p_price: params.price,
      p_amount: params.amount,
      p_lock_asset_id: params.lockAssetId,
      p_lock_amount: params.lockAmount,
      p_client_order_id: params.clientOrderId ?? undefined,
      p_fee: params.fee,
    }),
  );

  if (error) {
    // Idempotency conflict: a concurrent retry with the same key won the insert.
    if (error.code === "23505" && params.clientOrderId !== null) {
      const existing = await readOrderIdByClientOrderId(admin, params.userId, params.clientOrderId);
      if (existing) return { ok: true, orderId: existing };
    }
    // The DB's own trading-enabled backstop (the engine refuses this first).
    if (error.code === "23514" && /trading is disabled/i.test(error.message)) {
      return { ok: false, reason: "TRADING_DISABLED" };
    }
    // The wallet overdraft guard: a HOLD that would drive available below zero.
    if (error.code === "23514" && /wallets_available_non_negative|wallets_locked_non_negative/.test(error.message)) {
      return { ok: false, reason: "INSUFFICIENT_BALANCE" };
    }
    // Anything else (a precision backstop, a constraint the engine should have
    // prevented, a transport failure) is unexpected: log it and surface INTERNAL.
    console.error("[order-engine.server] place_limit_order failed", { code: error.code, message: error.message });
    throw new Error(`place_limit_order failed: ${error.code}`);
  }

  if (!data) throw new Error("place_limit_order returned no order id");
  return { ok: true, orderId: data };
}

async function readOrderIdByClientOrderId(
  admin: Admin,
  userId: string,
  clientOrderId: string,
): Promise<string | null> {
  const { data, error } = await admin
    .from("trading_orders")
    .select("id")
    .eq("user_id", userId)
    .eq("client_order_id", clientOrderId)
    .maybeSingle();

  if (error) throw new Error(`readOrderIdByClientOrderId: ${error.message}`);
  return data?.id ?? null;
}

/**
 * Reads back the placed order as the database recorded it — status, locked
 * asset and locked amount — so the engine reports the real reserve (never
 * fabricated, and never this request's figures on a first-wins replay).
 */
async function readOrder(admin: Admin, orderId: string): Promise<RecordedOrder | null> {
  const { data, error } = await admin
    .from("trading_orders")
    .select(moneySelect("trading_orders", "status, locked_amount, locked:locked_asset_id(symbol)"))
    .eq("id", orderId)
    .maybeSingle()
    .overrideTypes<
      { status: OrderStatus; locked_amount: string; locked: { symbol: string } | null },
      { merge: false }
    >();

  if (error) throw new Error(`readOrder(${orderId}): ${error.message}`);
  if (!data) return null;
  return {
    status: data.status,
    lockedAsset: data.locked?.symbol ?? null,
    lockedAmount: fromDatabase(data.locked_amount, "trading_orders.locked_amount"),
  };
}

/**
 * The atomic cancel RPC. Returns the function's boolean verbatim: true if it
 * cancelled, false for a terminal, unknown or foreign order (the engine reports
 * all three as NOT_CANCELLABLE without distinction). A malformed order id is the
 * same non-leaking "nothing to cancel" outcome rather than an internal error.
 */
async function cancelOrderRpc(admin: Admin, userId: string, orderId: string): Promise<boolean> {
  const { data, error } = await admin.rpc("cancel_order", {
    p_user_id: userId,
    p_order_id: orderId,
  });

  if (error) {
    if (error.code === "22P02") return false; // invalid uuid: nothing to cancel
    throw new Error(`cancel_order failed: ${error.code}`);
  }
  return data === true;
}

// Re-export the input/result types so a Server Action imports one module.
export type {
  PlaceLimitOrderInput,
  PlaceResult,
  CancelResult,
  PreviewResult,
  OrderPreview,
  OrderErrorCode,
  OrderStatus,
} from "./order-engine";

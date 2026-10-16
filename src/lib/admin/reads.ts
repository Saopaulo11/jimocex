import "server-only";

import { moneySelect } from "@/lib/db/money-columns";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Operator-console reads (Slice 7.12).
 *
 * These run through the SERVICE-ROLE client and therefore bypass RLS — so every
 * page that calls them MUST gate the request with `requireAdmin()` first (the
 * admin layout does, and sensitive pages re-check). This is the pattern
 * migration 010 documents: the admin surface reads as service_role after an
 * `is_admin()`-style check in the application, because there are no admin RLS
 * policies by design.
 *
 * This module READS ONLY. The operator console never writes a balance or a
 * ledger row; any financial mutation goes through the existing server-side
 * primitives (ledger_post, the order engine, apply_fill), never a table write
 * from here. Money columns are cast to text by `moneySelect` so the exact
 * decimal survives; admin tables display those strings directly.
 */

/** Await a head+count query and return its count, tolerating errors. */
async function toCount(query: PromiseLike<{ count: number | null }>): Promise<number> {
  try {
    const { count } = await query;
    return count ?? 0;
  } catch {
    return 0;
  }
}

export type AdminStats = {
  users: number;
  orders: number;
  openOrders: number;
  trades: number;
  deposits: number;
  withdrawals: number;
  pendingWithdrawals: number;
};

export async function getAdminStats(): Promise<AdminStats> {
  const admin = createAdminClient();
  // Count on the id column (never "*") so the money-column guard stays satisfied;
  // head:true returns no rows anyway.
  const head = { count: "exact" as const, head: true };
  const [users, orders, openOrders, trades, deposits, withdrawals, pendingWithdrawals] = await Promise.all([
    toCount(admin.from("profiles").select("id", head)),
    toCount(admin.from("trading_orders").select("id", head)),
    toCount(admin.from("trading_orders").select("id", head).in("status", ["PENDING", "OPEN", "PARTIALLY_FILLED"])),
    toCount(admin.from("trades").select("id", head)),
    toCount(admin.from("deposits").select("id", head)),
    toCount(admin.from("withdrawals").select("id", head)),
    toCount(admin.from("withdrawals").select("id", head).in("status", ["REQUESTED", "PENDING_REVIEW", "APPROVED", "PROCESSING"])),
  ]);
  return { users, orders, openOrders, trades, deposits, withdrawals, pendingWithdrawals };
}

export type AdminUserRow = {
  userId: string;
  email: string;
  displayName: string | null;
  status: string;
  tier: string;
  kyc: string;
  createdAt: string;
};

export async function listUsers(limit = 100): Promise<AdminUserRow[]> {
  try {
    const admin = createAdminClient();
    const { data } = await admin
      .from("profiles")
      .select("user_id, email, display_name, status, tier_code, kyc_status, created_at")
      .order("created_at", { ascending: false })
      .limit(limit);
    return (data ?? []).map((r) => ({
      userId: r.user_id,
      email: r.email,
      displayName: r.display_name,
      status: r.status,
      tier: r.tier_code,
      kyc: r.kyc_status,
      createdAt: r.created_at,
    }));
  } catch {
    return [];
  }
}

export type AdminUserDetail = {
  profile: AdminUserRow;
  wallets: { symbol: string; available: string; locked: string }[];
};

export async function getUserDetail(userId: string): Promise<AdminUserDetail | null> {
  try {
    const admin = createAdminClient();
    const { data: p } = await admin
      .from("profiles")
      .select("user_id, email, display_name, status, tier_code, kyc_status, created_at")
      .eq("user_id", userId)
      .maybeSingle();
    if (!p) return null;

    const { data: wallets } = await admin
      .from("wallets")
      .select(moneySelect("wallets", "available_balance, locked_balance, asset:asset_id(symbol)"))
      .eq("user_id", userId)
      .overrideTypes<{ available_balance: string; locked_balance: string; asset: { symbol: string } | null }[], { merge: false }>();

    return {
      profile: {
        userId: p.user_id,
        email: p.email,
        displayName: p.display_name,
        status: p.status,
        tier: p.tier_code,
        kyc: p.kyc_status,
        createdAt: p.created_at,
      },
      wallets: (wallets ?? []).flatMap((w) =>
        w.asset ? [{ symbol: w.asset.symbol, available: w.available_balance, locked: w.locked_balance }] : [],
      ),
    };
  } catch {
    return null;
  }
}

export type AdminOrderRow = {
  id: string;
  userId: string;
  pair: string;
  side: string;
  type: string;
  price: string | null;
  amount: string;
  filled: string;
  status: string;
  createdAt: string;
};

export async function listOrders(limit = 100): Promise<AdminOrderRow[]> {
  try {
    const admin = createAdminClient();
    const { data } = await admin
      .from("trading_orders")
      .select(moneySelect("trading_orders", "id, user_id, side, type, price, amount, filled_amount, status, created_at, pair:pair_id(symbol)"))
      .order("created_at", { ascending: false })
      .limit(limit)
      .overrideTypes<
        {
          id: string;
          user_id: string;
          side: string;
          type: string;
          price: string | null;
          amount: string;
          filled_amount: string;
          status: string;
          created_at: string;
          pair: { symbol: string } | null;
        }[],
        { merge: false }
      >();
    return (data ?? []).map((r) => ({
      id: r.id,
      userId: r.user_id,
      pair: r.pair?.symbol ?? "—",
      side: r.side,
      type: r.type,
      price: r.price,
      amount: r.amount,
      filled: r.filled_amount,
      status: r.status,
      createdAt: r.created_at,
    }));
  } catch {
    return [];
  }
}

export type AdminTradeRow = {
  id: string;
  providerTradeId: string | null;
  pair: string;
  price: string;
  amount: string;
  quote: string;
  fee: string;
  settledAt: string | null;
  createdAt: string;
};

export async function listTrades(limit = 100): Promise<AdminTradeRow[]> {
  try {
    const admin = createAdminClient();
    const { data } = await admin
      .from("trades")
      .select(moneySelect("trades", "id, provider_trade_id, price, amount, quote_amount, fee, settled_at, created_at, pair:pair_id(symbol)"))
      .order("created_at", { ascending: false })
      .limit(limit)
      .overrideTypes<
        {
          id: string;
          provider_trade_id: string | null;
          price: string;
          amount: string;
          quote_amount: string;
          fee: string;
          settled_at: string | null;
          created_at: string;
          pair: { symbol: string } | null;
        }[],
        { merge: false }
      >();
    return (data ?? []).map((r) => ({
      id: r.id,
      providerTradeId: r.provider_trade_id,
      pair: r.pair?.symbol ?? "—",
      price: r.price,
      amount: r.amount,
      quote: r.quote_amount,
      fee: r.fee,
      settledAt: r.settled_at,
      createdAt: r.created_at,
    }));
  } catch {
    return [];
  }
}

export type AdminDepositRow = {
  id: string;
  userId: string;
  symbol: string;
  network: string | null;
  amount: string;
  status: string;
  confirmations: number;
  createdAt: string;
};

export async function listDeposits(limit = 100): Promise<AdminDepositRow[]> {
  try {
    const admin = createAdminClient();
    const { data } = await admin
      .from("deposits")
      .select(moneySelect("deposits", "id, user_id, network, amount, status, confirmations, created_at, asset:asset_id(symbol)"))
      .order("created_at", { ascending: false })
      .limit(limit)
      .overrideTypes<
        {
          id: string;
          user_id: string;
          network: string | null;
          amount: string;
          status: string;
          confirmations: number;
          created_at: string;
          asset: { symbol: string } | null;
        }[],
        { merge: false }
      >();
    return (data ?? []).map((r) => ({
      id: r.id,
      userId: r.user_id,
      symbol: r.asset?.symbol ?? "—",
      network: r.network,
      amount: r.amount,
      status: r.status,
      confirmations: r.confirmations,
      createdAt: r.created_at,
    }));
  } catch {
    return [];
  }
}

export type AdminWithdrawalRow = {
  id: string;
  userId: string;
  symbol: string;
  network: string | null;
  amount: string;
  fee: string;
  destination: string;
  status: string;
  createdAt: string;
};

export async function listWithdrawals(limit = 100): Promise<AdminWithdrawalRow[]> {
  try {
    const admin = createAdminClient();
    const { data } = await admin
      .from("withdrawals")
      .select(moneySelect("withdrawals", "id, user_id, network, amount, fee, destination, status, created_at, asset:asset_id(symbol)"))
      .order("created_at", { ascending: false })
      .limit(limit)
      .overrideTypes<
        {
          id: string;
          user_id: string;
          network: string | null;
          amount: string;
          fee: string;
          destination: string;
          status: string;
          created_at: string;
          asset: { symbol: string } | null;
        }[],
        { merge: false }
      >();
    return (data ?? []).map((r) => ({
      id: r.id,
      userId: r.user_id,
      symbol: r.asset?.symbol ?? "—",
      network: r.network,
      amount: r.amount,
      fee: r.fee,
      destination: r.destination,
      status: r.status,
      createdAt: r.created_at,
    }));
  } catch {
    return [];
  }
}

export type AdminAssetRow = {
  symbol: string;
  name: string;
  type: string;
  decimals: number;
  isActive: boolean;
};

export async function listAssetsAdmin(): Promise<AdminAssetRow[]> {
  try {
    const admin = createAdminClient();
    const { data } = await admin.from("assets").select("symbol, name, type, decimals, is_active").order("type").order("symbol");
    return (data ?? []).map((r) => ({ symbol: r.symbol, name: r.name, type: r.type, decimals: r.decimals, isActive: r.is_active }));
  } catch {
    return [];
  }
}

export type AdminPairRow = {
  symbol: string;
  type: string;
  tradingEnabled: boolean;
  swapEnabled: boolean;
  pricePrecision: number;
  amountPrecision: number;
  minOrderSize: string;
};

export async function listPairsAdmin(): Promise<AdminPairRow[]> {
  try {
    const admin = createAdminClient();
    const { data } = await admin
      .from("trading_pairs")
      .select(moneySelect("trading_pairs", "symbol, pair_type, trading_enabled, swap_enabled, price_precision, amount_precision, min_order_size"))
      .order("display_order")
      .overrideTypes<
        {
          symbol: string;
          pair_type: string;
          trading_enabled: boolean;
          swap_enabled: boolean;
          price_precision: number;
          amount_precision: number;
          min_order_size: string;
        }[],
        { merge: false }
      >();
    return (data ?? []).map((r) => ({
      symbol: r.symbol,
      type: r.pair_type,
      tradingEnabled: r.trading_enabled,
      swapEnabled: r.swap_enabled,
      pricePrecision: r.price_precision,
      amountPrecision: r.amount_precision,
      minOrderSize: r.min_order_size,
    }));
  } catch {
    return [];
  }
}

export type AdminKycRow = {
  id: string;
  userId: string;
  status: string;
  providerKind: string;
  targetTier: string | null;
  createdAt: string;
};

export async function listKyc(limit = 100): Promise<AdminKycRow[]> {
  try {
    const admin = createAdminClient();
    const { data } = await admin
      .from("kyc_verifications")
      .select("id, user_id, status, provider_kind, target_tier_code, created_at")
      .order("created_at", { ascending: false })
      .limit(limit);
    return (data ?? []).map((r) => ({
      id: r.id,
      userId: r.user_id,
      status: r.status,
      providerKind: r.provider_kind,
      targetTier: r.target_tier_code,
      createdAt: r.created_at,
    }));
  } catch {
    return [];
  }
}

export type AdminFeeRow = {
  operation: string;
  asset: string;
  tier: string;
  percentage: string;
  fixedFee: string;
  isActive: boolean;
};

export async function listFeeRulesAdmin(): Promise<AdminFeeRow[]> {
  try {
    const admin = createAdminClient();
    const { data } = await admin
      .from("fee_rules")
      .select(moneySelect("fee_rules", "operation, tier_code, percentage, fixed_fee, is_active, asset:asset_id(symbol)"))
      .order("operation")
      .overrideTypes<
        {
          operation: string;
          tier_code: string | null;
          percentage: string;
          fixed_fee: string;
          is_active: boolean;
          asset: { symbol: string } | null;
        }[],
        { merge: false }
      >();
    return (data ?? []).map((r) => ({
      operation: r.operation,
      asset: r.asset?.symbol ?? "All",
      tier: r.tier_code ?? "All",
      percentage: r.percentage,
      fixedFee: r.fixed_fee,
      isActive: r.is_active,
    }));
  } catch {
    return [];
  }
}

export type AdminLimitRow = {
  tier: string;
  operation: string;
  window: string;
  currency: string;
  max: string | null;
};

export async function listTierLimitsAdmin(): Promise<AdminLimitRow[]> {
  try {
    const admin = createAdminClient();
    const { data } = await admin
      .from("tier_limits")
      .select(moneySelect("tier_limits", "tier_code, operation, window_kind, quote_currency, max_amount, is_active"))
      .eq("is_active", true)
      .order("tier_code")
      .overrideTypes<
        {
          tier_code: string;
          operation: string;
          window_kind: string;
          quote_currency: string;
          max_amount: string | null;
          is_active: boolean;
        }[],
        { merge: false }
      >();
    return (data ?? []).map((r) => ({
      tier: r.tier_code,
      operation: r.operation,
      window: r.window_kind,
      currency: r.quote_currency,
      max: r.max_amount,
    }));
  } catch {
    return [];
  }
}

export type AdminAuditRow = {
  id: string;
  action: string;
  actorType: string;
  entityType: string | null;
  entityId: string | null;
  createdAt: string;
};

export async function listAudit(limit = 100): Promise<AdminAuditRow[]> {
  try {
    const admin = createAdminClient();
    const { data } = await admin
      .from("audit_logs")
      .select("id, action, actor_type, entity_type, entity_id, created_at")
      .order("created_at", { ascending: false })
      .limit(limit);
    return (data ?? []).map((r) => ({
      id: r.id,
      action: r.action,
      actorType: r.actor_type,
      entityType: r.entity_type,
      entityId: r.entity_id,
      createdAt: r.created_at,
    }));
  } catch {
    return [];
  }
}

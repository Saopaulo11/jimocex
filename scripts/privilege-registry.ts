/**
 * The exact privileges every role holds in schema `public`, per privilege profile.
 *
 * scripts/check-privileges.ts compares this with the catalog of the database the
 * migrations built (run by scripts/test-db.sh) and fails on any difference: a
 * privilege granted but not listed here, a privilege listed here but missing, a
 * relation or function this registry does not know, an entry for one that does
 * not exist, a column-level grant, an EXECUTE right, a grant to any other role.
 *
 * Profiles:
 *   017 — what migrations 001–017 build: the repository today, and the default.
 *   019 — the reviewed draft of migration 019 (docs/review-019-privileges.md),
 *         applied on top with JIMOCEX_EXTRA_SQL=<draft> JIMOCEX_PRIVILEGE_PROFILE=019.
 * When 019 is adopted it becomes the only profile, and DB_FUNCTIONS.executors
 * takes the 019 executors below.
 *
 * Letters: S select · I insert · U update · D delete · T truncate ·
 * R references · G trigger · M maintain (PostgreSQL 17+; not checked on 16).
 * PUBLIC holds nothing anywhere, in every profile.
 *
 * Also pinned, the same in both profiles: the client roles' attributes and
 * every membership involving them (SET-only included), USAGE/CREATE on schema
 * public, which functions are SECURITY DEFINER and that every function pins
 * search_path, FORCE ROW LEVEL SECURITY, every RLS policy whole, and that no
 * client role owns a table or function.
 *
 * Outside this registry (see docs/review-019-privileges.md, "Outside the
 * model"): schemas other than public; default privileges for tables and
 * sequences (B2); roles other than the three client roles and their
 * predefined-role memberships; triggers, which the invariant suite exercises
 * instead; who owns an object beyond "not a client role".
 */

import { DB_FUNCTIONS, TRIGGER_FUNCTIONS } from "../src/lib/db/money-columns.ts";

export const PRIVILEGE_PROFILES = ["017", "019"] as const;
export type PrivilegeProfile = (typeof PRIVILEGE_PROFILES)[number];

export const ROLES = ["anon", "authenticated", "service_role"] as const;
export type Role = (typeof ROLES)[number];

export const TABLE_PRIVILEGE_LETTERS = {
  SELECT: "S",
  INSERT: "I",
  UPDATE: "U",
  DELETE: "D",
  TRUNCATE: "T",
  REFERENCES: "R",
  TRIGGER: "G",
  MAINTAIN: "M",
} as const;

type TableGrants = Record<string, Record<Role, string>>;
export type ColumnGrant = { table: string; column: string; grantee: Role; privilege: "SELECT" | "INSERT" | "UPDATE" | "REFERENCES" };

const all = (anon: string, authenticated: string, service_role: string) => ({ anon, authenticated, service_role });

/* ------------------------------------------------------------------- 017 */

// Supabase grants anon, authenticated and service_role every privilege on a table
// postgres creates in public; 004/010/017 narrowed the money tables. RLS is what
// keeps the rest closed (docs/proposal-table-privileges.md, "What clients hold today").
const TABLES_017: TableGrants = {
  account_tiers: all("SIUDTRGM", "SIUDTRGM", "SIUDTRGM"),
  asset_networks: all("SIUDTRGM", "SIUDTRGM", "SIUDTRGM"),
  assets: all("SIUDTRGM", "SIUDTRGM", "SIUDTRGM"),
  admin_users: all("SIUDTRGM", "SIUDTRGM", "SIUDTRGM"),
  profiles: all("SIUDTRGM", "SIUDTRGM", "SIUDTRGM"),
  notifications: all("SUTRGM", "SUTRGM", "SIUDTRGM"),
  audit_logs: all("STRGM", "STRGM", "SIUDTRGM"),
  idempotency_keys: all("STRGM", "STRGM", "SIUDTRGM"),
  provider_events: all("STRGM", "STRGM", "SIUDTRGM"),
  risk_events: all("STRGM", "STRGM", "SIUDTRGM"),
  kyc_verifications: all("STRGM", "STRGM", "SIUDTRGM"),
  fee_rules: all("SRGM", "SRGM", "SIUDRGM"),
  tier_limits: all("SRGM", "SRGM", "SIUDRGM"),
  trading_pairs: all("SRGM", "SRGM", "SIUDRGM"),
  deposits: all("SRGM", "SRGM", "SIUDRGM"),
  limit_usage: all("SRGM", "SRGM", "SIUDRGM"),
  swap_orders: all("SRGM", "SRGM", "SIUDRGM"),
  swap_quotes: all("SRGM", "SRGM", "SIUDRGM"),
  trades: all("SRGM", "SRGM", "SIUDRGM"),
  trading_orders: all("SRGM", "SRGM", "SIUDRGM"),
  withdrawals: all("SRGM", "SRGM", "SIUDRGM"),
  wallets: all("SRGM", "SRGM", "SRGM"),
  ledger_entries: all("SRGM", "SRGM", "SRGM"),
};

/* ------------------------------------------------------------------- 019 */

// Client roles: exactly what their RLS policies use. service_role: data
// privileges only, minus what an append-only trigger refuses anyway.
const REFERENCE = all("S", "S", "SIUD"); // policy: SELECT to anon, authenticated
const OWN_READ = all("", "S", "SIUD"); // policy: SELECT own rows to authenticated
const SERVER_ONLY = all("", "", "SIUD"); // RLS on, no policy
const TABLES_019: TableGrants = {
  account_tiers: REFERENCE,
  asset_networks: REFERENCE,
  assets: REFERENCE,
  fee_rules: REFERENCE,
  tier_limits: REFERENCE,
  trading_pairs: REFERENCE,
  admin_users: OWN_READ,
  deposits: OWN_READ,
  kyc_verifications: OWN_READ,
  // UPDATE own row by policy, narrowed to columns below.
  notifications: OWN_READ,
  profiles: OWN_READ,
  swap_orders: OWN_READ,
  swap_quotes: OWN_READ,
  trades: OWN_READ,
  trading_orders: OWN_READ,
  withdrawals: OWN_READ,
  // Balances move only through ledger_post (SECURITY DEFINER).
  wallets: all("", "S", "S"),
  ledger_entries: all("", "S", "S"),
  // Append-only: UPDATE/DELETE refused by forbid_mutation for every role.
  limit_usage: all("", "S", "SI"),
  audit_logs: all("", "", "SI"),
  // Append-only for DELETE only; review state may be updated by the server.
  risk_events: all("", "", "SIU"),
  idempotency_keys: SERVER_ONLY,
  provider_events: SERVER_ONLY,
};

// The columns the guard triggers let a row's owner change.
const COLUMNS_019: ColumnGrant[] = [
  { table: "notifications", column: "read_at", grantee: "authenticated", privilege: "UPDATE" },
  { table: "notifications", column: "status", grantee: "authenticated", privilege: "UPDATE" },
  { table: "profiles", column: "country_code", grantee: "authenticated", privilege: "UPDATE" },
  { table: "profiles", column: "display_name", grantee: "authenticated", privilege: "UPDATE" },
];

/* ------------------------------------------------------------- functions */

type FunctionName = keyof typeof DB_FUNCTIONS | (typeof TRIGGER_FUNCTIONS)[number];
type Executors = { executors: readonly Role[]; calledFrom: string };

const NO_CALLER_YET = "no application call yet";

/**
 * Who calls each function, and so who may execute it, in the target model (019).
 * `calledFrom` is the evidence: the call site in the application, or why there
 * is none. A trigger function is called by PostgreSQL only and needs no grant.
 */
const FUNCTIONS_019: Record<FunctionName, Executors> = {
  limit_usage_total: {
    executors: ["service_role"],
    calledFrom: "src/lib/engines/limit-engine.ts usageInWindow(), createAdminClient() — the one RPC the application makes",
  },
  ledger_post: {
    executors: ["service_role"],
    calledFrom: `the only way to move a balance (004, 017; src/lib/db/money-write.ts moneyArgs("ledger_post")); ${NO_CALLER_YET}. release_withdrawal_hold calls it as its owner and needs no grant`,
  },
  consume_quote: { executors: ["service_role"], calledFrom: `server swap execution (006, 017); ${NO_CALLER_YET}` },
  reconcile_wallets: { executors: ["service_role"], calledFrom: `server reconciliation (004, 016, 017); ${NO_CALLER_YET}` },
  claim_deposit_for_credit: { executors: ["service_role"], calledFrom: `deposit-credit webhook (007); ${NO_CALLER_YET}` },
  claim_provider_event: { executors: ["service_role"], calledFrom: `provider webhook de-duplication (009); ${NO_CALLER_YET}` },
  expire_stale_quotes: { executors: ["service_role"], calledFrom: `scheduled quote expiry (006); ${NO_CALLER_YET}` },
  mark_trade_settled: { executors: ["service_role"], calledFrom: `trade settlement (005); ${NO_CALLER_YET}` },
  release_withdrawal_hold: { executors: ["service_role"], calledFrom: `failed-withdrawal release (007); ${NO_CALLER_YET}` },
  // Both answer for auth.uid(); the service_role key carries no user, so for
  // service_role they always return false. No RLS policy calls them (checked by
  // check-privileges.ts), and requireAdmin() reads admin_users instead.
  is_admin: { executors: [], calledFrom: "nothing: no policy, no application code" },
  has_admin_role: { executors: [], calledFrom: "nothing: no policy, no application code" },
  forbid_mutation: { executors: [], calledFrom: "trigger" },
  guard_notification_columns: { executors: [], calledFrom: "trigger" },
  guard_order_status_transition: { executors: [], calledFrom: "trigger" },
  guard_profile_privileged_columns: { executors: [], calledFrom: "trigger" },
  guard_swap_status_transition: { executors: [], calledFrom: "trigger" },
  guard_withdrawal_status_transition: { executors: [], calledFrom: "trigger" },
  handle_new_user: { executors: [], calledFrom: "trigger on auth.users" },
  touch_updated_at: { executors: [], calledFrom: "trigger" },
};

// 017: the executors DB_FUNCTIONS records today (service_role on all eleven,
// is_admin and has_admin_role included, from Supabase's default grant).
const FUNCTIONS_017: Record<string, readonly Role[]> = {
  ...Object.fromEntries(Object.entries(DB_FUNCTIONS).map(([name, entry]) => [name, entry.executors as readonly Role[]])),
  ...Object.fromEntries(TRIGGER_FUNCTIONS.map((name) => [name, [] as readonly Role[]])),
};

/* --------------------------------------- the same in every profile (019 leaves them) */

/**
 * The client roles' own attributes. None is a superuser, creates roles or
 * databases, replicates or logs in; only service_role bypasses RLS. Their
 * INHERIT flag is not pinned: the hosted project creates them INHERIT, the
 * test stub NOINHERIT, and it has no effect while they belong to no role —
 * which is pinned below.
 */
export const CLIENT_ROLE_BYPASSRLS: Readonly<Record<Role, boolean>> = {
  anon: false,
  authenticated: false,
  service_role: true,
};

/**
 * The roles allowed to be members OF a client role, and how. A client role
 * itself is a member of no role at all — not even SET-only, which a grant
 * check by has_*_privilege() cannot see.
 *   authenticator           PostgREST: switches into a client role with SET ROLE, never inherits it
 *   supabase_realtime_admin Supabase Realtime (hosted only): the same
 *   postgres                owns everything in public already
 */
export const CLIENT_ROLE_MEMBERS: Readonly<Record<string, { inherit: boolean | "any" }>> = {
  authenticator: { inherit: false },
  supabase_realtime_admin: { inherit: false },
  postgres: { inherit: "any" },
};

/** Schema public: the client roles use it; no one but its owner creates in it. PUBLIC's USAGE is not pinned. */
export const SCHEMA_PUBLIC = { usage: ["anon", "authenticated", "service_role"], create: [] as string[] } as const;

/** Functions that run as their owner. Every function in public also pins search_path to empty. */
export const SECURITY_DEFINER_FUNCTIONS: readonly string[] = [
  "claim_deposit_for_credit",
  "claim_provider_event",
  "consume_quote",
  "expire_stale_quotes",
  "handle_new_user",
  "has_admin_role",
  "is_admin",
  "ledger_post",
  "mark_trade_settled",
  "reconcile_wallets",
  "release_withdrawal_hold",
];
export const FUNCTION_SEARCH_PATH = 'search_path=""';

/** Tables with FORCE ROW LEVEL SECURITY: none (the roles that write past RLS have BYPASSRLS anyway). */
export const FORCE_RLS_TABLES: readonly string[] = [];

export type Policy = {
  table: string;
  name: string;
  cmd: "r" | "a" | "w" | "d" | "*";
  permissive: boolean;
  roles: readonly string[];
  using: string | null;
  check: string | null;
};

const OWN = "(user_id = auth.uid())";
const readPolicy = (table: string, name: string, roles: readonly string[], using: string): Policy => ({
  table,
  name,
  cmd: "r",
  permissive: true,
  roles,
  using,
  check: null,
});
const BOTH = ["anon", "authenticated"] as const;
const SIGNED_IN = ["authenticated"] as const;

/**
 * Every RLS policy in public, whole (010). Expressions as pg_get_expr prints
 * them, compared with whitespace collapsed and `public.` removed. A policy
 * added, dropped, widened, made restrictive or given to another role fails.
 */
export const POLICIES: readonly Policy[] = [
  readPolicy("account_tiers", "account_tiers_public_read", BOTH, "true"),
  readPolicy("admin_users", "admin_users_self_read", SIGNED_IN, OWN),
  readPolicy("asset_networks", "asset_networks_public_read", BOTH, "true"),
  readPolicy("assets", "assets_public_read", BOTH, "true"),
  readPolicy("deposits", "deposits_own_read", SIGNED_IN, OWN),
  readPolicy("fee_rules", "fee_rules_public_read", BOTH, "is_active"),
  readPolicy("kyc_verifications", "kyc_verifications_own_read", SIGNED_IN, OWN),
  readPolicy("ledger_entries", "ledger_entries_own_read", SIGNED_IN, OWN),
  readPolicy("limit_usage", "limit_usage_own_read", SIGNED_IN, OWN),
  readPolicy("notifications", "notifications_own_read", SIGNED_IN, OWN),
  { table: "notifications", name: "notifications_own_update", cmd: "w", permissive: true, roles: SIGNED_IN, using: OWN, check: OWN },
  readPolicy("profiles", "profiles_own_read", SIGNED_IN, OWN),
  { table: "profiles", name: "profiles_own_update", cmd: "w", permissive: true, roles: SIGNED_IN, using: OWN, check: OWN },
  readPolicy("swap_orders", "swap_orders_own_read", SIGNED_IN, OWN),
  readPolicy("swap_quotes", "swap_quotes_own_read", SIGNED_IN, OWN),
  readPolicy("tier_limits", "tier_limits_public_read", BOTH, "is_active"),
  readPolicy(
    "trades",
    "trades_own_read",
    SIGNED_IN,
    "(EXISTS ( SELECT 1 FROM trading_orders o WHERE ((o.id = ANY (ARRAY[trades.buy_order_id, trades.sell_order_id])) AND (o.user_id = auth.uid()))))",
  ),
  readPolicy("trading_orders", "trading_orders_own_read", SIGNED_IN, OWN),
  readPolicy("trading_pairs", "trading_pairs_public_read", BOTH, "true"),
  readPolicy("wallets", "wallets_own_read", SIGNED_IN, OWN),
  readPolicy("withdrawals", "withdrawals_own_read", SIGNED_IN, OWN),
];

export type PrivilegeRegistry = {
  tables: TableGrants;
  columns: ColumnGrant[];
  functions: Record<string, readonly Role[]>;
};

export const PRIVILEGE_REGISTRY: Record<PrivilegeProfile, PrivilegeRegistry> = {
  "017": { tables: TABLES_017, columns: [], functions: FUNCTIONS_017 },
  "019": {
    tables: TABLES_019,
    columns: COLUMNS_019,
    functions: Object.fromEntries(Object.entries(FUNCTIONS_019).map(([name, f]) => [name, f.executors])),
  },
};

export const FUNCTION_CALLERS: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(FUNCTIONS_019).map(([name, f]) => [name, f.calledFrom]),
);

export function isPrivilegeProfile(value: string): value is PrivilegeProfile {
  return (PRIVILEGE_PROFILES as readonly string[]).includes(value);
}

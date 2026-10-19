import type { ExternalOrderStatus } from "./types.ts";

/**
 * Provider status mapping (Slice 14A) — the neutral layer between a venue's own
 * status strings and `ExternalOrderStatus`.
 *
 * Each adapter declares ONE table for its venue's raw statuses; nothing here
 * names a venue, and no venue's semantics are assumed. No LP's documentation is
 * available yet, so no real table exists in the repository: the first adapter
 * fills one in from its venue's documentation.
 *
 * Fail-closed by construction: a raw status the table does not list — a new
 * venue status, a typo, a non-string, `"__proto__"` — is `UNKNOWN`, never a
 * guess. `UNKNOWN` is never read as FILLED or CANCELLED: the lifecycle treats it
 * as "nothing may change, reconcile", so funds stay reserved until a known
 * status arrives.
 */

export type ProviderStatusTable = ReadonlyMap<string, ExternalOrderStatus>;

const NEUTRAL_STATUSES: ReadonlySet<string> = new Set<ExternalOrderStatus>([
  "ACCEPTED",
  "OPEN",
  "PARTIALLY_FILLED",
  "FILLED",
  "CANCEL_PENDING",
  "CANCELLED",
  "REJECTED",
  "EXPIRED",
  "UNKNOWN",
]);

/**
 * Builds an adapter's status table. Throws at construction — i.e. when the
 * adapter module loads, long before an order — if an entry maps to anything but
 * a neutral status, or if a raw status is blank. Lookups are exact: an adapter
 * whose venue is case-insensitive normalises the raw string itself.
 */
export function providerStatusTable(entries: Readonly<Record<string, ExternalOrderStatus>>): ProviderStatusTable {
  const table = new Map<string, ExternalOrderStatus>();
  for (const [raw, status] of Object.entries(entries)) {
    if (raw.trim() === "") throw new Error("providerStatusTable: a raw status must not be blank");
    if (!NEUTRAL_STATUSES.has(status)) {
      throw new Error(`providerStatusTable: "${raw}" maps to "${String(status)}", which is not a neutral status`);
    }
    table.set(raw, status);
  }
  return table;
}

/** A venue's raw status as a neutral one; anything the table does not list is UNKNOWN. */
export function normalizeProviderStatus(table: ProviderStatusTable, raw: unknown): ExternalOrderStatus {
  if (typeof raw !== "string") return "UNKNOWN";
  return table.get(raw) ?? "UNKNOWN";
}

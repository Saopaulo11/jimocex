import "server-only";

import { cache } from "react";

import { AppError } from "@/lib/errors";
import { createClient } from "@/lib/supabase/server";
import type { Database } from "@/lib/db/database";

/**
 * The Data Access Layer (spec §3, §14).
 *
 * Every server-side answer to "who is this and what may they do" comes from
 * here, and from nowhere else. In particular, the identity NEVER comes from a
 * request body: a `userId` field in a payload is a value the caller chose, and
 * treating it as authority is the single most common way an exchange leaks one
 * customer's funds to another.
 *
 * `supabase.auth.getUser()` is what establishes identity, not `getSession()`.
 * The difference matters: `getSession()` decodes the cookie the browser sent
 * and trusts it; `getUser()` revalidates the token with the auth server. Only
 * the second is safe to authorize on.
 *
 * Wrapped in React's `cache()` so a request that checks authorization in a
 * layout, a page and three Server Actions still makes one round trip.
 */

type ProfileRow = Database["public"]["Tables"]["profiles"]["Row"];
type AccountStatus = Database["public"]["Enums"]["account_status"];

export type Viewer = {
  userId: string;
  email: string;
  /** Server-side truth from the auth provider, never a client-supplied flag (spec §22). */
  emailVerified: boolean;
  profile: ProfileRow;
};

/**
 * The signed-in user, or null. Never throws for an anonymous visitor, so a
 * public page can render differently without a try/catch.
 */
export const getViewer = cache(async (): Promise<Viewer | null> => {
  const supabase = await createClient();

  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError || !userData.user) return null;

  const user = userData.user;

  // Read through the user-scoped client, so RLS confirms the profile really is
  // theirs rather than this code taking the user id's word for it.
  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("*")
    .eq("user_id", user.id)
    .single();

  if (profileError || !profile) {
    // A signed-in user without a profile means the signup trigger did not run.
    // Treating them as anonymous is the safe reading: no profile, no tier, no
    // entitlements.
    return null;
  }

  return {
    userId: user.id,
    email: user.email ?? profile.email,
    emailVerified: Boolean(user.email_confirmed_at),
    profile,
  };
});

/** The signed-in user, or UNAUTHENTICATED. Says nothing about what they may do. */
export async function requireUser(): Promise<Viewer> {
  const viewer = await getViewer();
  if (!viewer) throw new AppError("UNAUTHENTICATED");
  return viewer;
}

/**
 * Statuses from which no financial operation may proceed (spec §9).
 *
 * RESTRICTED is deliberately absent: a restricted account is not barred
 * outright, it is one whose operations RiskEngine judges individually. Listing
 * it here would collapse that distinction into a blanket ban.
 */
const STATUSES_BARRED_FROM_FINANCIAL_OPERATIONS: readonly AccountStatus[] = [
  "SUSPENDED",
  "FROZEN",
  "CLOSED",
];

/**
 * The gate every financial operation passes through (spec §9).
 *
 * Sign-in is deliberately NOT blocked for a suspended account — the customer
 * should still be able to see their balances and reach support. What is blocked
 * is moving money. Call this in the Server Action or Route Handler that acts,
 * not in the page that renders.
 */
export async function requireActiveUser(): Promise<Viewer> {
  const viewer = await requireUser();
  const status = viewer.profile.status;

  if (status === "CLOSED") throw new AppError("ACCOUNT_CLOSED");

  if (STATUSES_BARRED_FROM_FINANCIAL_OPERATIONS.includes(status)) {
    throw new AppError("ACCOUNT_SUSPENDED", `account status is ${status}`);
  }

  return viewer;
}

/**
 * As `requireActiveUser`, and the email must be confirmed (spec §22).
 *
 * The flag is read from the auth provider's own record on every call. A
 * client-side boolean, a form field or a cached profile column would all be
 * things the caller can influence.
 */
export async function requireVerifiedUser(): Promise<Viewer> {
  const viewer = await requireActiveUser();
  if (!viewer.emailVerified) throw new AppError("EMAIL_NOT_VERIFIED");
  return viewer;
}

/**
 * Requires at least `minimumTier`, compared by the tier's `rank` rather than by
 * a string, so inserting a tier between two existing ones does not silently
 * change who passes.
 *
 * The tier is read from the database row, never from the request (spec §10).
 */
export async function requireTier(minimumTier: string): Promise<Viewer> {
  const viewer = await requireActiveUser();
  const supabase = await createClient();

  const { data: tiers, error } = await supabase
    .from("account_tiers")
    .select("code, rank")
    .in("code", [viewer.profile.tier_code, minimumTier]);

  if (error || !tiers) throw new AppError("INTERNAL", "could not read account tiers");

  const current = tiers.find((t) => t.code === viewer.profile.tier_code);
  const required = tiers.find((t) => t.code === minimumTier);

  if (!current || !required) {
    throw new AppError("INTERNAL", `unknown tier: ${viewer.profile.tier_code} or ${minimumTier}`);
  }

  if (current.rank < required.rank) {
    throw new AppError(
      "TIER_TOO_LOW",
      `tier ${current.code} (rank ${current.rank}) is below ${required.code} (rank ${required.rank})`,
    );
  }

  return viewer;
}

export type AdminViewer = Viewer & {
  adminId: string;
  adminRole: Database["public"]["Enums"]["admin_role"];
};

/**
 * Staff authority (spec §24, §43).
 *
 * Decided by an active row in `admin_users`, which no user can create for
 * themselves: the table has no INSERT policy, so the only way in is a
 * service-role write by someone who is already staff.
 *
 * Full admin authentication is PHASE 13. This is the integration point, and it
 * is a real check rather than a stub — there is no bypass to remove later.
 */
export async function requireAdmin(
  allowedRoles?: readonly Database["public"]["Enums"]["admin_role"][],
): Promise<AdminViewer> {
  const viewer = await requireUser();
  const supabase = await createClient();

  const { data: adminRow, error } = await supabase
    .from("admin_users")
    .select("id, role, is_active")
    .eq("user_id", viewer.userId)
    .maybeSingle();

  if (error) throw new AppError("INTERNAL", "could not read staff record");
  if (!adminRow || !adminRow.is_active) throw new AppError("FORBIDDEN", "not a staff account");

  if (allowedRoles && !allowedRoles.includes(adminRow.role)) {
    throw new AppError("FORBIDDEN", `staff role ${adminRow.role} is not permitted here`);
  }

  return { ...viewer, adminId: adminRow.id, adminRole: adminRow.role };
}

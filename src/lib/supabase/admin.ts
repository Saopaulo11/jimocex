import "server-only";

import { createClient as createSupabaseClient } from "@supabase/supabase-js";

import type { Database } from "./database.types";

/**
 * Supabase client holding the service role key.
 *
 * THIS CLIENT BYPASSES ROW LEVEL SECURITY. It can read and write every row
 * belonging to every user. It is the one component in the system for which the
 * database provides no safety net, so:
 *
 *   * `import "server-only"` above turns any client-side import into a build
 *     error rather than a leaked key;
 *   * the key is read from `SUPABASE_SERVICE_ROLE_KEY`, never from a
 *     `NEXT_PUBLIC_*` variable, so it cannot reach the browser bundle;
 *   * every caller must perform its own authorization check first. RLS will not
 *     catch a missing one here. `@/lib/auth/session` exists so that check is one
 *     line and hard to forget.
 *
 * Use it only where the operation genuinely exceeds what a user may do to their
 * own rows: posting to the ledger, settling a trade, moving a tier, recording an
 * audit entry, handling a provider webhook.
 */
export function createAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url) {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL is not set.");
  }
  if (!serviceRoleKey) {
    throw new Error(
      "SUPABASE_SERVICE_ROLE_KEY is not set. It is required for privileged server operations and must never be exposed to the browser.",
    );
  }

  return createSupabaseClient<Database>(url, serviceRoleKey, {
    auth: {
      // No session handling at all: this client is not a user and must never
      // pick one up from storage or from a URL fragment.
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false,
    },
  });
}

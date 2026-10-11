"use client";

import { createBrowserClient } from "@supabase/ssr";

import type { Database } from "@/lib/db/database";

/**
 * Supabase client for the browser.
 *
 * Carries the publishable (anon) key, so every query it makes is subject to Row
 * Level Security — a user reading through this client can only ever see their
 * own rows, and cannot write a balance, a tier or a ledger entry at all.
 *
 * That is the whole security model for client-side reads: the key is public by
 * design and the database, not this file, decides what it may see.
 *
 * Use it for auth flows (sign in, sign out, password reset) and for reading
 * reference data. Anything that moves money goes through a Server Action or a
 * Route Handler instead — see `server.ts` and `admin.ts`.
 */
export function createClient() {
  return createBrowserClient<Database>(
    requireEnv("NEXT_PUBLIC_SUPABASE_URL"),
    requireEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY"),
  );
}

function requireEnv(name: "NEXT_PUBLIC_SUPABASE_URL" | "NEXT_PUBLIC_SUPABASE_ANON_KEY"): string {
  // Read through an explicit literal rather than a computed key: Next.js inlines
  // `process.env.NEXT_PUBLIC_*` at build time only when it can see the full
  // property access, and a dynamic lookup silently yields undefined.
  const value =
    name === "NEXT_PUBLIC_SUPABASE_URL"
      ? process.env.NEXT_PUBLIC_SUPABASE_URL
      : process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!value) {
    throw new Error(
      `${name} is not set. Copy .env.example to .env and fill in the JimoCex Supabase project's values.`,
    );
  }
  return value;
}

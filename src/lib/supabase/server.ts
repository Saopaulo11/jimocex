import "server-only";

import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

import type { Database } from "@/lib/db/database";

/**
 * Supabase client for Server Components, Server Actions and Route Handlers.
 *
 * Acts AS THE SIGNED-IN USER: it carries the anon key plus the session from the
 * request's cookies, so Row Level Security applies exactly as it does in the
 * browser. A query through this client cannot return another user's rows even
 * if the surrounding code asks it to, which makes it the right default for
 * reading user data on the server.
 *
 * It is not a substitute for an authorization check. RLS answers "whose rows
 * are these"; it does not answer "is this account allowed to do this". That is
 * what `@/lib/auth/session` is for.
 */
export async function createClient() {
  const cookieStore = await cookies();

  return createServerClient<Database>(
    requireEnv("NEXT_PUBLIC_SUPABASE_URL", process.env.NEXT_PUBLIC_SUPABASE_URL),
    requireEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY),
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            for (const { name, value, options } of cookiesToSet) {
              cookieStore.set(name, value, options);
            }
          } catch {
            // Server Components cannot set cookies. A refreshed token here is
            // simply dropped, which is safe: `proxy.ts` refreshes the session on
            // every matched request and writes the cookies where it can.
          }
        },
      },
    },
  );
}

function requireEnv(name: string, value: string | undefined): string {
  if (!value) {
    throw new Error(
      `${name} is not set. Copy .env.example to .env and fill in your Supabase project's values.`,
    );
  }
  return value;
}

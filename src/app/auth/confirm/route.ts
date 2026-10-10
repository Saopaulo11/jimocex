import { type EmailOtpType } from "@supabase/supabase-js";
import { type NextRequest, NextResponse } from "next/server";

import { createClient } from "@/lib/supabase/server";
import { safeRedirectPath } from "@/lib/auth/validation";

/**
 * Where email confirmation and password-recovery links land.
 *
 * The link carries a single-use `token_hash`, which `verifyOtp` exchanges for a
 * session. Doing this in a Route Handler rather than on a page matters: the
 * handler can set the session cookie on the response, which a Server Component
 * cannot.
 *
 * On failure the user goes back to sign-in with no detail about why. A link
 * that is expired, already used, or forged should look identical from outside.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const tokenHash = searchParams.get("token_hash");
  const type = searchParams.get("type") as EmailOtpType | null;
  const next = safeRedirectPath(searchParams.get("next"), "/dashboard");

  if (!tokenHash || !type) {
    return NextResponse.redirect(new URL("/login?error=invalid_link", request.url));
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.verifyOtp({ type, token_hash: tokenHash });

  if (error) {
    return NextResponse.redirect(new URL("/login?error=invalid_link", request.url));
  }

  return NextResponse.redirect(new URL(next, request.url));
}

import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

/**
 * Proxy — what earlier Next.js versions called Middleware (renamed in 16).
 *
 * It does exactly two things, and deliberately nothing more:
 *
 *   1. Refreshes the Supabase session cookie, so a signed-in user is not logged
 *      out mid-session by an expired access token.
 *   2. Performs an OPTIMISTIC redirect — an anonymous visitor heading for
 *      /dashboard is sent to /login before a page renders.
 *
 * It is NOT the authorization boundary, and nothing here should be mistaken for
 * one. Next.js says plainly that Proxy "should not be used as a full session
 * management or authorization solution", and the reason is structural: a proxy
 * sees a cookie, not a verified identity, and it runs far away from the data.
 *
 * The real check lives in `@/lib/auth/session`, which calls `getUser()` to
 * revalidate the token with the auth server, and runs next to the query it
 * guards. Every page and Server Action that touches account data calls it. If
 * this file were deleted tomorrow, nothing would become accessible that is not
 * accessible now — only the redirects would get uglier.
 */

/** Routes that require a signed-in user. Prefix match. */
const PROTECTED_PREFIXES = [
  "/dashboard",
  "/wallets",
  "/trade",
  "/transactions",
  "/account",
  "/settings",
] as const;

/** Auth pages a signed-in user has no reason to see. */
const AUTH_PAGES = ["/login", "/signup", "/forgot-password"] as const;

export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request });

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  // Without Supabase configured there is no session to refresh. Carry on rather
  // than erroring: the public pages must still render, and every protected page
  // refuses on its own anyway.
  if (!url || !anonKey) return response;

  const supabase = createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        for (const { name, value } of cookiesToSet) {
          request.cookies.set(name, value);
        }
        response = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, options);
        }
      },
    },
  });

  // getUser(), not getSession(): this call revalidates the token and is what
  // actually refreshes it. It must not be removed or reordered — everything
  // between here and the response depends on it having run.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const path = request.nextUrl.pathname;

  if (!user && PROTECTED_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`))) {
    const loginUrl = new URL("/login", request.url);
    // Carry the destination so sign-in can return the user where they meant to
    // go. Only the path and query are kept — an absolute URL here would be an
    // open redirect.
    loginUrl.searchParams.set("next", `${path}${request.nextUrl.search}`);
    return NextResponse.redirect(loginUrl);
  }

  if (user && AUTH_PAGES.some((p) => path === p)) {
    return NextResponse.redirect(new URL("/dashboard", request.url));
  }

  return response;
}

export const config = {
  matcher: [
    /*
     * Everything except static assets and image files. The session has to be
     * refreshed on ordinary page requests; refreshing it for a favicon is pure
     * latency.
     */
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|woff2?)$).*)",
  ],
};

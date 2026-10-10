import type { Metadata } from "next";
import Link from "next/link";

import { LoginForm } from "@/components/auth/LoginForm";
import { safeRedirectPath } from "@/lib/auth/validation";

export const metadata: Metadata = { title: "Sign in" };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; error?: string }>;
}) {
  const params = await searchParams;
  // Narrowed before it reaches the form, so a crafted ?next= cannot be rendered
  // into a hidden field pointing off-site.
  const next = safeRedirectPath(params.next, "");

  return (
    <div className="jc-card-raised">
      <div className="jc-auth-header">
        <h1 className="jc-auth-title">Sign in</h1>
        <p className="jc-muted">Access your JimoCex account.</p>
      </div>

      <LoginForm next={next || undefined} linkError={params.error === "invalid_link"} />

      <p className="jc-auth-footer">
        New to JimoCex?{" "}
        <Link href="/signup" className="jc-link">
          Create an account
        </Link>
      </p>
    </div>
  );
}

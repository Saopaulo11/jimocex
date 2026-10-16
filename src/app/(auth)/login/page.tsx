import type { Metadata } from "next";
import Link from "next/link";

import { LoginForm } from "@/components/auth/LoginForm";
import { brand } from "@/config/brand";
import { safeRedirectPath } from "@/lib/auth/validation";

export const metadata: Metadata = { title: "Log in" };

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
    <>
      <div className="jc-auth-header">
        <h1 className="jc-auth-title">Log in</h1>
        <p className="jc-auth-sub">Access your {brand.name} account.</p>
      </div>

      <LoginForm next={next || undefined} linkError={params.error === "invalid_link"} />

      <p className="jc-auth-footer">
        Don&rsquo;t have an account?{" "}
        <Link href="/signup" className="jc-link">
          Create account
        </Link>
      </p>
    </>
  );
}

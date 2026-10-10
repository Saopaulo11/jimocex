import type { Metadata } from "next";
import Link from "next/link";

import { ResendVerificationForm } from "@/components/auth/ResendVerificationForm";

export const metadata: Metadata = { title: "Confirm your email" };

export default async function VerifyEmailPage({
  searchParams,
}: {
  searchParams: Promise<{ email?: string }>;
}) {
  const { email } = await searchParams;

  return (
    <div className="jc-card-raised">
      <div className="jc-auth-header">
        <h1 className="jc-auth-title">Check your email</h1>
        <p className="jc-muted">
          {email
            ? `We have sent a confirmation link to ${email}.`
            : "We have sent you a confirmation link."}
        </p>
      </div>

      <p style={{ color: "var(--jc-text-secondary)", fontSize: "0.9375rem", marginBottom: 20 }}>
        Open the link to confirm your address. You can sign in before confirming, but operations
        that require a verified email will ask for it first.
      </p>

      {email ? <ResendVerificationForm email={email} /> : null}

      <p className="jc-auth-footer">
        <Link href="/login" className="jc-link">
          Back to sign in
        </Link>
      </p>
    </div>
  );
}

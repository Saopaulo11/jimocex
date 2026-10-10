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
    <>
      <div className="jc-auth-header">
        <h1 className="jc-auth-title">Check your email</h1>
        <p className="jc-auth-sub">
          {email
            ? `We have sent a confirmation link to ${email}.`
            : "We have sent you a confirmation link."}
        </p>
      </div>

      <p className="jc-sm" style={{ marginBottom: "var(--jc-space-6)" }}>
        Open the link to confirm your address. You can sign in before confirming, but operations
        that require a verified address will ask for it first.
      </p>

      {email ? <ResendVerificationForm email={email} /> : null}

      <p className="jc-auth-footer">
        <Link href="/login" className="jc-link">
          Back to log in
        </Link>
      </p>
    </>
  );
}

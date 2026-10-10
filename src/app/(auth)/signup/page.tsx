import type { Metadata } from "next";
import Link from "next/link";

import { SignupForm } from "@/components/auth/SignupForm";
import { Alert } from "@/components/ui/Alert";

export const metadata: Metadata = { title: "Create account" };

export default function SignupPage() {
  return (
    <>
      <div className="jc-auth-header">
        <h1 className="jc-auth-title">Create your account</h1>
        <p className="jc-auth-sub">An email address and a password is all it takes to start.</p>
      </div>

      <SignupForm />

      {/* Stated at sign-up rather than after the first blocked operation. Tier 0
          is a real account, not a waiting room, and the wording avoids implying
          that verification is never required — risk rules can ask for it at any
          point, whatever the tier. */}
      <Alert tone="info" className="jc-stack" >
        <span>
          New accounts start at <strong>Tier&nbsp;0</strong>: up to $5,000 equivalent, subject to
          risk and compliance requirements. Identity verification is requested only when an
          operation requires it.
        </span>
      </Alert>

      <p className="jc-auth-footer">
        Already have an account?{" "}
        <Link href="/login" className="jc-link">
          Log in
        </Link>
      </p>
    </>
  );
}

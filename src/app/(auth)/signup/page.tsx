import type { Metadata } from "next";
import Link from "next/link";

import { SignupForm } from "@/components/auth/SignupForm";

export const metadata: Metadata = { title: "Create account" };

export default function SignupPage() {
  return (
    <div className="jc-card-raised">
      <div className="jc-auth-header">
        <h1 className="jc-auth-title">Create your account</h1>
        <p className="jc-muted">Email and a password is all it takes to start.</p>
      </div>

      <SignupForm />

      {/* Stating the tier plainly at signup, rather than after the first
          blocked operation. TIER_0 is a real account, not a waiting room, and
          verification is only asked for when an operation needs it. */}
      <div className="jc-alert jc-alert-info" style={{ marginTop: 20 }}>
        <span>
          New accounts start at <strong>Tier&nbsp;0</strong>. Identity verification is requested
          only when an operation requires it.
        </span>
      </div>

      <p className="jc-auth-footer">
        Already have an account?{" "}
        <Link href="/login" className="jc-link">
          Sign in
        </Link>
      </p>
    </div>
  );
}

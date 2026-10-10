import type { Metadata } from "next";
import Link from "next/link";

import { ForgotPasswordForm } from "@/components/auth/ForgotPasswordForm";

export const metadata: Metadata = { title: "Reset password" };

export default function ForgotPasswordPage() {
  return (
    <>
      <div className="jc-auth-header">
        <h1 className="jc-auth-title">Reset your password</h1>
        <p className="jc-auth-sub">We will email you a link to set a new one.</p>
      </div>

      <ForgotPasswordForm />

      <p className="jc-auth-footer">
        <Link href="/login" className="jc-link">
          Back to log in
        </Link>
      </p>
    </>
  );
}

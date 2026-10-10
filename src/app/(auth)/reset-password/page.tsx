import type { Metadata } from "next";

import { ResetPasswordForm } from "@/components/auth/ResetPasswordForm";

export const metadata: Metadata = { title: "Set a new password" };

/**
 * Reached only through a recovery link, which /auth/confirm exchanges for a
 * session before redirecting here. The action re-checks that session before it
 * changes anything, so landing on this URL without one achieves nothing.
 */
export default function ResetPasswordPage() {
  return (
    <>
      <div className="jc-auth-header">
        <h1 className="jc-auth-title">Set a new password</h1>
        <p className="jc-auth-sub">Choose a password you have not used elsewhere.</p>
      </div>

      <ResetPasswordForm />
    </>
  );
}

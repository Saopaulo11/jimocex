"use client";

import { useActionState } from "react";

import { resendVerificationEmail } from "@/app/auth/actions";
import type { FormState } from "@/lib/auth/validation";

import { FormAlert } from "./FormAlert";
import { SubmitButton } from "./SubmitButton";

const initialState: FormState = {};

export function ResendVerificationForm({ email }: { email: string }) {
  const [state, formAction] = useActionState(resendVerificationEmail, initialState);

  return (
    <form action={formAction} className="jc-stack">
      <FormAlert state={state} />
      <input type="hidden" name="email" value={email} />
      <SubmitButton pendingLabel="Sending…">Resend confirmation email</SubmitButton>
    </form>
  );
}

"use client";

import { useActionState } from "react";

import { resendVerificationEmail } from "@/app/auth/actions";
import { Button } from "@/components/ui/Button";
import type { FormState } from "@/lib/auth/validation";

import { FormAlert } from "./FormAlert";

const initialState: FormState = {};

export function ResendVerificationForm({ email }: { email: string }) {
  const [state, formAction, pending] = useActionState(resendVerificationEmail, initialState);

  return (
    <form action={formAction} className="jc-stack">
      <FormAlert state={state} />
      <input type="hidden" name="email" value={email} />
      <Button type="submit" variant="secondary" block loading={pending} loadingLabel="Sending">
        Resend confirmation email
      </Button>
    </form>
  );
}

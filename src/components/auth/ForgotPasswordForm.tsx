"use client";

import { useActionState } from "react";

import { requestPasswordReset } from "@/app/auth/actions";
import { Input } from "@/components/ui/Input";
import type { FormState } from "@/lib/auth/validation";

import { FormAlert } from "./FormAlert";
import { SubmitButton } from "./SubmitButton";

const initialState: FormState = {};

export function ForgotPasswordForm() {
  const [state, formAction] = useActionState(requestPasswordReset, initialState);

  return (
    <form action={formAction} className="jc-stack">
      <FormAlert state={state} />
      <Input
        id="email"
        label="Email"
        type="email"
        autoComplete="email"
        placeholder="you@example.com"
        required
        error={state.fieldErrors?.email}
      />
      <SubmitButton pendingLabel="Sending">Send reset link</SubmitButton>
    </form>
  );
}

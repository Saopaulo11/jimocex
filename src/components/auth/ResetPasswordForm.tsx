"use client";

import { useActionState } from "react";

import { updatePassword } from "@/app/auth/actions";
import { PasswordInput } from "@/components/ui/PasswordInput";
import type { FormState } from "@/lib/auth/validation";

import { FormAlert } from "./FormAlert";
import { SubmitButton } from "./SubmitButton";

const initialState: FormState = {};

export function ResetPasswordForm() {
  const [state, formAction] = useActionState(updatePassword, initialState);

  return (
    <form action={formAction} className="jc-stack">
      <FormAlert state={state} />
      <PasswordInput
        id="password"
        label="New password"
        autoComplete="new-password"
        required
        hint="At least 10 characters."
        error={state.fieldErrors?.password}
      />
      <PasswordInput
        id="confirmPassword"
        label="Confirm new password"
        autoComplete="new-password"
        required
        error={state.fieldErrors?.confirmPassword}
      />
      <SubmitButton pendingLabel="Updating">Update password</SubmitButton>
    </form>
  );
}

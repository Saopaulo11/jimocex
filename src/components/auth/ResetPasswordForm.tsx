"use client";

import { useActionState } from "react";

import { updatePassword } from "@/app/auth/actions";
import type { FormState } from "@/lib/auth/validation";

import { Field } from "./Field";
import { FormAlert } from "./FormAlert";
import { SubmitButton } from "./SubmitButton";

const initialState: FormState = {};

export function ResetPasswordForm() {
  const [state, formAction] = useActionState(updatePassword, initialState);

  return (
    <form action={formAction} className="jc-stack">
      <FormAlert state={state} />
      <Field
        id="password"
        label="New password"
        type="password"
        autoComplete="new-password"
        hint="At least 10 characters."
        error={state.fieldErrors?.password}
      />
      <Field
        id="confirmPassword"
        label="Confirm new password"
        type="password"
        autoComplete="new-password"
        error={state.fieldErrors?.confirmPassword}
      />
      <SubmitButton pendingLabel="Updating…">Update password</SubmitButton>
    </form>
  );
}

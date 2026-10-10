"use client";

import Link from "next/link";
import { useActionState } from "react";

import { signUp } from "@/app/auth/actions";
import { Input } from "@/components/ui/Input";
import { PasswordInput } from "@/components/ui/PasswordInput";
import type { FormState } from "@/lib/auth/validation";

import { FormAlert } from "./FormAlert";
import { SubmitButton } from "./SubmitButton";

const initialState: FormState = {};

export function SignupForm() {
  const [state, formAction] = useActionState(signUp, initialState);

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

      <PasswordInput
        id="password"
        label="Password"
        autoComplete="new-password"
        required
        hint="At least 10 characters."
        error={state.fieldErrors?.password}
      />

      <PasswordInput
        id="confirmPassword"
        label="Confirm password"
        autoComplete="new-password"
        required
        error={state.fieldErrors?.confirmPassword}
      />

      <div className="jc-stack-sm">
        <label className="jc-checkbox-row" htmlFor="acceptedTerms">
          <input type="checkbox" id="acceptedTerms" name="acceptedTerms" />
          <span>
            I agree to the{" "}
            <Link href="/terms" className="jc-link">
              Terms of Service
            </Link>{" "}
            and{" "}
            <Link href="/privacy" className="jc-link">
              Privacy Policy
            </Link>
            .
          </span>
        </label>
        {state.fieldErrors?.acceptedTerms ? (
          <span className="jc-field-error">{state.fieldErrors.acceptedTerms}</span>
        ) : null}
      </div>

      <SubmitButton pendingLabel="Creating account">Create account</SubmitButton>
    </form>
  );
}

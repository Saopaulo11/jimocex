"use client";

import Link from "next/link";
import { useActionState } from "react";

import { signUp } from "@/app/auth/actions";
import type { FormState } from "@/lib/auth/validation";

import { Field } from "./Field";
import { FormAlert } from "./FormAlert";
import { SubmitButton } from "./SubmitButton";

const initialState: FormState = {};

export function SignupForm() {
  const [state, formAction] = useActionState(signUp, initialState);

  return (
    <form action={formAction} className="jc-stack">
      <FormAlert state={state} />

      <Field
        id="email"
        label="Email"
        type="email"
        autoComplete="email"
        placeholder="you@example.com"
        error={state.fieldErrors?.email}
      />

      <Field
        id="password"
        label="Password"
        type="password"
        autoComplete="new-password"
        hint="At least 10 characters."
        error={state.fieldErrors?.password}
      />

      <Field
        id="confirmPassword"
        label="Confirm password"
        type="password"
        autoComplete="new-password"
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

      <SubmitButton pendingLabel="Creating account…">Create account</SubmitButton>
    </form>
  );
}

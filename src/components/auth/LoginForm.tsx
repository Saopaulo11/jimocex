"use client";

import Link from "next/link";
import { useActionState } from "react";

import { signIn } from "@/app/auth/actions";
import type { FormState } from "@/lib/auth/validation";

import { Field } from "./Field";
import { FormAlert } from "./FormAlert";
import { SubmitButton } from "./SubmitButton";

const initialState: FormState = {};

export function LoginForm({ next, linkError }: { next?: string; linkError?: boolean }) {
  const [state, formAction] = useActionState(signIn, initialState);

  return (
    <form action={formAction} className="jc-stack">
      {linkError ? (
        <div className="jc-alert jc-alert-error" role="alert">
          That link is no longer valid. Please sign in, or request a new one.
        </div>
      ) : null}

      <FormAlert state={state} />

      {/* The post-sign-in destination travels with the form rather than in the
          action's closure, and is narrowed to an in-app path server-side. */}
      {next ? <input type="hidden" name="next" value={next} /> : null}

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
        autoComplete="current-password"
        error={state.fieldErrors?.password}
      />

      <div style={{ textAlign: "right", marginTop: -4 }}>
        <Link href="/forgot-password" className="jc-link" style={{ fontSize: "0.875rem" }}>
          Forgot password?
        </Link>
      </div>

      <SubmitButton pendingLabel="Signing in…">Sign in</SubmitButton>
    </form>
  );
}

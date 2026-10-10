"use client";

import Link from "next/link";
import { useActionState } from "react";

import { signIn } from "@/app/auth/actions";
import { Alert } from "@/components/ui/Alert";
import { Input } from "@/components/ui/Input";
import { PasswordInput } from "@/components/ui/PasswordInput";
import type { FormState } from "@/lib/auth/validation";

import { FormAlert } from "./FormAlert";
import { SubmitButton } from "./SubmitButton";

const initialState: FormState = {};

export function LoginForm({ next, linkError }: { next?: string; linkError?: boolean }) {
  const [state, formAction] = useActionState(signIn, initialState);

  return (
    <form action={formAction} className="jc-stack">
      {linkError ? (
        <Alert tone="danger">That link is no longer valid. Please sign in, or request a new one.</Alert>
      ) : null}

      <FormAlert state={state} />

      {/* Travels with the form; narrowed to an in-app path on the server. */}
      {next ? <input type="hidden" name="next" value={next} /> : null}

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
        autoComplete="current-password"
        required
        error={state.fieldErrors?.password}
      />

      <div style={{ textAlign: "right", marginTop: "calc(var(--jc-space-1) * -1)" }}>
        <Link href="/forgot-password" className="jc-link" style={{ fontSize: "var(--jc-text-caption)" }}>
          Forgot password?
        </Link>
      </div>

      <SubmitButton pendingLabel="Signing in">Log in</SubmitButton>
    </form>
  );
}

"use client";

import { useFormStatus } from "react-dom";

import { Button } from "@/components/ui/Button";

/**
 * Submit button wired to the enclosing form's pending state.
 *
 * Must be its own client component: `useFormStatus` reads the state of the
 * <form> above it, and a hook cannot do that from the page that renders the
 * form. Blocking the second click is not cosmetic here — a double-submitted
 * sign-up is a request the server then has to de-duplicate.
 */
export function SubmitButton({
  children,
  pendingLabel,
}: {
  children: React.ReactNode;
  pendingLabel: string;
}) {
  const { pending } = useFormStatus();

  return (
    <Button type="submit" variant="primary" block loading={pending} loadingLabel={pendingLabel}>
      {children}
    </Button>
  );
}

"use client";

import { useFormStatus } from "react-dom";

/**
 * Submit button that disables itself while the action is in flight.
 *
 * On a financial form this is not only polish: a double-submitted sign-up or
 * password change is a request the server then has to de-duplicate.
 * `useFormStatus` reads the state of the enclosing <form>, which is why this
 * has to be its own client component rather than a prop on the page.
 */
export function SubmitButton({ children, pendingLabel }: { children: React.ReactNode; pendingLabel: string }) {
  const { pending } = useFormStatus();

  return (
    <button type="submit" className="jc-btn jc-btn-primary jc-btn-block" disabled={pending}>
      {pending ? pendingLabel : children}
    </button>
  );
}

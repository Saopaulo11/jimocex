import type { FormState } from "@/lib/auth/validation";

/**
 * Renders an action's error or success message.
 *
 * `role="alert"` so a screen reader announces the result without the user
 * having to go looking for it — a sighted user sees the red box appear, and
 * this is the equivalent.
 */
export function FormAlert({ state }: { state: FormState }) {
  if (state.error) {
    return (
      <div className="jc-alert jc-alert-error" role="alert">
        {state.error}
      </div>
    );
  }
  if (state.success) {
    return (
      <div className="jc-alert jc-alert-success" role="status">
        {state.success}
      </div>
    );
  }
  return null;
}

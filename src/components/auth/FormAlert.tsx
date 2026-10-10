import { Alert } from "@/components/ui/Alert";
import type { FormState } from "@/lib/auth/validation";

/** Renders whichever of an action's outcomes is present. */
export function FormAlert({ state }: { state: FormState }) {
  if (state.error) return <Alert tone="danger">{state.error}</Alert>;
  if (state.success) return <Alert tone="success">{state.success}</Alert>;
  return null;
}

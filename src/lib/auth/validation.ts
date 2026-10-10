import { z } from "zod";

/**
 * Auth input schemas (spec §57).
 *
 * Validated on the server, inside the Server Action, before anything else
 * happens. Client-side validation is a convenience for the person typing; it is
 * not a control, because the request can be made without the form.
 */

/**
 * Supabase enforces a minimum length of its own, but length alone is a weak
 * rule. 10 characters is the floor here rather than the common 8: for an
 * account that will hold money, the extra two characters cost the user nothing
 * and remove the weakest tier of guessable passwords.
 *
 * Deliberately NO composition rules (one upper, one digit, one symbol). They
 * push people toward predictable substitutions and shorter passwords, and NIST
 * has recommended against them for years.
 */
export const passwordSchema = z
  .string()
  .min(10, "Password must be at least 10 characters.")
  .max(72, "Password must be 72 characters or fewer.");

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(1, "Enter your email address.")
  .email("Enter a valid email address.")
  .max(254, "That email address is too long.");

export const loginSchema = z.object({
  email: emailSchema,
  // Not `passwordSchema`: an existing password set under older rules must still
  // work, and rejecting it here would lock people out of their own accounts.
  password: z.string().min(1, "Enter your password."),
});

export const signupSchema = z
  .object({
    email: emailSchema,
    password: passwordSchema,
    confirmPassword: z.string(),
    acceptedTerms: z.literal(true, {
      message: "Please accept the Terms of Service and Privacy Policy.",
    }),
  })
  .refine((data) => data.password === data.confirmPassword, {
    message: "Passwords do not match.",
    path: ["confirmPassword"],
  });

export const forgotPasswordSchema = z.object({ email: emailSchema });

export const resetPasswordSchema = z
  .object({
    password: passwordSchema,
    confirmPassword: z.string(),
  })
  .refine((data) => data.password === data.confirmPassword, {
    message: "Passwords do not match.",
    path: ["confirmPassword"],
  });

/**
 * Narrows a post-login redirect to an in-app path.
 *
 * `?next=` comes from the URL, so it is attacker-controlled. Without this, a
 * link to `/login?next=https://evil.example` would hand a freshly authenticated
 * user to someone else's site — the classic open redirect, and a good phishing
 * primitive against a financial product.
 *
 * Only a path beginning with a single "/" is allowed. "//host" is rejected
 * because a browser reads it as protocol-relative and leaves the origin.
 */
export function safeRedirectPath(value: string | null | undefined, fallback = "/dashboard"): string {
  if (!value) return fallback;
  if (!value.startsWith("/")) return fallback;
  if (value.startsWith("//")) return fallback;
  if (value.includes("\\")) return fallback;
  return value;
}

export type FormState = {
  error?: string;
  fieldErrors?: Record<string, string>;
  success?: string;
};

/** Collapses a ZodError into the per-field shape the forms render. */
export function toFieldErrors(error: z.ZodError): Record<string, string> {
  const fieldErrors: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path[0];
    if (typeof key === "string" && !fieldErrors[key]) {
      fieldErrors[key] = issue.message;
    }
  }
  return fieldErrors;
}

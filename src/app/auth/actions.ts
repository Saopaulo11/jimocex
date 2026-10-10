"use server";

import { redirect } from "next/navigation";
import { headers } from "next/headers";

import { createClient } from "@/lib/supabase/server";
import {
  forgotPasswordSchema,
  loginSchema,
  resetPasswordSchema,
  safeRedirectPath,
  signupSchema,
  toFieldErrors,
  type FormState,
} from "@/lib/auth/validation";

/**
 * Authentication Server Actions (spec §2, §6, §21).
 *
 * Passwords are never seen by JimoCex beyond being handed to Supabase Auth, and
 * are never stored in this project's database. There is no hashing code here on
 * purpose: rolling our own is the classic way to get it wrong, and Supabase
 * already owns password authentication (spec §21).
 */

async function appOrigin(): Promise<string> {
  if (process.env.NEXT_PUBLIC_APP_URL) return process.env.NEXT_PUBLIC_APP_URL;
  // Falls back to the request's own origin so preview deployments send links
  // that point at themselves rather than at production.
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  const proto = h.get("x-forwarded-proto") ?? "https";
  return host ? `${proto}://${host}` : "http://localhost:3000";
}

export async function signIn(_prev: FormState, formData: FormData): Promise<FormState> {
  const parsed = loginSchema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
  });

  if (!parsed.success) return { fieldErrors: toFieldErrors(parsed.error) };

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword(parsed.data);

  if (error) {
    // One message for "no such account" and "wrong password" alike. Telling
    // them apart turns the login form into a way to discover who banks here.
    return { error: "Incorrect email or password." };
  }

  redirect(safeRedirectPath(formData.get("next")?.toString()));
}

export async function signUp(_prev: FormState, formData: FormData): Promise<FormState> {
  const parsed = signupSchema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
    confirmPassword: formData.get("confirmPassword"),
    acceptedTerms: formData.get("acceptedTerms") === "on",
  });

  if (!parsed.success) return { fieldErrors: toFieldErrors(parsed.error) };

  const supabase = await createClient();
  const origin = await appOrigin();

  const { error } = await supabase.auth.signUp({
    email: parsed.data.email,
    password: parsed.data.password,
    options: {
      emailRedirectTo: `${origin}/auth/confirm`,
      // Nothing about tier, status, role or limits is passed here. Supabase
      // copies this object into user_metadata, which the user can later edit
      // through the auth API — so anything placed in it is client-controlled by
      // definition. The tier is set by the database trigger instead, which the
      // user cannot reach (spec §8, §10).
    },
  });

  if (error) {
    // Supabase answers a signup for an existing address without confirming it
    // exists; keep that property rather than reflecting the provider's wording.
    if (error.status === 429) {
      return { error: "Too many attempts. Please wait a moment and try again." };
    }
    return { error: "We could not create the account. Please try again." };
  }

  // Deliberately the same destination whether or not the address was already
  // registered: the page says "check your email", which is true either way and
  // reveals nothing (spec §20).
  redirect(`/verify-email?email=${encodeURIComponent(parsed.data.email)}`);
}

export async function requestPasswordReset(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const parsed = forgotPasswordSchema.safeParse({ email: formData.get("email") });
  if (!parsed.success) return { fieldErrors: toFieldErrors(parsed.error) };

  const supabase = await createClient();
  const origin = await appOrigin();

  await supabase.auth.resetPasswordForEmail(parsed.data.email, {
    redirectTo: `${origin}/auth/confirm?next=/reset-password`,
  });

  // The result is not checked on purpose. Reporting whether the address exists
  // would turn this form into an account-enumeration oracle, so the answer is
  // the same for every input.
  return {
    success:
      "If an account exists for that address, we have sent a link to reset the password.",
  };
}

export async function updatePassword(_prev: FormState, formData: FormData): Promise<FormState> {
  const parsed = resetPasswordSchema.safeParse({
    password: formData.get("password"),
    confirmPassword: formData.get("confirmPassword"),
  });

  if (!parsed.success) return { fieldErrors: toFieldErrors(parsed.error) };

  const supabase = await createClient();

  // Requires the recovery session established by /auth/confirm. Without it this
  // call has no user to act on and fails, which is the desired outcome: a
  // password cannot be changed by posting to this action directly.
  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) {
    return { error: "This password reset link has expired. Please request a new one." };
  }

  const { error } = await supabase.auth.updateUser({ password: parsed.data.password });
  if (error) return { error: "We could not update the password. Please try again." };

  redirect("/dashboard");
}

export async function signOut(): Promise<void> {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/login");
}

export async function resendVerificationEmail(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const email = formData.get("email")?.toString();
  if (!email) return { error: "Enter your email address." };

  const supabase = await createClient();
  const origin = await appOrigin();

  await supabase.auth.resend({
    type: "signup",
    email,
    options: { emailRedirectTo: `${origin}/auth/confirm` },
  });

  return { success: "If that address needs confirming, we have sent another link." };
}

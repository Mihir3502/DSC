"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import {
  registerCandidate,
  requestCandidateRecovery,
  resendVerificationCode,
  resetCandidatePassword,
  signInCandidate,
  verifyCandidateEmail,
} from "@/modules/identity-access";
import type { AuthFormState } from "@/modules/identity-access/ui/form-state";
import {
  applyAuthCookies,
  echoEmail,
  field,
  messages,
  passwordFieldErrors,
} from "@/app/_auth/auth-messages";

// Same-origin server actions for public candidate authentication (packet
// M1.2). Next.js rejects cross-origin action requests (Origin/Host check),
// and every command enforces its own validation, rate limits, and generic
// outcomes server-side.

function attempt(previous: AuthFormState) {
  return (previous.attempt ?? 0) + 1;
}

export async function registerAction(
  previous: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  const result = await registerCandidate(
    {
      intentToken: field(formData, "intentToken"),
      email: field(formData, "email"),
      password: field(formData, "password"),
      passwordConfirmation: field(formData, "passwordConfirmation"),
    },
    await headers(),
  );
  const base = { attempt: attempt(previous), values: echoEmail(formData) };
  switch (result.kind) {
    case "SUBMITTED":
      return { status: "success", message: messages.registered, ...base };
    case "INVALID_INPUT":
      return {
        status: "error",
        message: messages.fixErrors,
        fieldErrors: {
          ...(result.email ? { email: messages.invalidEmail } : {}),
          ...passwordFieldErrors(result.password ?? []),
        },
        ...base,
      };
    case "INTENT_INVALID":
      return { status: "error", message: messages.intentInvalid, ...base };
    case "RATE_LIMITED":
      return { status: "error", message: messages.rateLimited, ...base };
  }
}

export async function signInAction(
  previous: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  const result = await signInCandidate(
    {
      email: field(formData, "email"),
      password: field(formData, "password"),
      next: field(formData, "next"),
    },
    await headers(),
  );
  if (result.kind === "SIGNED_IN") {
    await applyAuthCookies(result.setCookies);
    redirect(result.destination);
  }
  return {
    status: "error",
    message:
      result.kind === "RATE_LIMITED"
        ? messages.rateLimited
        : messages.invalidCredentials,
    attempt: attempt(previous),
    values: echoEmail(formData),
  };
}

export async function verifyEmailAction(
  previous: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  const result = await verifyCandidateEmail(
    { email: field(formData, "email"), code: field(formData, "code") },
    await headers(),
  );
  const base = { attempt: attempt(previous), values: echoEmail(formData) };
  switch (result.kind) {
    case "VERIFIED":
      return { status: "success", message: messages.verified, ...base };
    case "INVALID_INPUT":
      return {
        status: "error",
        message: messages.fixErrors,
        fieldErrors: {
          ...(result.email ? { email: messages.invalidEmail } : {}),
          ...(result.code ? { code: messages.codeFormat } : {}),
        },
        ...base,
      };
    case "CODE_INVALID":
      return { status: "error", message: messages.codeInvalid, ...base };
    case "RATE_LIMITED":
      return { status: "error", message: messages.rateLimited, ...base };
  }
}

export async function resendCodeAction(
  previous: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  const result = await resendVerificationCode(
    { email: field(formData, "email") },
    await headers(),
  );
  const base = { attempt: attempt(previous), values: echoEmail(formData) };
  switch (result.kind) {
    case "SENT":
      return { status: "success", message: messages.codeSent, ...base };
    case "INVALID_INPUT":
      return {
        status: "error",
        message: messages.fixErrors,
        fieldErrors: { email: messages.invalidEmail },
        ...base,
      };
    case "RATE_LIMITED":
      return { status: "error", message: messages.rateLimited, ...base };
  }
}

export async function recoverAction(
  previous: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  const result = await requestCandidateRecovery(
    { email: field(formData, "email") },
    await headers(),
  );
  const base = { attempt: attempt(previous), values: echoEmail(formData) };
  switch (result.kind) {
    case "SENT":
      return { status: "success", message: messages.recoverySent, ...base };
    case "INVALID_INPUT":
      return {
        status: "error",
        message: messages.fixErrors,
        fieldErrors: { email: messages.invalidEmail },
        ...base,
      };
    case "RATE_LIMITED":
      return { status: "error", message: messages.rateLimited, ...base };
  }
}

export async function resetPasswordAction(
  previous: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  const result = await resetCandidatePassword(
    {
      token: field(formData, "token"),
      password: field(formData, "password"),
      passwordConfirmation: field(formData, "passwordConfirmation"),
    },
    await headers(),
  );
  const next = attempt(previous);
  switch (result.kind) {
    case "RESET":
      return {
        status: "success",
        message: messages.passwordReset,
        attempt: next,
      };
    case "INVALID_INPUT":
      return {
        status: "error",
        message: messages.fixErrors,
        fieldErrors: passwordFieldErrors(result.password),
        attempt: next,
      };
    case "LINK_INVALID":
      return { status: "error", message: messages.linkInvalid, attempt: next };
    case "RATE_LIMITED":
      return { status: "error", message: messages.rateLimited, attempt: next };
  }
}

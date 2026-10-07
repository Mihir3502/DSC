"use server";

import { headers } from "next/headers";
import {
  registerCandidate,
  requestCandidateRecovery,
  resendVerificationCode,
  resetCandidatePassword,
  signInCandidate,
  verifyCandidateEmail,
} from "@/modules/identity-access";
import { safeRedirect } from "@/modules/identity-access/delivery/route-authorization";
import type { AuthFormState } from "@/modules/identity-access/ui/form-state";
import { parseFormInput } from "@/shared/validation/form-input";
import {
  applyAuthCookies,
  echoEmail,
  messages,
  passwordFieldErrors,
} from "@/app/_auth/auth-messages";
import { formSchemas } from "@/app/_auth/form-schemas";

// Same-origin server actions for public candidate authentication (packet
// M1.2). Next.js rejects cross-origin action requests (Origin/Host check),
// and every command enforces its own validation, rate limits, and generic
// outcomes server-side. M1.5: each action accepts only its exact reviewed
// fields (anything else rejects before the command runs) and redirects
// only to registered destinations.

function attempt(previous: AuthFormState) {
  return (previous.attempt ?? 0) + 1;
}

function rejected(previous: AuthFormState): AuthFormState {
  return {
    status: "error",
    message: messages.formRejected,
    attempt: attempt(previous),
  };
}

export async function registerAction(
  previous: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  const input = parseFormInput(formData, formSchemas.register);
  if (input.kind === "REJECTED") return rejected(previous);
  const result = await registerCandidate(input.values, await headers());
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
  const input = parseFormInput(formData, formSchemas.signIn);
  if (input.kind === "REJECTED") return rejected(previous);
  const result = await signInCandidate(input.values, await headers());
  if (result.kind === "SIGNED_IN") {
    await applyAuthCookies(result.setCookies);
    safeRedirect(result.destination);
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
  const input = parseFormInput(formData, formSchemas.verifyEmail);
  if (input.kind === "REJECTED") return rejected(previous);
  const result = await verifyCandidateEmail(input.values, await headers());
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
  const input = parseFormInput(formData, formSchemas.resendCode);
  if (input.kind === "REJECTED") return rejected(previous);
  const result = await resendVerificationCode(input.values, await headers());
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
  const input = parseFormInput(formData, formSchemas.recover);
  if (input.kind === "REJECTED") return rejected(previous);
  const result = await requestCandidateRecovery(input.values, await headers());
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
  const input = parseFormInput(formData, formSchemas.resetPassword);
  if (input.kind === "REJECTED") return rejected(previous);
  const result = await resetCandidatePassword(input.values, await headers());
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

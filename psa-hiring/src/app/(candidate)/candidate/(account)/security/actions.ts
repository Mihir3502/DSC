"use server";

import { cookies, headers } from "next/headers";
import {
  changeCandidatePassword,
  revokeCandidateSession,
  revokeOtherCandidateSessions,
  signOutCandidate,
  signOutCandidateEverywhere,
} from "@/modules/identity-access";
import {
  refuseAccess,
  safeRedirect,
} from "@/modules/identity-access/delivery/route-authorization";
import type { AuthFormState } from "@/modules/identity-access/ui/form-state";
import { parseFormInput } from "@/shared/validation/form-input";
import {
  applyAuthCookies,
  messages,
  passwordFieldErrors,
} from "@/app/_auth/auth-messages";
import { formSchemas } from "@/app/_auth/form-schemas";

// Same-origin server actions for /candidate/security (packet M1.2 §11.2,
// §13; M1.5 §9, §13). Thin adapters: exact input (unknown fields reject),
// one application command, typed outcome → registered redirect or safe
// not-found. Each command re-resolves the principal and calls the
// CANDIDATE_* self-service policy; nothing here decides authorization.
// State changes never happen on GET.

const securityPage = "/candidate/security";

export async function changePasswordAction(
  previous: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  const attempt = (previous.attempt ?? 0) + 1;
  const input = parseFormInput(formData, formSchemas.changePassword);
  if (input.kind === "REJECTED") {
    return { status: "error", message: messages.formRejected, attempt };
  }
  const result = await changeCandidatePassword(input.values, await headers());
  switch (result.kind) {
    case "CHANGED":
      await applyAuthCookies(result.setCookies);
      return { status: "success", message: messages.passwordChanged, attempt };
    case "INVALID_INPUT":
      return {
        status: "error",
        message: messages.fixErrors,
        fieldErrors: passwordFieldErrors(result.password),
        attempt,
      };
    case "CURRENT_PASSWORD_INVALID":
      return {
        status: "error",
        message: messages.fixErrors,
        fieldErrors: { currentPassword: messages.currentPasswordInvalid },
        attempt,
      };
    case "RATE_LIMITED":
      return { status: "error", message: messages.rateLimited, attempt };
    case "UNAUTHENTICATED":
    case "NOT_PERMITTED":
    case "REAUTHENTICATION_REQUIRED":
      refuseAccess(result.kind, "CANDIDATE");
  }
}

export async function revokeSessionAction(formData: FormData): Promise<void> {
  const input = parseFormInput(formData, formSchemas.revokeSession);
  if (input.kind === "REJECTED")
    safeRedirect(`${securityPage}?notice=not-found`);
  const result = await revokeCandidateSession(
    await headers(),
    input.values.session,
  );
  switch (result.kind) {
    case "REVOKED":
      await applyAuthCookies(result.setCookies);
      if (result.endedCurrent) safeRedirect("/sign-in");
      safeRedirect(`${securityPage}?notice=revoked`);
    case "NOT_FOUND":
      safeRedirect(`${securityPage}?notice=not-found`);
    default:
      refuseAccess(result.kind, "CANDIDATE");
  }
}

export async function revokeOtherSessionsAction(
  formData: FormData,
): Promise<void> {
  if (parseFormInput(formData, formSchemas.noFields).kind === "REJECTED") {
    safeRedirect(securityPage);
  }
  const result = await revokeOtherCandidateSessions(await headers());
  if (result.kind === "REVOKED") {
    safeRedirect(`${securityPage}?notice=others-revoked`);
  }
  refuseAccess(result.kind, "CANDIDATE");
}

export async function signOutEverywhereAction(
  formData: FormData,
): Promise<void> {
  if (parseFormInput(formData, formSchemas.noFields).kind === "REJECTED") {
    safeRedirect(securityPage);
  }
  const result = await signOutCandidateEverywhere(await headers());
  // Wrong audience: the other principal's cookie is left untouched.
  if (result.kind !== "REVOKED") refuseAccess(result.kind, "CANDIDATE");
  await applyAuthCookies(result.setCookies);
  await clearSessionCookies();
  safeRedirect("/sign-in");
}

export async function signOutAction(formData: FormData): Promise<void> {
  if (parseFormInput(formData, formSchemas.noFields).kind === "REJECTED") {
    safeRedirect(securityPage);
  }
  const result = await signOutCandidate(await headers());
  await applyAuthCookies(result.setCookies);
  await clearSessionCookies();
  safeRedirect("/sign-in");
}

async function clearSessionCookies() {
  const store = await cookies();
  for (const name of ["psa.session_token", "__Secure-psa.session_token"]) {
    if (store.has(name)) store.delete(name);
  }
}

"use server";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import {
  changeCandidatePassword,
  revokeCandidateSession,
  revokeOtherCandidateSessions,
  signOutCandidate,
  signOutCandidateEverywhere,
} from "@/modules/identity-access";
import type { AuthFormState } from "@/modules/identity-access/ui/form-state";
import {
  applyAuthCookies,
  field,
  messages,
  passwordFieldErrors,
} from "@/app/_auth/auth-messages";

// Same-origin server actions for /candidate/security (packet M1.2 §11.2,
// §13). Every command re-resolves the current candidate and rechecks
// session ownership on the server. State changes never happen on GET.

const securityPage = "/candidate/security";

export async function changePasswordAction(
  previous: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  const result = await changeCandidatePassword(
    {
      currentPassword: field(formData, "currentPassword"),
      password: field(formData, "password"),
      passwordConfirmation: field(formData, "passwordConfirmation"),
    },
    await headers(),
  );
  const attempt = (previous.attempt ?? 0) + 1;
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
      redirect("/sign-in");
  }
}

export async function revokeSessionAction(formData: FormData): Promise<void> {
  const result = await revokeCandidateSession(
    await headers(),
    field(formData, "session"),
  );
  if (result.kind === "UNAUTHENTICATED") redirect("/sign-in");
  if (result.kind === "NOT_FOUND") redirect(`${securityPage}?notice=not-found`);
  await applyAuthCookies(result.setCookies);
  if (result.endedCurrent) redirect("/sign-in");
  redirect(`${securityPage}?notice=revoked`);
}

export async function revokeOtherSessionsAction(): Promise<void> {
  const result = await revokeOtherCandidateSessions(await headers());
  if (result.kind === "UNAUTHENTICATED") redirect("/sign-in");
  redirect(`${securityPage}?notice=others-revoked`);
}

export async function signOutEverywhereAction(): Promise<void> {
  const result = await signOutCandidateEverywhere(await headers());
  if (result.kind === "REVOKED") await applyAuthCookies(result.setCookies);
  await clearSessionCookies();
  redirect("/sign-in");
}

export async function signOutAction(): Promise<void> {
  const result = await signOutCandidate(await headers());
  await applyAuthCookies(result.setCookies);
  await clearSessionCookies();
  redirect("/sign-in");
}

async function clearSessionCookies() {
  const store = await cookies();
  for (const name of ["psa.session_token", "__Secure-psa.session_token"]) {
    if (store.has(name)) store.delete(name);
  }
}

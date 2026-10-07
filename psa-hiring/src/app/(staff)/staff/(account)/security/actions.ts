"use server";

import { cookies, headers } from "next/headers";
import {
  changeStaffPassword,
  reauthenticateStaff,
  regenerateStaffBackupCodes,
  revokeOtherStaffSessions,
  revokeStaffSession,
  signOutStaff,
  signOutStaffEverywhere,
} from "@/modules/identity-access";
import {
  refuseAccess,
  safeRedirect,
} from "@/modules/identity-access/delivery/route-authorization";
import type { AuthFormState } from "@/modules/identity-access/ui/form-state";
import type { BackupCodesState } from "@/modules/identity-access/ui/staff-form-state";
import { parseFormInput } from "@/shared/validation/form-input";
import {
  applyAuthCookies,
  passwordFieldErrors,
  messages,
} from "@/app/_auth/auth-messages";
import { formSchemas } from "@/app/_auth/form-schemas";
import { staffMessages } from "@/app/_auth/staff-messages";

// Same-origin server actions for /staff/security and /staff/reauthenticate
// (packet M1.3 §12–§13; M1.5 §9, §13). Thin adapters: exact input (unknown
// fields reject), one application command, typed outcome → registered
// redirect or safe not-found. Each command re-resolves the MFA-complete
// staff principal and calls its STAFF_* self-service policy; nothing here
// trusts a client-supplied method, time, purpose URL, or destination.

const securityPage = "/staff/security";

async function clearStaffCookies() {
  const store = await cookies();
  for (const name of [
    "psa.session_token",
    "__Secure-psa.session_token",
    "psa.two_factor",
    "__Secure-psa.two_factor",
  ]) {
    if (store.has(name)) store.delete(name);
  }
}

export async function staffChangePasswordAction(
  previous: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  const attempt = (previous.attempt ?? 0) + 1;
  const input = parseFormInput(formData, formSchemas.changePassword);
  if (input.kind === "REJECTED") {
    return { status: "error", message: staffMessages.formRejected, attempt };
  }
  const result = await changeStaffPassword(input.values, await headers());
  switch (result.kind) {
    case "CHANGED":
      await applyAuthCookies(result.setCookies);
      await clearStaffCookies();
      safeRedirect("/staff/sign-in?notice=password-changed");
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
    case "REAUTHENTICATION_REQUIRED":
    case "UNAUTHENTICATED":
    case "NOT_PERMITTED":
      refuseAccess(result.kind, "STAFF");
  }
}

export async function regenerateBackupCodesAction(
  previous: BackupCodesState,
  formData: FormData,
): Promise<BackupCodesState> {
  const attempt = (previous.attempt ?? 0) + 1;
  const input = parseFormInput(formData, formSchemas.regenerateBackupCodes);
  if (input.kind === "REJECTED") {
    return { status: "error", message: staffMessages.formRejected, attempt };
  }
  const result = await regenerateStaffBackupCodes(
    input.values,
    await headers(),
  );
  switch (result.kind) {
    case "REGENERATED":
      // The one controlled moment the new codes are shown (M1.3 §10.3).
      return { status: "success", backupCodes: result.backupCodes, attempt };
    case "INVALID":
      return { status: "error", message: staffMessages.reauthInvalid, attempt };
    case "RATE_LIMITED":
      return { status: "error", message: staffMessages.rateLimited, attempt };
    case "UNAUTHENTICATED":
    case "NOT_PERMITTED":
      refuseAccess(result.kind, "STAFF");
  }
}

export async function reauthenticateAction(
  previous: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  const attempt = (previous.attempt ?? 0) + 1;
  const input = parseFormInput(formData, formSchemas.reauthenticate);
  if (input.kind === "REJECTED") {
    return { status: "error", message: staffMessages.formRejected, attempt };
  }
  const result = await reauthenticateStaff(input.values, await headers());
  switch (result.kind) {
    case "REAUTHENTICATED":
      // Resolved from the closed purpose registry, then re-validated
      // against the redirect registry. The destination re-authorizes.
      safeRedirect(result.destination);
    case "INVALID":
      return { status: "error", message: staffMessages.reauthInvalid, attempt };
    case "RATE_LIMITED":
      return { status: "error", message: staffMessages.rateLimited, attempt };
    case "UNAUTHENTICATED":
    case "NOT_PERMITTED":
      refuseAccess(result.kind, "STAFF");
  }
}

export async function revokeStaffSessionAction(
  formData: FormData,
): Promise<void> {
  const input = parseFormInput(formData, formSchemas.revokeSession);
  if (input.kind === "REJECTED")
    safeRedirect(`${securityPage}?notice=not-found`);
  const result = await revokeStaffSession(
    await headers(),
    input.values.session,
  );
  switch (result.kind) {
    case "REVOKED":
      await applyAuthCookies(result.setCookies);
      if (result.endedCurrent) {
        await clearStaffCookies();
        safeRedirect("/staff/sign-in?notice=signed-out");
      }
      safeRedirect(`${securityPage}?notice=revoked`);
    case "NOT_FOUND":
      safeRedirect(`${securityPage}?notice=not-found`);
    default:
      refuseAccess(result.kind, "STAFF");
  }
}

export async function revokeOtherStaffSessionsAction(
  formData: FormData,
): Promise<void> {
  if (parseFormInput(formData, formSchemas.noFields).kind === "REJECTED") {
    safeRedirect(securityPage);
  }
  const result = await revokeOtherStaffSessions(await headers());
  if (result.kind === "REVOKED") {
    safeRedirect(`${securityPage}?notice=others-revoked`);
  }
  refuseAccess(result.kind, "STAFF");
}

export async function staffSignOutEverywhereAction(
  formData: FormData,
): Promise<void> {
  if (parseFormInput(formData, formSchemas.noFields).kind === "REJECTED") {
    safeRedirect(securityPage);
  }
  const result = await signOutStaffEverywhere(await headers());
  // Wrong audience: the other principal's cookie is left untouched.
  if (result.kind !== "REVOKED") refuseAccess(result.kind, "STAFF");
  await applyAuthCookies(result.setCookies);
  await clearStaffCookies();
  safeRedirect("/staff/sign-in?notice=signed-out");
}

export async function staffSignOutAction(formData: FormData): Promise<void> {
  if (parseFormInput(formData, formSchemas.noFields).kind === "REJECTED") {
    safeRedirect(securityPage);
  }
  const result = await signOutStaff(await headers());
  await applyAuthCookies(result.setCookies);
  await clearStaffCookies();
  safeRedirect("/staff/sign-in?notice=signed-out");
}

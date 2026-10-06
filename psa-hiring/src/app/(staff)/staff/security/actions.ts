"use server";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import {
  changeStaffPassword,
  reauthenticateStaff,
  regenerateStaffBackupCodes,
  revokeOtherStaffSessions,
  revokeStaffSession,
  signOutStaff,
  signOutStaffEverywhere,
} from "@/modules/identity-access";
import type { AuthFormState } from "@/modules/identity-access/ui/form-state";
import type { BackupCodesState } from "@/modules/identity-access/ui/staff-form-state";
import {
  applyAuthCookies,
  field,
  passwordFieldErrors,
  messages,
} from "@/app/_auth/auth-messages";
import { staffMessages } from "@/app/_auth/staff-messages";

// Same-origin server actions for /staff/security and /staff/reauthenticate
// (packet M1.3 §12–§13). Every command re-resolves the MFA-complete staff
// principal and its server-owned assurance; nothing here trusts a
// client-supplied method, time, or destination.

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
  const result = await changeStaffPassword(
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
      await clearStaffCookies();
      redirect("/staff/sign-in?notice=password-changed");
    case "REAUTHENTICATION_REQUIRED":
      redirect("/staff/reauthenticate?purpose=CHANGE_PASSWORD");
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
      redirect("/staff/sign-in");
  }
}

export async function regenerateBackupCodesAction(
  previous: BackupCodesState,
  formData: FormData,
): Promise<BackupCodesState> {
  const result = await regenerateStaffBackupCodes(
    { password: field(formData, "password"), code: field(formData, "code") },
    await headers(),
  );
  const attempt = (previous.attempt ?? 0) + 1;
  switch (result.kind) {
    case "REGENERATED":
      return { status: "success", backupCodes: result.backupCodes, attempt };
    case "INVALID":
      return { status: "error", message: staffMessages.reauthInvalid, attempt };
    case "RATE_LIMITED":
      return { status: "error", message: staffMessages.rateLimited, attempt };
    case "UNAUTHENTICATED":
      redirect("/staff/sign-in");
  }
}

export async function reauthenticateAction(
  previous: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  const result = await reauthenticateStaff(
    {
      password: field(formData, "password"),
      code: field(formData, "code"),
      purpose: field(formData, "purpose"),
    },
    await headers(),
  );
  const attempt = (previous.attempt ?? 0) + 1;
  switch (result.kind) {
    case "REAUTHENTICATED":
      redirect(result.destination);
    case "INVALID":
      return { status: "error", message: staffMessages.reauthInvalid, attempt };
    case "RATE_LIMITED":
      return { status: "error", message: staffMessages.rateLimited, attempt };
    case "UNAUTHENTICATED":
      redirect("/staff/sign-in");
  }
}

export async function revokeStaffSessionAction(
  formData: FormData,
): Promise<void> {
  const result = await revokeStaffSession(
    await headers(),
    field(formData, "session"),
  );
  if (result.kind === "UNAUTHENTICATED") redirect("/staff/sign-in");
  if (result.kind === "NOT_FOUND") redirect(`${securityPage}?notice=not-found`);
  await applyAuthCookies(result.setCookies);
  if (result.endedCurrent) {
    await clearStaffCookies();
    redirect("/staff/sign-in?notice=signed-out");
  }
  redirect(`${securityPage}?notice=revoked`);
}

export async function revokeOtherStaffSessionsAction(): Promise<void> {
  const result = await revokeOtherStaffSessions(await headers());
  if (result.kind === "UNAUTHENTICATED") redirect("/staff/sign-in");
  redirect(`${securityPage}?notice=others-revoked`);
}

export async function staffSignOutEverywhereAction(): Promise<void> {
  const result = await signOutStaffEverywhere(await headers());
  if (result.kind === "REVOKED") await applyAuthCookies(result.setCookies);
  await clearStaffCookies();
  redirect("/staff/sign-in?notice=signed-out");
}

export async function staffSignOutAction(): Promise<void> {
  const result = await signOutStaff(await headers());
  await applyAuthCookies(result.setCookies);
  await clearStaffCookies();
  redirect("/staff/sign-in?notice=signed-out");
}

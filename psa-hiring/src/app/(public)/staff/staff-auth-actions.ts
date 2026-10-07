"use server";

import { headers } from "next/headers";
import {
  beginStaffActivation,
  completeStaffActivation,
  completeStaffMfa,
  requestStaffRecovery,
  signInStaff,
  verifyStaffEnrollment,
} from "@/modules/identity-access";
import { safeRedirect } from "@/modules/identity-access/delivery/route-authorization";
import type { AuthFormState } from "@/modules/identity-access/ui/form-state";
import type {
  BackupCodesState,
  BeginActivationState,
} from "@/modules/identity-access/ui/staff-form-state";
import { parseFormInput } from "@/shared/validation/form-input";
import {
  applyAuthCookies,
  currentRequestHeaders,
  echoEmail,
  passwordFieldErrors,
} from "@/app/_auth/auth-messages";
import { formSchemas } from "@/app/_auth/form-schemas";
import { staffMessages } from "@/app/_auth/staff-messages";

// Same-origin server actions for public staff authentication (packet M1.3
// §9, §11, §14). Next.js rejects cross-origin action requests, and every
// command enforces its own validation, rate limits, and generic outcomes.
// No action accepts an account type, status, role, method strength,
// timestamp, trusted-device flag, or destination URL from the browser.
// M1.5: each action accepts only its exact reviewed fields (anything else
// rejects before the command runs) and redirects only to registered
// destinations.

function attempt(previous: { attempt?: number }) {
  return (previous.attempt ?? 0) + 1;
}

function rejected(previous: { attempt?: number }) {
  return {
    status: "error" as const,
    message: staffMessages.formRejected,
    attempt: attempt(previous),
  };
}

export async function beginActivationAction(
  previous: BeginActivationState,
  formData: FormData,
): Promise<BeginActivationState> {
  const input = parseFormInput(formData, formSchemas.beginActivation);
  if (input.kind === "REJECTED") return rejected(previous);
  const result = await beginStaffActivation(
    {
      token: input.values.invite,
      password: input.values.password,
      passwordConfirmation: input.values.passwordConfirmation,
    },
    await headers(),
  );
  const next = attempt(previous);
  switch (result.kind) {
    case "ENROLLMENT_STARTED":
      await applyAuthCookies(result.setCookies);
      return {
        status: "success",
        enrollment: result.enrollment,
        attempt: next,
      };
    case "INVALID_INPUT":
      return {
        status: "error",
        message: staffMessages.fixErrors,
        fieldErrors: passwordFieldErrors(result.password),
        attempt: next,
      };
    case "INVITATION_INVALID":
      return {
        status: "error",
        message: staffMessages.invitationInvalid,
        attempt: next,
      };
    case "RATE_LIMITED":
      return {
        status: "error",
        message: staffMessages.rateLimited,
        attempt: next,
      };
  }
}

export async function verifyEnrollmentAction(
  previous: BackupCodesState,
  formData: FormData,
): Promise<BackupCodesState> {
  const input = parseFormInput(formData, formSchemas.verifyEnrollment);
  if (input.kind === "REJECTED") return rejected(previous);
  const result = await verifyStaffEnrollment(
    input.values,
    await currentRequestHeaders(),
  );
  const next = attempt(previous);
  switch (result.kind) {
    case "BACKUP_CODES":
      await applyAuthCookies(result.setCookies);
      return {
        status: "success",
        backupCodes: result.backupCodes,
        attempt: next,
      };
    case "INVALID_CODE":
      return {
        status: "error",
        message: staffMessages.fixErrors,
        fieldErrors: { code: staffMessages.codeInvalid },
        attempt: next,
      };
    case "PASSWORD_INVALID":
      return {
        status: "error",
        message: staffMessages.fixErrors,
        fieldErrors: { password: staffMessages.passwordInvalid },
        attempt: next,
      };
    case "ACTIVATION_EXPIRED":
      return {
        status: "error",
        message: staffMessages.activationExpired,
        attempt: next,
      };
    case "RATE_LIMITED":
      return {
        status: "error",
        message: staffMessages.rateLimited,
        attempt: next,
      };
  }
}

export async function completeActivationAction(
  previous: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  const input = parseFormInput(formData, formSchemas.completeActivation);
  if (input.kind === "REJECTED") return rejected(previous);
  const result = await completeStaffActivation(
    { savedConfirmation: input.values.saved },
    await currentRequestHeaders(),
  );
  switch (result.kind) {
    case "ACTIVATED":
      await applyAuthCookies(result.setCookies);
      safeRedirect(result.destination);
    case "ACTIVATED_SIGN_IN_REQUIRED":
      safeRedirect("/staff/sign-in?notice=activated");
    case "CONFIRMATION_REQUIRED":
      return {
        status: "error",
        message: staffMessages.fixErrors,
        fieldErrors: { saved: staffMessages.confirmationRequired },
        attempt: attempt(previous),
      };
    case "ACTIVATION_EXPIRED":
      return {
        status: "error",
        message: staffMessages.activationExpired,
        attempt: attempt(previous),
      };
  }
}

export async function staffSignInAction(
  previous: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  const input = parseFormInput(formData, formSchemas.staffSignIn);
  if (input.kind === "REJECTED") return rejected(previous);
  const result = await signInStaff(input.values, await headers());
  if (result.kind === "MFA_REQUIRED") {
    await applyAuthCookies(result.setCookies);
    safeRedirect("/staff/mfa");
  }
  return {
    status: "error",
    message:
      result.kind === "RATE_LIMITED"
        ? staffMessages.rateLimited
        : staffMessages.invalidCredentials,
    attempt: attempt(previous),
    values: echoEmail(formData),
  };
}

export async function staffMfaAction(
  previous: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  const input = parseFormInput(formData, formSchemas.staffMfa);
  if (input.kind === "REJECTED") return rejected(previous);
  const method = input.values.method === "backup" ? "backup" : "totp";
  const result = await completeStaffMfa(
    { method, code: input.values.code },
    await headers(),
  );
  switch (result.kind) {
    case "SIGNED_IN":
      await applyAuthCookies(result.setCookies);
      safeRedirect(result.destination);
    case "CHALLENGE_EXPIRED":
      await applyAuthCookies(result.setCookies);
      safeRedirect("/staff/sign-in?notice=expired");
    case "INVALID_CODE":
      return {
        status: "error",
        message: staffMessages.fixErrors,
        fieldErrors: {
          code:
            method === "backup"
              ? staffMessages.backupCodeInvalid
              : staffMessages.codeInvalid,
        },
        attempt: attempt(previous),
      };
    case "LOCKED":
      return {
        status: "error",
        message: staffMessages.mfaLocked,
        attempt: attempt(previous),
      };
    case "RATE_LIMITED":
      return {
        status: "error",
        message: staffMessages.rateLimited,
        attempt: attempt(previous),
      };
  }
}

export async function staffRecoveryAction(
  previous: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  const input = parseFormInput(formData, formSchemas.staffRecovery);
  if (input.kind === "REJECTED") return rejected(previous);
  const result = await requestStaffRecovery(input.values, await headers());
  const base = { attempt: attempt(previous), values: echoEmail(formData) };
  switch (result.kind) {
    case "SUBMITTED":
      return {
        status: "success",
        message: staffMessages.recoverySubmitted,
        ...base,
      };
    case "INVALID_INPUT":
      return {
        status: "error",
        message: staffMessages.fixErrors,
        fieldErrors: { email: staffMessages.invalidEmail },
        ...base,
      };
    case "RATE_LIMITED":
      return { status: "error", message: staffMessages.rateLimited, ...base };
  }
}

import "server-only";
import { cookies, headers } from "next/headers";
import {
  toCookieWrites,
  type PasswordProblem,
} from "@/modules/identity-access";

// Closed result codes → plain-language messages for candidate auth forms
// (packet M1.2 §14). Messages never reveal whether an account exists, its
// type, status, or verification state.

export const messages = {
  invalidEmail: "Enter an email address in the format name@example.com.",
  rateLimited: "Too many attempts. Wait a few minutes, then try again.",
  fixErrors: "Check the highlighted fields and try again.",
  registered:
    "If this email address can be used to register, we sent it an 8-digit verification code. Enter the code to finish setting up your account. If you already have an account, sign in or reset your password instead.",
  intentInvalid:
    "This registration link is invalid, expired, or already used. Start again from the registration page, or ask the agency for a new invitation.",
  invalidCredentials:
    "The email address or password is incorrect, or this account cannot sign in here yet. If you registered recently, verify your email address first.",
  verified: "Your email address is verified. Sign in to continue.",
  codeInvalid:
    "That code is incorrect, has expired, or was already used. Check the code, or send a new one.",
  codeFormat: "Enter the code from your email using digits only.",
  codeSent:
    "If this email address is waiting for verification, we sent it a new code. Any earlier code no longer works.",
  recoverySent:
    "If this email address belongs to a candidate account that can reset its password, we sent it a reset link. The link expires soon and can be used once.",
  linkInvalid:
    "This reset link is invalid, has expired, or was already used. Request a new reset link.",
  passwordReset:
    "Your password was changed and every signed-in session was ended. Sign in with your new password.",
  passwordChanged:
    "Your password was changed. Other signed-in sessions were ended.",
  currentPasswordInvalid: "The current password is incorrect.",
  signedOutRequired: "Your session has ended. Sign in again.",
} as const;

const passwordMessages: Record<PasswordProblem, string> = {
  REQUIRED: "Enter a password.",
  TOO_SHORT: "Use at least 12 characters.",
  TOO_LONG: "Use 256 characters or fewer.",
  CONTROL_CHARACTERS:
    "Remove tab, line-break, or other control characters from the password.",
  MISMATCH: "The passwords do not match.",
  COMPROMISED:
    "This password appears on a list of common or exposed passwords. Choose a different one.",
};

/** Field errors for password problems (confirmation mismatch on its field). */
export function passwordFieldErrors(
  problems: readonly PasswordProblem[],
): Record<string, string> {
  const errors: Record<string, string> = {};
  const main = problems.filter((p) => p !== "MISMATCH");
  if (main.length > 0) {
    errors.password = main.map((p) => passwordMessages[p]).join(" ");
  }
  if (problems.includes("MISMATCH")) {
    errors.passwordConfirmation = passwordMessages.MISMATCH;
  }
  return errors;
}

/** The email the user typed, echoed back only into their own form. */
export function echoEmail(formData: FormData): { email?: string } {
  const value = formData.get("email");
  return typeof value === "string" && value.length <= 320
    ? { email: value }
    : {};
}

export function field(formData: FormData, name: string): string | undefined {
  const value = formData.get(name);
  return typeof value === "string" ? value : undefined;
}

/** Applies Better Auth Set-Cookie values through the Next.js cookie store. */
export async function applyAuthCookies(
  setCookies: readonly string[],
): Promise<void> {
  if (setCookies.length === 0) return;
  const store = await cookies();
  for (const write of toCookieWrites(setCookies)) {
    store.set(write.name, write.value, write.options);
  }
}

/**
 * Request headers whose Cookie header reflects the live cookie store, so a
 * render in the same server-action request sees a rotated session cookie
 * (for example after a password change) instead of the revoked one.
 */
export async function currentRequestHeaders(): Promise<Headers> {
  const result = new Headers(await headers());
  const cookie = (await cookies()).toString();
  if (cookie) result.set("cookie", cookie);
  else result.delete("cookie");
  return result;
}

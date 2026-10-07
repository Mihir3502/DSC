import "server-only";

// Closed result codes → plain-language messages for staff authentication
// screens (packet M1.3 §16). Messages never reveal whether an account
// exists, its type or status, or why an invitation is unusable.

export const staffMessages = {
  invalidCredentials:
    "The email address or password is incorrect, or this account cannot use staff sign-in.",
  rateLimited: "Too many attempts. Wait a few minutes, then try again.",
  invitationInvalid:
    "This activation link is invalid, has expired, was replaced by a newer invitation, or was already used. Ask your administrator for a new invitation.",
  activationExpired:
    "Your activation session has ended. Open the invitation link from your email again to start over.",
  codeInvalid:
    "That code is incorrect or was already used. Enter the current 6-digit code from your authenticator app.",
  backupCodeInvalid:
    "That backup code is incorrect or was already used. Each backup code works once.",
  mfaLocked:
    "Too many incorrect codes. For your security, sign-in is paused for this account. Wait 15 minutes, then sign in again.",
  challengeExpired:
    "Your sign-in step has expired. Sign in again with your email address and password.",
  passwordInvalid: "The password is incorrect.",
  confirmationRequired:
    "Confirm that you have saved your backup codes before you finish.",
  reauthInvalid:
    "The password or authenticator code is incorrect. Check both and try again.",
  reauthRequired:
    "For your security, confirm your password and authenticator code before changing your password.",
  passwordChanged:
    "Your password was changed and every session was signed out. Sign in again.",
  recoverySubmitted:
    "If this email address belongs to an active staff account, your request was recorded. An administrator must verify your identity before anything changes. Contact your administrator to continue; you will receive an email if your sign-in is reset.",
  fixErrors: "Check the highlighted fields and try again.",
  formRejected:
    "This form could not be processed. Reload the page and try again.",
  invalidEmail: "Enter an email address in the format name@example.com.",
} as const;

/** Notices shown on /staff/sign-in after a redirect (closed set). */
export const staffSignInNotices: Readonly<Record<string, string>> = {
  expired: staffMessages.challengeExpired,
  "password-changed": staffMessages.passwordChanged,
  "signed-out": "You are signed out.",
  activated:
    "Your staff account is active. Sign in with your password and authenticator code.",
};

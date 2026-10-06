import { twoFactor } from "better-auth/plugins/two-factor";

// Static Better Auth options shared by the runtime instance (auth.ts) and the
// CLI schema-check configuration (auth.cli.ts), so `auth check schema`
// validates exactly the fields the application runs with. No secrets, URLs,
// database handles, or hooks live here.

export const AUTH_SCHEMA_NAME = "auth";

/**
 * Application-owned fields on the authoritative Better Auth user record.
 * `input: false` keeps them out of every sign-up/update request body;
 * `returned: false` keeps them out of auth responses. Type and status have
 * no default, so creation fails closed unless server code supplies them.
 */
export const userAdditionalFields = {
  emailDisplay: {
    type: "string",
    required: false,
    input: false,
    returned: false,
  },
  accountType: {
    type: "string",
    required: true,
    input: false,
    returned: false,
  },
  status: {
    type: "string",
    required: true,
    input: false,
    returned: false,
  },
  lastAuthenticatedAt: {
    type: "date",
    required: false,
    input: false,
    returned: false,
  },
  disabledAt: {
    type: "date",
    required: false,
    input: false,
    returned: false,
  },
  disabledReasonCode: {
    type: "string",
    required: false,
    input: false,
    returned: false,
  },
  version: {
    type: "number",
    required: false,
    input: false,
    returned: false,
    defaultValue: 1,
  },
} as const;

/**
 * Server-owned authentication-assurance evidence on each session (packet
 * M1.3 §13). Written only by the session-creation hook and the staff
 * reauthentication command, never from request input, and never returned
 * by Better Auth. Better Auth's own `freshAge` measures only session
 * creation, so it cannot express MFA or purpose-bound reauthentication.
 */
export const sessionAdditionalFields = {
  authPurpose: {
    type: "string",
    required: false,
    input: false,
    returned: false,
  },
  authMethod: {
    type: "string",
    required: false,
    input: false,
    returned: false,
  },
  primaryAuthenticatedAt: {
    type: "date",
    required: false,
    input: false,
    returned: false,
  },
  mfaAuthenticatedAt: {
    type: "date",
    required: false,
    input: false,
    returned: false,
  },
  accountVersion: {
    type: "number",
    required: false,
    input: false,
    returned: false,
  },
  reauthenticatedAt: {
    type: "date",
    required: false,
    input: false,
    returned: false,
  },
  reauthenticationMethod: {
    type: "string",
    required: false,
    input: false,
    returned: false,
  },
  reauthenticationPurpose: {
    type: "string",
    required: false,
    input: false,
    returned: false,
  },
} as const;

/** Reviewed authenticator-app issuer label (never taken from input). */
export const TOTP_ISSUER = "PSA Workforce Hiring";
export const TOTP_DIGITS = 6;
export const TOTP_PERIOD_SECONDS = 30;
export const BACKUP_CODE_COUNT = 10;
export const BACKUP_CODE_LENGTH = 10;

export type StaffTwoFactorSettings = Readonly<{
  /** Lifetime of the post-password challenge cookie/record. */
  challengeSeconds: number;
  /** Shared TOTP/backup-code failures before temporary lockout. */
  maxFailedAttempts: number;
  lockoutSeconds: number;
}>;

/**
 * Better Auth's maintained two-factor plugin, configured for M1.3 (packet
 * §6, §10, ADR-0004): TOTP plus encrypted single-use backup codes, no email
 * or SMS OTP sender (so OTP cannot be enabled or sent), verification
 * required before enabling, account lockout on, and the trusted-device
 * lifetime minimized. Trusted devices are never requested by application
 * commands, and every /two-factor/* HTTP path is disabled below.
 */
export function staffTwoFactorPlugin(
  settings: StaffTwoFactorSettings = {
    challengeSeconds: 300,
    maxFailedAttempts: 5,
    lockoutSeconds: 900,
  },
) {
  return twoFactor({
    issuer: TOTP_ISSUER,
    skipVerificationOnEnable: false,
    twoFactorCookieMaxAge: settings.challengeSeconds,
    trustDeviceMaxAge: 1,
    totpOptions: { digits: TOTP_DIGITS, period: TOTP_PERIOD_SECONDS },
    backupCodeOptions: {
      amount: BACKUP_CODE_COUNT,
      length: BACKUP_CODE_LENGTH,
      storeBackupCodes: "encrypted",
    },
    accountLockout: {
      enabled: true,
      maxFailedAttempts: settings.maxFailedAttempts,
      durationSeconds: settings.lockoutSeconds,
    },
  });
}

/**
 * Better Auth HTTP paths that must never be reachable. Candidate flows run as
 * server actions through auth.api (which this list does not affect), and the
 * Next.js route additionally allowlists the few public paths it forwards.
 */
export const disabledAuthPaths = [
  "/sign-up/email",
  "/send-verification-email",
  "/verify-email",
  "/request-password-reset",
  "/forget-password",
  "/reset-password",
  "/change-password",
  "/set-password",
  "/change-email",
  "/update-user",
  "/delete-user",
  "/revoke-session",
  "/revoke-sessions",
  "/revoke-other-sessions",
  "/list-sessions",
  "/list-accounts",
  "/unlink-account",
  "/link-social",
  "/account-info",
  "/refresh-token",
  "/get-access-token",
  "/update-session",
  "/email-otp/send-verification-otp",
  "/email-otp/check-verification-otp",
  "/email-otp/verify-email",
  "/sign-in/email-otp",
  "/email-otp/request-password-reset",
  "/forget-password/email-otp",
  "/email-otp/reset-password",
  "/email-otp/request-email-change",
  "/email-otp/change-email",
  // Two-factor (M1.3): staff MFA runs only as server actions through
  // auth.api; no enrollment, challenge, OTP, or backup-code path is HTTP
  // reachable. viewBackupCodes and generateTOTP are server-only already.
  "/two-factor/enable",
  "/two-factor/disable",
  "/two-factor/get-totp-uri",
  "/two-factor/verify-totp",
  "/two-factor/send-otp",
  "/two-factor/verify-otp",
  "/two-factor/verify-backup-code",
  "/two-factor/generate-backup-codes",
  "/verify-password",
];

export const staticAuthOptions = {
  appName: "PSA Workforce Hiring System",
  basePath: "/api/auth",
  session: { additionalFields: sessionAdditionalFields },
  user: {
    additionalFields: userAdditionalFields,
    changeEmail: { enabled: false },
    deleteUser: { enabled: false },
  },
  emailAndPassword: {
    enabled: true,
    // No generic signup: candidates register only through the M1.2
    // registration-intent command, staff only through M1.3 invitations.
    disableSignUp: true,
    minPasswordLength: 12,
    maxPasswordLength: 256,
    autoSignIn: false,
    // A successful reset ends every existing session (packet M1.2 §12.2).
    revokeSessionsOnPasswordReset: true,
  },
  // Reset tokens, email-OTP identifiers, and invitation intents are stored
  // only as hashes (packet M1.2 §9.1).
  verification: { storeIdentifier: "hashed" },
  account: {
    accountLinking: { enabled: false },
  },
  advanced: {
    cookiePrefix: "psa",
    database: { generateId: "uuid" },
    ipAddress: { disableIpTracking: true },
  },
  disabledPaths: disabledAuthPaths,
  telemetry: { enabled: false },
} as const;

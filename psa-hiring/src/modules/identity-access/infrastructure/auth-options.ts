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
];

export const staticAuthOptions = {
  appName: "PSA Workforce Hiring System",
  basePath: "/api/auth",
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

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
    // M1.1: no public signup. Candidate registration arrives in M1.2 and
    // staff accounts only through the M1.3 invitation flow.
    disableSignUp: true,
    minPasswordLength: 12,
    maxPasswordLength: 256,
    autoSignIn: false,
  },
  account: {
    accountLinking: { enabled: false },
  },
  advanced: {
    cookiePrefix: "psa",
    database: { generateId: "uuid" },
    ipAddress: { disableIpTracking: true },
  },
  telemetry: { enabled: false },
} as const;

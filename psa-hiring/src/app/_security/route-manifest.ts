import type { SelfServicePolicyCode } from "@/modules/identity-access/domain/self-service-policy";
import type { formSchemas } from "@/app/_auth/form-schemas";

// Reviewed route and entry-point authorization manifest (packet M1.5 §7,
// ADR-0011). Policy metadata only: it is not executable and grants
// nothing. tests/guards/authorization-boundaries.test.ts enumerates the
// real route tree, Server Action exports, Route Handler methods, framework
// hooks, and local harnesses, and fails CI when any entry point is missing
// here, stale, or inconsistent with its declared controls;
// scripts/ci/route-manifest-check.ts repeats the comparison against the
// production build output. An unknown or unclassified entry point fails
// closed by failing CI.
//
// Explicit exclusions (reviewed): static assets under public/ (none
// exist), Next.js internals under /_next, the generated route types, and
// operator tooling in scripts/db and scripts/ci (run from a shell with the
// operator's own credentials; never reachable from the application).

export type EntryKind =
  | "PAGE"
  | "LAYOUT"
  | "SPECIAL"
  | "ROUTE_HANDLER"
  | "SERVER_ACTION"
  | "PROXY"
  | "INSTRUMENTATION"
  | "LOCAL_HARNESS";

export type Audience =
  | "PUBLIC"
  | "CANDIDATE"
  | "STAFF"
  | "SERVICE"
  /** Any interactive caller; ends only the caller's own browser session. */
  | "MIXED"
  | "NONE";

export type Authentication =
  | "NONE"
  /** Possession of a one-time capability (fragment token or challenge). */
  | "CAPABILITY"
  | "OPTIONAL"
  | "REQUIRED";

export type AccountRequirement =
  | "NONE"
  | "ACTIVE_VERIFIED_CANDIDATE"
  | "ACTIVE_MFA_COMPLETE_STAFF"
  | "STAFF_FIRST_FACTOR_CHALLENGE"
  | "INVITED_STAFF_ACTIVATION";

export type EntryAuthorization =
  | Readonly<{ kind: "SELF_SERVICE"; policy: SelfServicePolicyCode }>
  /** Bounded public behavior: generic outcomes, rate limits, no data. */
  | Readonly<{ kind: "PUBLIC_BOUNDED" }>
  /** Route-group guard: navigation convenience, never authority. */
  | Readonly<{ kind: "NAVIGATION_GUARD"; audience: "CANDIDATE" | "STAFF" }>
  /** Every request is a closed, side-effect-free 404. */
  | Readonly<{ kind: "CLOSED" }>
  /** Framework plumbing that reads no protected data. */
  | Readonly<{ kind: "FRAMEWORK" }>
  /** CLI harness that refuses outside APP_ENV=local/test. */
  | Readonly<{
      kind: "LOCAL_ONLY";
      environments: readonly ("local" | "test")[];
    }>;

export type OutputContract =
  | "candidate.account_security.v1"
  | "staff.account_security.v1"
  | "FORM_STATE"
  | "ONE_TIME_SECRET_DISPLAY"
  | "REDIRECT_ONLY"
  | "PROMPT_ONLY"
  | "PUBLIC_STATIC"
  | "SAFE_STATE"
  | "PROBLEM_404"
  | "NONE";

export type CachePolicy = "PRIVATE_NO_STORE" | "PUBLIC_NO_PERSONAL_DATA";

export type ManifestEntry = Readonly<{
  id: string;
  kind: EntryKind;
  /** Repository-relative source file. */
  file: string;
  /** Export name: Server Action name, HTTP method, or hook name. */
  export?: string;
  method: "RENDER" | "GET" | "POST" | "REQUEST" | "CLI";
  /** URL path for pages/handlers (Server Actions post to their page). */
  route?: string;
  audience: Audience;
  authentication: Authentication;
  account: AccountRequirement;
  authorization: EntryAuthorization;
  /** The application query/command the entry calls (identity-access). */
  service?: string;
  /** How the target resource is bound (always server-side). */
  resource?: "OWN_ACCOUNT" | "OWN_SESSION_BY_OPAQUE_REF" | "NONE";
  output: OutputContract;
  input?: keyof typeof formSchemas;
  /** State-changing requests: Next.js Server Action origin check. */
  csrf: "NEXT_SERVER_ACTION_ORIGIN" | "NO_STATE_CHANGE";
  /** Named limiter(s) enforced by the application command. */
  rateLimit: readonly string[];
  cache: CachePolicy;
  denial:
    | "SIGN_IN_OR_NOT_FOUND"
    | "SIGN_IN_NOT_FOUND_OR_REAUTH"
    | "GENERIC_FORM_ERROR"
    | "NOT_FOUND"
    | "NONE";
  recentAuth: "NONE" | "RECENT_STAFF_AUTH" | "RECENT_STRONG_AUTH_INLINE";
  /** M1.6: whether allow/deny needs immutable audit evidence later. */
  futureAudit: "NONE" | "SECURITY_EVENT" | "SECURITY_EVENT_AND_DENIAL";
}>;

const publicPage = (
  id: string,
  file: string,
  route: string,
  cache: CachePolicy,
  output: OutputContract = "PUBLIC_STATIC",
  extra: Partial<ManifestEntry> = {},
): ManifestEntry => ({
  id,
  kind: "PAGE",
  file,
  method: "RENDER",
  route,
  audience: "PUBLIC",
  authentication: "NONE",
  account: "NONE",
  authorization: { kind: "PUBLIC_BOUNDED" },
  output,
  csrf: "NO_STATE_CHANGE",
  rateLimit: [],
  cache,
  denial: "NONE",
  recentAuth: "NONE",
  futureAudit: "NONE",
  ...extra,
});

const publicAction = (
  id: string,
  file: string,
  name: string,
  route: string,
  input: keyof typeof formSchemas,
  service: string,
  rateLimit: readonly string[],
  extra: Partial<ManifestEntry> = {},
): ManifestEntry => ({
  id,
  kind: "SERVER_ACTION",
  file,
  export: name,
  method: "POST",
  route,
  audience: "PUBLIC",
  authentication: "NONE",
  account: "NONE",
  authorization: { kind: "PUBLIC_BOUNDED" },
  service,
  resource: "NONE",
  output: "FORM_STATE",
  input,
  csrf: "NEXT_SERVER_ACTION_ORIGIN",
  rateLimit,
  cache: "PRIVATE_NO_STORE",
  denial: "GENERIC_FORM_ERROR",
  recentAuth: "NONE",
  futureAudit: "SECURITY_EVENT",
  ...extra,
});

const selfAction = (
  id: string,
  audience: "CANDIDATE" | "STAFF",
  file: string,
  name: string,
  policy: SelfServicePolicyCode,
  service: string,
  input: keyof typeof formSchemas,
  extra: Partial<ManifestEntry> = {},
): ManifestEntry => ({
  id,
  kind: "SERVER_ACTION",
  file,
  export: name,
  method: "POST",
  route: audience === "CANDIDATE" ? "/candidate/security" : "/staff/security",
  audience,
  authentication: "REQUIRED",
  account:
    audience === "CANDIDATE"
      ? "ACTIVE_VERIFIED_CANDIDATE"
      : "ACTIVE_MFA_COMPLETE_STAFF",
  authorization: { kind: "SELF_SERVICE", policy },
  service,
  resource: "OWN_ACCOUNT",
  output: "REDIRECT_ONLY",
  input,
  csrf: "NEXT_SERVER_ACTION_ORIGIN",
  rateLimit: [],
  cache: "PRIVATE_NO_STORE",
  denial: "SIGN_IN_OR_NOT_FOUND",
  recentAuth: "NONE",
  futureAudit: "SECURITY_EVENT_AND_DENIAL",
  ...extra,
});

const A = "src/app";
const publicActions = `${A}/(public)/auth-actions.ts`;
const staffPublicActions = `${A}/(public)/staff/staff-auth-actions.ts`;
const candidateActions = `${A}/(candidate)/candidate/(account)/security/actions.ts`;
const staffActions = `${A}/(staff)/staff/(account)/security/actions.ts`;

export const routeManifest: readonly ManifestEntry[] = Object.freeze([
  // ------------------------------------------------------------ framework
  {
    id: "framework.root_layout",
    kind: "LAYOUT",
    file: `${A}/layout.tsx`,
    method: "RENDER",
    route: "/",
    audience: "NONE",
    authentication: "NONE",
    account: "NONE",
    authorization: { kind: "FRAMEWORK" },
    output: "NONE",
    csrf: "NO_STATE_CHANGE",
    rateLimit: [],
    cache: "PUBLIC_NO_PERSONAL_DATA",
    denial: "NONE",
    recentAuth: "NONE",
    futureAudit: "NONE",
  },
  {
    id: "framework.not_found",
    kind: "SPECIAL",
    file: `${A}/not-found.tsx`,
    method: "RENDER",
    audience: "NONE",
    authentication: "NONE",
    account: "NONE",
    authorization: { kind: "FRAMEWORK" },
    output: "SAFE_STATE",
    csrf: "NO_STATE_CHANGE",
    rateLimit: [],
    cache: "PUBLIC_NO_PERSONAL_DATA",
    denial: "NONE",
    recentAuth: "NONE",
    futureAudit: "NONE",
  },
  {
    id: "framework.error_boundary",
    kind: "SPECIAL",
    file: `${A}/error.tsx`,
    method: "RENDER",
    audience: "NONE",
    authentication: "NONE",
    account: "NONE",
    authorization: { kind: "FRAMEWORK" },
    output: "SAFE_STATE",
    csrf: "NO_STATE_CHANGE",
    rateLimit: [],
    cache: "PUBLIC_NO_PERSONAL_DATA",
    denial: "NONE",
    recentAuth: "NONE",
    futureAudit: "NONE",
  },
  {
    id: "framework.global_error",
    kind: "SPECIAL",
    file: `${A}/global-error.tsx`,
    method: "RENDER",
    audience: "NONE",
    authentication: "NONE",
    account: "NONE",
    authorization: { kind: "FRAMEWORK" },
    output: "SAFE_STATE",
    csrf: "NO_STATE_CHANGE",
    rateLimit: [],
    cache: "PUBLIC_NO_PERSONAL_DATA",
    denial: "NONE",
    recentAuth: "NONE",
    futureAudit: "NONE",
  },
  {
    id: "framework.proxy",
    kind: "PROXY",
    file: "src/proxy.ts",
    export: "proxy",
    method: "REQUEST",
    audience: "NONE",
    authentication: "NONE",
    account: "NONE",
    authorization: { kind: "FRAMEWORK" },
    output: "NONE",
    csrf: "NO_STATE_CHANGE",
    rateLimit: [],
    cache: "PRIVATE_NO_STORE",
    denial: "NONE",
    recentAuth: "NONE",
    futureAudit: "NONE",
  },
  {
    id: "framework.instrumentation",
    kind: "INSTRUMENTATION",
    file: "src/instrumentation.ts",
    export: "onRequestError",
    method: "REQUEST",
    audience: "NONE",
    authentication: "NONE",
    account: "NONE",
    authorization: { kind: "FRAMEWORK" },
    output: "NONE",
    csrf: "NO_STATE_CHANGE",
    rateLimit: [],
    cache: "PRIVATE_NO_STORE",
    denial: "NONE",
    recentAuth: "NONE",
    futureAudit: "NONE",
  },

  // ---------------------------------------------------------- public pages
  publicPage(
    "public.home",
    `${A}/(public)/page.tsx`,
    "/",
    "PUBLIC_NO_PERSONAL_DATA",
  ),
  publicPage(
    "public.candidate_landing",
    `${A}/(candidate)/candidate/page.tsx`,
    "/candidate",
    "PRIVATE_NO_STORE",
  ),
  publicPage(
    "public.staff_landing",
    `${A}/(staff)/staff/page.tsx`,
    "/staff",
    "PRIVATE_NO_STORE",
  ),
  publicPage(
    "public.register",
    `${A}/(public)/register/page.tsx`,
    "/register",
    "PRIVATE_NO_STORE",
    "FORM_STATE",
    {
      service: "issuePublicRegistrationIntent",
    },
  ),
  publicPage(
    "public.sign_in",
    `${A}/(public)/sign-in/page.tsx`,
    "/sign-in",
    "PRIVATE_NO_STORE",
    "FORM_STATE",
  ),
  publicPage(
    "public.verify_email",
    `${A}/(public)/verify-email/page.tsx`,
    "/verify-email",
    "PRIVATE_NO_STORE",
    "FORM_STATE",
  ),
  publicPage(
    "public.recover",
    `${A}/(public)/recover/page.tsx`,
    "/recover",
    "PRIVATE_NO_STORE",
    "FORM_STATE",
  ),
  publicPage(
    "public.reset_password",
    `${A}/(public)/reset-password/page.tsx`,
    "/reset-password",
    "PRIVATE_NO_STORE",
    "FORM_STATE",
    { authentication: "CAPABILITY" },
  ),
  publicPage(
    "public.staff_activate",
    `${A}/(public)/staff/activate/page.tsx`,
    "/staff/activate",
    "PRIVATE_NO_STORE",
    "FORM_STATE",
    { authentication: "CAPABILITY", account: "INVITED_STAFF_ACTIVATION" },
  ),
  publicPage(
    "public.staff_sign_in",
    `${A}/(public)/staff/sign-in/page.tsx`,
    "/staff/sign-in",
    "PRIVATE_NO_STORE",
    "FORM_STATE",
  ),
  publicPage(
    "public.staff_mfa",
    `${A}/(public)/staff/mfa/page.tsx`,
    "/staff/mfa",
    "PRIVATE_NO_STORE",
    "FORM_STATE",
    {
      authentication: "CAPABILITY",
      account: "STAFF_FIRST_FACTOR_CHALLENGE",
      service: "hasStaffChallenge",
      denial: "SIGN_IN_OR_NOT_FOUND",
    },
  ),
  publicPage(
    "public.staff_recover",
    `${A}/(public)/staff/recover/page.tsx`,
    "/staff/recover",
    "PRIVATE_NO_STORE",
    "FORM_STATE",
  ),

  // -------------------------------------------------------- public actions
  publicAction(
    "action.register",
    publicActions,
    "registerAction",
    "/register",
    "register",
    "registerCandidate",
    ["register", "verificationSendPerEmail"],
  ),
  publicAction(
    "action.sign_in",
    publicActions,
    "signInAction",
    "/sign-in",
    "signIn",
    "signInCandidate",
    ["signInPerClient"],
  ),
  publicAction(
    "action.verify_email",
    publicActions,
    "verifyEmailAction",
    "/verify-email",
    "verifyEmail",
    "verifyCandidateEmail",
    ["sendPerClient"],
  ),
  publicAction(
    "action.resend_code",
    publicActions,
    "resendCodeAction",
    "/verify-email",
    "resendCode",
    "resendVerificationCode",
    ["sendPerClient", "verificationSendPerEmail"],
  ),
  publicAction(
    "action.recover",
    publicActions,
    "recoverAction",
    "/recover",
    "recover",
    "requestCandidateRecovery",
    ["sendPerClient", "recoverySendPerEmail"],
  ),
  publicAction(
    "action.reset_password",
    publicActions,
    "resetPasswordAction",
    "/reset-password",
    "resetPassword",
    "resetCandidatePassword",
    ["resetPerClient"],
    { authentication: "CAPABILITY" },
  ),
  publicAction(
    "action.staff_begin_activation",
    staffPublicActions,
    "beginActivationAction",
    "/staff/activate",
    "beginActivation",
    "beginStaffActivation",
    ["staffActivatePerClient"],
    {
      authentication: "CAPABILITY",
      account: "INVITED_STAFF_ACTIVATION",
      output: "ONE_TIME_SECRET_DISPLAY",
    },
  ),
  publicAction(
    "action.staff_verify_enrollment",
    staffPublicActions,
    "verifyEnrollmentAction",
    "/staff/activate",
    "verifyEnrollment",
    "verifyStaffEnrollment",
    ["staffEnrollPerAccount"],
    {
      authentication: "CAPABILITY",
      account: "INVITED_STAFF_ACTIVATION",
      output: "ONE_TIME_SECRET_DISPLAY",
    },
  ),
  publicAction(
    "action.staff_complete_activation",
    staffPublicActions,
    "completeActivationAction",
    "/staff/activate",
    "completeActivation",
    "completeStaffActivation",
    [],
    { authentication: "CAPABILITY", account: "INVITED_STAFF_ACTIVATION" },
  ),
  publicAction(
    "action.staff_sign_in",
    staffPublicActions,
    "staffSignInAction",
    "/staff/sign-in",
    "staffSignIn",
    "signInStaff",
    ["staffSignInPerClient"],
  ),
  publicAction(
    "action.staff_mfa",
    staffPublicActions,
    "staffMfaAction",
    "/staff/mfa",
    "staffMfa",
    "completeStaffMfa",
    ["staffMfaPerClient"],
    { authentication: "CAPABILITY", account: "STAFF_FIRST_FACTOR_CHALLENGE" },
  ),
  publicAction(
    "action.staff_recovery",
    staffPublicActions,
    "staffRecoveryAction",
    "/staff/recover",
    "staffRecovery",
    "requestStaffRecovery",
    ["staffRecoveryPerClient", "staffRecoveryPerEmail"],
  ),

  // ------------------------------------------- candidate account (guarded)
  {
    id: "candidate.account_guard",
    kind: "LAYOUT",
    file: `${A}/(candidate)/candidate/(account)/layout.tsx`,
    method: "RENDER",
    route: "/candidate",
    audience: "CANDIDATE",
    authentication: "REQUIRED",
    account: "ACTIVE_VERIFIED_CANDIDATE",
    authorization: { kind: "NAVIGATION_GUARD", audience: "CANDIDATE" },
    service: "navigationHint",
    output: "NONE",
    csrf: "NO_STATE_CHANGE",
    rateLimit: [],
    cache: "PRIVATE_NO_STORE",
    denial: "SIGN_IN_OR_NOT_FOUND",
    recentAuth: "NONE",
    futureAudit: "NONE",
  },
  {
    id: "candidate.security_page",
    kind: "PAGE",
    file: `${A}/(candidate)/candidate/(account)/security/page.tsx`,
    method: "RENDER",
    route: "/candidate/security",
    audience: "CANDIDATE",
    authentication: "REQUIRED",
    account: "ACTIVE_VERIFIED_CANDIDATE",
    authorization: { kind: "SELF_SERVICE", policy: "CANDIDATE_SECURITY_READ" },
    service: "queryCandidateSecurity",
    resource: "OWN_ACCOUNT",
    output: "candidate.account_security.v1",
    csrf: "NO_STATE_CHANGE",
    rateLimit: [],
    cache: "PRIVATE_NO_STORE",
    denial: "SIGN_IN_OR_NOT_FOUND",
    recentAuth: "NONE",
    futureAudit: "NONE",
  },
  selfAction(
    "candidate.change_password",
    "CANDIDATE",
    candidateActions,
    "changePasswordAction",
    "CANDIDATE_PASSWORD_CHANGE",
    "changeCandidatePassword",
    "changePassword",
    { output: "FORM_STATE", rateLimit: ["changePasswordPerAccount"] },
  ),
  selfAction(
    "candidate.revoke_session",
    "CANDIDATE",
    candidateActions,
    "revokeSessionAction",
    "CANDIDATE_SESSION_REVOKE",
    "revokeCandidateSession",
    "revokeSession",
    { resource: "OWN_SESSION_BY_OPAQUE_REF" },
  ),
  selfAction(
    "candidate.revoke_other_sessions",
    "CANDIDATE",
    candidateActions,
    "revokeOtherSessionsAction",
    "CANDIDATE_SESSIONS_REVOKE_OTHERS",
    "revokeOtherCandidateSessions",
    "noFields",
  ),
  selfAction(
    "candidate.sign_out_everywhere",
    "CANDIDATE",
    candidateActions,
    "signOutEverywhereAction",
    "CANDIDATE_SESSIONS_END_ALL",
    "signOutCandidateEverywhere",
    "noFields",
  ),
  {
    id: "candidate.sign_out",
    kind: "SERVER_ACTION",
    file: candidateActions,
    export: "signOutAction",
    method: "POST",
    route: "/candidate/security",
    // Ends only the browser's own session; reveals and reads nothing.
    audience: "MIXED",
    authentication: "OPTIONAL",
    account: "NONE",
    authorization: { kind: "PUBLIC_BOUNDED" },
    service: "signOutCandidate",
    resource: "OWN_ACCOUNT",
    output: "REDIRECT_ONLY",
    input: "noFields",
    csrf: "NEXT_SERVER_ACTION_ORIGIN",
    rateLimit: [],
    cache: "PRIVATE_NO_STORE",
    denial: "NONE",
    recentAuth: "NONE",
    futureAudit: "SECURITY_EVENT",
  },

  // ----------------------------------------------- staff account (guarded)
  {
    id: "staff.account_guard",
    kind: "LAYOUT",
    file: `${A}/(staff)/staff/(account)/layout.tsx`,
    method: "RENDER",
    route: "/staff",
    audience: "STAFF",
    authentication: "REQUIRED",
    account: "ACTIVE_MFA_COMPLETE_STAFF",
    authorization: { kind: "NAVIGATION_GUARD", audience: "STAFF" },
    service: "navigationHint",
    output: "NONE",
    csrf: "NO_STATE_CHANGE",
    rateLimit: [],
    cache: "PRIVATE_NO_STORE",
    denial: "SIGN_IN_OR_NOT_FOUND",
    recentAuth: "NONE",
    futureAudit: "NONE",
  },
  {
    id: "staff.security_page",
    kind: "PAGE",
    file: `${A}/(staff)/staff/(account)/security/page.tsx`,
    method: "RENDER",
    route: "/staff/security",
    audience: "STAFF",
    authentication: "REQUIRED",
    account: "ACTIVE_MFA_COMPLETE_STAFF",
    authorization: { kind: "SELF_SERVICE", policy: "STAFF_SECURITY_READ" },
    service: "queryStaffSecurity",
    resource: "OWN_ACCOUNT",
    output: "staff.account_security.v1",
    csrf: "NO_STATE_CHANGE",
    rateLimit: [],
    cache: "PRIVATE_NO_STORE",
    denial: "SIGN_IN_OR_NOT_FOUND",
    recentAuth: "NONE",
    futureAudit: "NONE",
  },
  {
    id: "staff.reauthenticate_page",
    kind: "PAGE",
    file: `${A}/(staff)/staff/(account)/reauthenticate/page.tsx`,
    method: "RENDER",
    route: "/staff/reauthenticate",
    audience: "STAFF",
    authentication: "REQUIRED",
    account: "ACTIVE_MFA_COMPLETE_STAFF",
    authorization: { kind: "SELF_SERVICE", policy: "STAFF_REAUTHENTICATE" },
    service: "queryStaffReauthentication",
    resource: "OWN_ACCOUNT",
    output: "PROMPT_ONLY",
    csrf: "NO_STATE_CHANGE",
    rateLimit: [],
    cache: "PRIVATE_NO_STORE",
    denial: "SIGN_IN_OR_NOT_FOUND",
    recentAuth: "NONE",
    futureAudit: "NONE",
  },
  selfAction(
    "staff.change_password",
    "STAFF",
    staffActions,
    "staffChangePasswordAction",
    "STAFF_PASSWORD_CHANGE",
    "changeStaffPassword",
    "changePassword",
    {
      output: "FORM_STATE",
      rateLimit: ["staffChangePasswordPerAccount"],
      denial: "SIGN_IN_NOT_FOUND_OR_REAUTH",
      recentAuth: "RECENT_STAFF_AUTH",
    },
  ),
  selfAction(
    "staff.regenerate_backup_codes",
    "STAFF",
    staffActions,
    "regenerateBackupCodesAction",
    "STAFF_BACKUP_CODES_REGENERATE",
    "regenerateStaffBackupCodes",
    "regenerateBackupCodes",
    {
      output: "ONE_TIME_SECRET_DISPLAY",
      rateLimit: ["staffReauthPerAccount"],
      denial: "GENERIC_FORM_ERROR",
      recentAuth: "RECENT_STRONG_AUTH_INLINE",
    },
  ),
  selfAction(
    "staff.reauthenticate",
    "STAFF",
    staffActions,
    "reauthenticateAction",
    "STAFF_REAUTHENTICATE",
    "reauthenticateStaff",
    "reauthenticate",
    {
      route: "/staff/reauthenticate",
      output: "FORM_STATE",
      rateLimit: ["staffReauthPerAccount"],
      denial: "GENERIC_FORM_ERROR",
    },
  ),
  selfAction(
    "staff.revoke_session",
    "STAFF",
    staffActions,
    "revokeStaffSessionAction",
    "STAFF_SESSION_REVOKE",
    "revokeStaffSession",
    "revokeSession",
    { resource: "OWN_SESSION_BY_OPAQUE_REF" },
  ),
  selfAction(
    "staff.revoke_other_sessions",
    "STAFF",
    staffActions,
    "revokeOtherStaffSessionsAction",
    "STAFF_SESSIONS_REVOKE_OTHERS",
    "revokeOtherStaffSessions",
    "noFields",
  ),
  selfAction(
    "staff.sign_out_everywhere",
    "STAFF",
    staffActions,
    "staffSignOutEverywhereAction",
    "STAFF_SESSIONS_END_ALL",
    "signOutStaffEverywhere",
    "noFields",
  ),
  {
    id: "staff.sign_out",
    kind: "SERVER_ACTION",
    file: staffActions,
    export: "staffSignOutAction",
    method: "POST",
    route: "/staff/security",
    audience: "MIXED",
    authentication: "OPTIONAL",
    account: "NONE",
    authorization: { kind: "PUBLIC_BOUNDED" },
    service: "signOutStaff",
    resource: "OWN_ACCOUNT",
    output: "REDIRECT_ONLY",
    input: "noFields",
    csrf: "NEXT_SERVER_ACTION_ORIGIN",
    rateLimit: [],
    cache: "PRIVATE_NO_STORE",
    denial: "NONE",
    recentAuth: "NONE",
    futureAudit: "SECURITY_EVENT",
  },

  // ------------------------------------------------ Better Auth endpoints
  ...(["GET", "POST"] as const).map((method): ManifestEntry => ({
    id: `auth_http.${method.toLowerCase()}`,
    kind: "ROUTE_HANDLER",
    file: `${A}/api/auth/[...all]/route.ts`,
    export: method,
    method,
    route: "/api/auth/[...all]",
    audience: "NONE",
    authentication: "NONE",
    account: "NONE",
    authorization: { kind: "CLOSED" },
    service: "handleAuthRequest",
    output: "PROBLEM_404",
    csrf: "NO_STATE_CHANGE",
    rateLimit: [],
    cache: "PRIVATE_NO_STORE",
    denial: "NOT_FOUND",
    recentAuth: "NONE",
    futureAudit: "NONE",
  })),

  // ------------------------------------------------- local/test harnesses
  ...(
    [
      [
        "harness.candidate_invitation",
        "scripts/auth/issue-candidate-invitation.ts",
        ["local", "test"],
      ],
      [
        "harness.staff_invitation",
        "scripts/auth/create-local-staff-invitation.ts",
        ["local", "test"],
      ],
      [
        "harness.staff_recovery",
        "scripts/auth/staff-recovery-local.ts",
        ["local", "test"],
      ],
      // Local Mailpit diagnostic: sends synthetic templates only.
      ["harness.mailpit_check", "scripts/auth/check-mailpit.ts", ["local"]],
    ] as const
  ).map(([id, file, environments]): ManifestEntry => ({
    id,
    kind: "LOCAL_HARNESS",
    file,
    method: "CLI",
    audience: "NONE",
    authentication: "NONE",
    account: "NONE",
    authorization: { kind: "LOCAL_ONLY", environments },
    output: "NONE",
    csrf: "NO_STATE_CHANGE",
    rateLimit: [],
    cache: "PRIVATE_NO_STORE",
    denial: "NONE",
    recentAuth: "NONE",
    futureAudit: "SECURITY_EVENT",
  })),
]);

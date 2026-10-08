import type { SelfServicePolicyCode } from "@/modules/identity-access/domain/self-service-policy";
import type { organizationProjectionNames } from "@/modules/organization/presentation/staff-views";
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
    }>
  /**
   * M2.1 business configuration: the named organization-module service
   * authorizes these catalog permissions through the M1 central service
   * (role, server-resolved scope, sensitivity, recent auth, reason).
   */
  | Readonly<{ kind: "PERMISSION"; permissions: readonly string[] }>
  /**
   * M2.1 start-application boundary: the verified candidate's own signed
   * handoff, re-validated against the opening's live availability.
   */
  | Readonly<{ kind: "HANDOFF_REVALIDATION" }>;

export type OutputContract =
  | "candidate.account_security.v1"
  | "staff.account_security.v1"
  | (typeof organizationProjectionNames)[number]
  /** M2.1 public-only hiring-cycle projections (classification PUBLIC). */
  | "PUBLIC_POSITION_LIST"
  | "PUBLIC_POSITION_DETAIL"
  /** M2.1 handoff boundary: closed state plus public opening fields. */
  | "HANDOFF_STATE"
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
  resource?:
    | "OWN_ACCOUNT"
    | "OWN_SESSION_BY_OPAQUE_REF"
    /** M2.1: organization-module records re-resolved on the server. */
    | "ORGANIZATION_CONFIGURATION"
    /** M2.1: a hiring cycle addressed only by its public reference. */
    | "PUBLIC_HIRING_CYCLE"
    /** M2.1: the caller's own signed start-application handoff. */
    | "OWN_HANDOFF"
    | "NONE";
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
const adminPositions = `${A}/(staff)/staff/(account)/admin/positions`;
const positionActions = `${adminPositions}/actions.ts`;

/** M2.1 staff configuration page (organization module, ADR-0013). */
const configPage = (
  id: string,
  file: string,
  route: string,
  service: string,
  output: OutputContract,
  permissions: readonly string[],
): ManifestEntry => ({
  id,
  kind: "PAGE",
  file,
  method: "RENDER",
  route,
  audience: "STAFF",
  authentication: "REQUIRED",
  account: "ACTIVE_MFA_COMPLETE_STAFF",
  authorization: { kind: "PERMISSION", permissions },
  service,
  resource: "ORGANIZATION_CONFIGURATION",
  output,
  csrf: "NO_STATE_CHANGE",
  rateLimit: [],
  cache: "PRIVATE_NO_STORE",
  denial: "SIGN_IN_OR_NOT_FOUND",
  recentAuth: "NONE",
  futureAudit: "NONE",
});

/** M2.1 staff configuration command (named, audited, idempotent). */
const configAction = (
  id: string,
  name: string,
  service: string,
  input: keyof typeof formSchemas,
  permissions: readonly string[],
  recentAuth: "NONE" | "RECENT_STAFF_AUTH",
): ManifestEntry => ({
  id,
  kind: "SERVER_ACTION",
  file: positionActions,
  export: name,
  method: "POST",
  route: "/staff/admin/positions",
  audience: "STAFF",
  authentication: "REQUIRED",
  account: "ACTIVE_MFA_COMPLETE_STAFF",
  authorization: { kind: "PERMISSION", permissions },
  service,
  resource: "ORGANIZATION_CONFIGURATION",
  output: "FORM_STATE",
  input,
  csrf: "NEXT_SERVER_ACTION_ORIGIN",
  rateLimit: [],
  cache: "PRIVATE_NO_STORE",
  denial: "SIGN_IN_NOT_FOUND_OR_REAUTH",
  recentAuth,
  futureAudit: "SECURITY_EVENT_AND_DENIAL",
});

const R = "RECENT_STAFF_AUTH" as const;

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

  // ------------------------------------- M2.1 position administration
  configPage(
    "staff.positions_page",
    `${adminPositions}/page.tsx`,
    "/staff/admin/positions",
    "queryPositionList",
    "staff.position_list.v1",
    ["position.read", "position.create"],
  ),
  configPage(
    "staff.position_new_page",
    `${adminPositions}/new/page.tsx`,
    "/staff/admin/positions/new",
    "queryPositionForm",
    "staff.position_form.v1",
    ["organization.read", "position.create"],
  ),
  configPage(
    "staff.position_page",
    `${adminPositions}/[positionId]/page.tsx`,
    "/staff/admin/positions/[positionId]",
    "queryPositionDetail",
    "staff.position_detail.v1",
    ["position.read", "job_description.read", "hiring_cycle.read"],
  ),
  configPage(
    "staff.job_description_page",
    `${adminPositions}/[positionId]/descriptions/[versionId]/page.tsx`,
    "/staff/admin/positions/[positionId]/descriptions/[versionId]",
    "queryDescriptionDetail",
    "staff.job_description_detail.v1",
    ["job_description.read"],
  ),
  configPage(
    "staff.hiring_cycle_new_page",
    `${adminPositions}/[positionId]/cycles/new/page.tsx`,
    "/staff/admin/positions/[positionId]/cycles/new",
    "queryCycleForm",
    "staff.hiring_cycle_form.v1",
    ["position.read", "hiring_cycle.create"],
  ),
  configPage(
    "staff.hiring_cycle_page",
    `${adminPositions}/[positionId]/cycles/[cycleId]/page.tsx`,
    "/staff/admin/positions/[positionId]/cycles/[cycleId]",
    "queryCycleDetail",
    "staff.hiring_cycle_detail.v1",
    ["hiring_cycle.read"],
  ),
  configPage(
    "staff.hierarchy_page",
    `${adminPositions}/hierarchy/page.tsx`,
    "/staff/admin/positions/hierarchy",
    "queryHierarchy",
    "staff.organization_hierarchy.v1",
    ["organization.read"],
  ),
  configAction(
    "staff.update_organization",
    "updateOrganizationAction",
    "updateOrganizationDetails",
    "organizationUpdate",
    ["organization.configure"],
    "NONE",
  ),
  configAction(
    "staff.activate_organization",
    "activateOrganizationAction",
    "changeOrganizationStatus",
    "configurationStatus",
    ["organization.status_change"],
    R,
  ),
  configAction(
    "staff.inactivate_organization",
    "inactivateOrganizationAction",
    "changeOrganizationStatus",
    "configurationStatus",
    ["organization.status_change"],
    R,
  ),
  configAction(
    "staff.create_branch",
    "createBranchAction",
    "createBranch",
    "branchCreate",
    ["branch.configure"],
    "NONE",
  ),
  configAction(
    "staff.update_branch",
    "updateBranchAction",
    "updateBranchDetails",
    "branchUpdate",
    ["branch.configure"],
    "NONE",
  ),
  configAction(
    "staff.activate_branch",
    "activateBranchAction",
    "changeBranchStatus",
    "configurationStatus",
    ["branch.status_change"],
    R,
  ),
  configAction(
    "staff.inactivate_branch",
    "inactivateBranchAction",
    "changeBranchStatus",
    "configurationStatus",
    ["branch.status_change"],
    R,
  ),
  configAction(
    "staff.create_team",
    "createTeamAction",
    "createTeam",
    "teamCreate",
    ["team.configure"],
    "NONE",
  ),
  configAction(
    "staff.update_team",
    "updateTeamAction",
    "updateTeamDetails",
    "teamUpdate",
    ["team.configure"],
    "NONE",
  ),
  configAction(
    "staff.activate_team",
    "activateTeamAction",
    "changeTeamStatus",
    "configurationStatus",
    ["team.status_change"],
    R,
  ),
  configAction(
    "staff.inactivate_team",
    "inactivateTeamAction",
    "changeTeamStatus",
    "configurationStatus",
    ["team.status_change"],
    R,
  ),
  configAction(
    "staff.create_position",
    "createPositionAction",
    "createPosition",
    "positionCreate",
    ["position.create"],
    "NONE",
  ),
  configAction(
    "staff.update_position",
    "updatePositionAction",
    "updatePositionDetails",
    "positionUpdate",
    ["position.edit"],
    "NONE",
  ),
  configAction(
    "staff.activate_position",
    "activatePositionAction",
    "changePositionStatus",
    "configurationStatus",
    ["position.activate"],
    R,
  ),
  configAction(
    "staff.inactivate_position",
    "inactivatePositionAction",
    "changePositionStatus",
    "configurationStatus",
    ["position.activate"],
    R,
  ),
  configAction(
    "staff.retire_position",
    "retirePositionAction",
    "changePositionStatus",
    "configurationStatus",
    ["position.retire"],
    R,
  ),
  configAction(
    "staff.create_job_description_draft",
    "createDescriptionDraftAction",
    "createDescriptionDraft",
    "descriptionCreate",
    ["job_description.edit"],
    "NONE",
  ),
  configAction(
    "staff.update_job_description_draft",
    "updateDescriptionDraftAction",
    "updateDescriptionDraftContent",
    "descriptionUpdate",
    ["job_description.edit"],
    "NONE",
  ),
  configAction(
    "staff.publish_job_description",
    "publishDescriptionAction",
    "publishDescription",
    "configurationStatus",
    ["job_description.publish"],
    R,
  ),
  configAction(
    "staff.create_hiring_cycle",
    "createHiringCycleAction",
    "createHiringCycle",
    "cycleCreate",
    ["hiring_cycle.create"],
    "NONE",
  ),
  configAction(
    "staff.update_hiring_cycle",
    "updateHiringCycleAction",
    "updateHiringCycleDraft",
    "cycleUpdate",
    ["hiring_cycle.edit"],
    "NONE",
  ),
  configAction(
    "staff.publish_hiring_cycle",
    "publishHiringCycleAction",
    "transitionHiringCycle",
    "configurationStatus",
    ["hiring_cycle.publish"],
    R,
  ),
  configAction(
    "staff.open_hiring_cycle",
    "openHiringCycleAction",
    "transitionHiringCycle",
    "configurationStatus",
    ["hiring_cycle.open"],
    R,
  ),
  configAction(
    "staff.close_hiring_cycle",
    "closeHiringCycleAction",
    "transitionHiringCycle",
    "configurationStatus",
    ["hiring_cycle.close"],
    R,
  ),
  configAction(
    "staff.cancel_hiring_cycle",
    "cancelHiringCycleAction",
    "transitionHiringCycle",
    "configurationStatus",
    ["hiring_cycle.cancel"],
    R,
  ),
  configAction(
    "staff.archive_hiring_cycle",
    "archiveHiringCycleAction",
    "transitionHiringCycle",
    "configurationStatus",
    ["hiring_cycle.archive"],
    R,
  ),

  // ------------------------------- M2.1 public positions and handoff
  publicPage(
    "public.positions",
    `${A}/(public)/positions/page.tsx`,
    "/positions",
    "PUBLIC_NO_PERSONAL_DATA",
    "PUBLIC_POSITION_LIST",
    { service: "queryPublicPositions", resource: "PUBLIC_HIRING_CYCLE" },
  ),
  publicPage(
    "public.position_detail",
    `${A}/(public)/positions/[positionId]/page.tsx`,
    "/positions/[positionId]",
    "PUBLIC_NO_PERSONAL_DATA",
    "PUBLIC_POSITION_DETAIL",
    {
      service: "queryPublicPosition",
      resource: "PUBLIC_HIRING_CYCLE",
      denial: "NOT_FOUND",
    },
  ),
  publicPage(
    "public.start_application_page",
    `${A}/(public)/apply/[positionId]/page.tsx`,
    "/apply/[positionId]",
    "PRIVATE_NO_STORE",
    "PUBLIC_POSITION_DETAIL",
    {
      service: "queryHandoffOpening",
      resource: "PUBLIC_HIRING_CYCLE",
      denial: "NOT_FOUND",
    },
  ),
  publicAction(
    "public.start_application",
    `${A}/(public)/apply/[positionId]/actions.ts`,
    "startApplicationAction",
    "/apply/[positionId]",
    "startApplication",
    "beginApplicationHandoff",
    [],
    { resource: "PUBLIC_HIRING_CYCLE", output: "REDIRECT_ONLY" },
  ),
  {
    id: "candidate.application_start",
    kind: "PAGE",
    file: `${A}/(candidate)/candidate/(account)/applications/new/page.tsx`,
    method: "RENDER",
    route: "/candidate/applications/new",
    audience: "CANDIDATE",
    authentication: "REQUIRED",
    account: "ACTIVE_VERIFIED_CANDIDATE",
    authorization: { kind: "HANDOFF_REVALIDATION" },
    service: "confirmApplicationHandoff",
    resource: "OWN_HANDOFF",
    output: "HANDOFF_STATE",
    csrf: "NO_STATE_CHANGE",
    rateLimit: [],
    cache: "PRIVATE_NO_STORE",
    denial: "SIGN_IN_OR_NOT_FOUND",
    recentAuth: "NONE",
    futureAudit: "NONE",
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

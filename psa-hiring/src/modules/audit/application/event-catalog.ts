import type {
  AuditCategory,
  EventOutcome,
  TargetType,
} from "../domain/vocabulary";

// The single reviewed event catalog (packet M1.6 §9, ADR-0012). Every
// event the application emits is registered here with its stream,
// category, outcome, actor/target rules, required facts, the facts it may
// carry, transaction semantics, retention class, and projectable metadata.
//
// Stable codes: a registered (name, version) is never repurposed. A change
// of meaning or shape adds a new version. Unknown names, versions, or
// facts reject before any write.
//
// Streams:
// - AUDIT: compliance history (audit_event), authorization scoped.
// - SECURITY: bounded authentication/abuse telemetry (security_event),
//   never shown as business history.
// - TELEMETRY: approved routine signals that stay operational log lines
//   only (ROLE_PERMISSION_MATRIX §17 allows summarized telemetry).
//
// Atomicity:
// - IN_TRANSACTION: appended inside the mutation's own transaction.
// - PROVIDER_COMMITTED: Better Auth commits the state change itself; the
//   event is appended in a bounded standalone transaction right after the
//   provider call. Not atomic; failure withholds success (ADR-0012 §5).
// - STANDALONE_REQUIRED: a denial/failure/read with no mutation; appended
//   once in a bounded standalone transaction, never converting a denial.
// - LOG_ONLY: TELEMETRY stream.

export type Atomicity =
  "IN_TRANSACTION" | "PROVIDER_COMMITTED" | "STANDALONE_REQUIRED" | "LOG_ONLY";

/** Narrow typed facts an emitter may supply. Never free text. */
export type FactKey =
  | "accountRef"
  | "actorRef"
  | "systemActor"
  | "recordRef"
  | "category"
  | "permissionCode"
  | "roleCode"
  | "scopeType"
  | "effective"
  | "reasonCode"
  | "policyVersion"
  | "correlationId"
  | "previousVersion"
  | "newVersion"
  | "count"
  | "methodCategory"
  | "organizationRef"
  | "candidacyRef"
  | "filterCodes";

/** Who the actor is: the subject itself, a distinct acting account, or the system. */
export type ActorRule = "SUBJECT" | "ACTOR" | "ACTOR_OR_SYSTEM" | "SYSTEM";

export type EventDefinition = Readonly<{
  name: string;
  version: number;
  stream: "AUDIT" | "SECURITY" | "TELEMETRY";
  category: AuditCategory | null;
  outcome: EventOutcome;
  atomicity: Atomicity;
  action: string;
  actor: ActorRule;
  target: TargetType | null;
  /** Which fact supplies the target ID. */
  targetFrom: "accountRef" | "recordRef" | null;
  requires: readonly FactKey[];
  allows: readonly FactKey[];
  /** One success row per (target, new record version). */
  idempotent: boolean;
  /** Metadata keys an authorized audit projection may show. */
  projectable: readonly string[];
}>;

type Spec = Omit<
  EventDefinition,
  "version" | "projectable" | "idempotent" | "allows"
> &
  Partial<Pick<EventDefinition, "projectable" | "idempotent" | "allows">>;

const common: readonly FactKey[] = ["correlationId", "policyVersion"];

function def(spec: Spec): EventDefinition {
  return Object.freeze({
    version: 1,
    idempotent: false,
    projectable: [],
    ...spec,
    allows: Object.freeze([
      ...new Set([...common, ...spec.requires, ...(spec.allows ?? [])]),
    ]),
  });
}

// ------------------------------------------------------------ builders

const identity = (
  name: string,
  action: string,
  extra: Partial<Spec> = {},
): EventDefinition =>
  def({
    name,
    stream: "AUDIT",
    category: "IDENTITY",
    outcome: "SUCCEEDED",
    atomicity: "IN_TRANSACTION",
    action,
    actor: "SUBJECT",
    target: "USER_ACCOUNT",
    targetFrom: "accountRef",
    requires: ["accountRef"],
    ...extra,
  });

const providerCommitted = (
  name: string,
  action: string,
  extra: Partial<Spec> = {},
): EventDefinition =>
  identity(name, action, { atomicity: "PROVIDER_COMMITTED", ...extra });

const security = (
  name: string,
  outcome: EventOutcome,
  extra: Partial<Spec> = {},
): EventDefinition =>
  def({
    name,
    stream: "SECURITY",
    category: null,
    outcome,
    atomicity: "STANDALONE_REQUIRED",
    action: name.split(".")[1].toUpperCase(),
    actor: "SYSTEM",
    target: null,
    targetFrom: null,
    requires: ["category"],
    allows: ["accountRef", "permissionCode", "reasonCode"],
    ...extra,
  });

const telemetry = (name: string): EventDefinition =>
  def({
    name,
    stream: "TELEMETRY",
    category: null,
    outcome: "SUCCEEDED",
    atomicity: "LOG_ONLY",
    action: name.split(".")[1].toUpperCase(),
    actor: "SYSTEM",
    target: null,
    targetFrom: null,
    requires: [],
    // Closed codes only (never free text): the authorizer's operational
    // policy-unavailable signal names the permission code (M1.7 D2).
    allows: [
      "accountRef",
      "recordRef",
      "category",
      "permissionCode",
      "reasonCode",
    ],
  });

const selfService: readonly FactKey[] = ["permissionCode", "policyVersion"];

const invitation = (
  name: string,
  action: string,
  extra: Partial<Spec> = {},
): EventDefinition =>
  def({
    name,
    stream: "AUDIT",
    category: "IDENTITY",
    outcome: "SUCCEEDED",
    atomicity: "IN_TRANSACTION",
    action,
    actor: "ACTOR_OR_SYSTEM",
    target: "STAFF_INVITATION",
    targetFrom: "recordRef",
    requires: ["recordRef"],
    allows: ["actorRef", "systemActor", "accountRef"],
    ...extra,
  });

const recovery = (
  name: string,
  action: string,
  extra: Partial<Spec> = {},
): EventDefinition =>
  def({
    name,
    stream: "AUDIT",
    category: "IDENTITY",
    outcome: "SUCCEEDED",
    atomicity: "IN_TRANSACTION",
    action,
    actor: "ACTOR",
    target: "STAFF_RECOVERY_CASE",
    targetFrom: "recordRef",
    requires: ["recordRef", "actorRef"],
    allows: ["accountRef"],
    ...extra,
  });

const assignment = (
  name: string,
  action: string,
  extra: Partial<Spec> = {},
): EventDefinition =>
  def({
    name,
    stream: "AUDIT",
    category: "ACCESS_CONTROL",
    outcome: "SUCCEEDED",
    atomicity: "IN_TRANSACTION",
    action,
    actor: "ACTOR_OR_SYSTEM",
    target: "ROLE_ASSIGNMENT",
    targetFrom: "recordRef",
    requires: [
      "recordRef",
      "accountRef",
      "roleCode",
      "scopeType",
      "newVersion",
    ],
    allows: [
      "actorRef",
      "systemActor",
      "effective",
      "permissionCode",
      "reasonCode",
      "previousVersion",
    ],
    idempotent: true,
    projectable: [
      "assigned_role_code",
      "assigned_scope_type",
      "policy_version",
    ],
    ...extra,
  });

// ------------------------------------------------------------- catalog

const definitions: readonly EventDefinition[] = [
  // M1.2 candidate registration, verification, sign-in, recovery.
  telemetry("auth.registration_requested"),
  identity("auth.registration_account_created", "CANDIDATE_REGISTER", {
    actor: "SUBJECT",
  }),
  telemetry("auth.verification_sent"),
  providerCommitted("auth.verification_completed", "EMAIL_VERIFY"),
  security("auth.verification_failed", "FAILED"),
  providerCommitted("auth.sign_in_succeeded", "SIGN_IN", {
    allows: ["methodCategory"],
    projectable: ["method_category"],
  }),
  security("auth.sign_in_failed", "FAILED"),
  providerCommitted("auth.sign_out", "SIGN_OUT", {
    atomicity: "STANDALONE_REQUIRED",
  }),
  telemetry("auth.recovery_requested"),
  telemetry("auth.recovery_email_sent"),
  providerCommitted("auth.recovery_completed", "PASSWORD_RESET"),
  security("auth.recovery_failed", "FAILED"),
  providerCommitted("auth.password_changed", "PASSWORD_CHANGE", {
    allows: selfService,
  }),
  security("auth.password_change_failed", "FAILED"),
  identity("auth.session_revoked", "SESSION_REVOKE", {
    requires: ["accountRef", "permissionCode"],
    allows: ["count"],
    projectable: ["affected_count"],
  }),
  identity("auth.sessions_revoked", "SESSIONS_REVOKE", {
    requires: ["accountRef", "permissionCode", "count"],
    projectable: ["affected_count"],
  }),
  security("auth.rate_limited", "DENIED"),

  // M1.1 restriction primitives (system actor until administration UI).
  identity("account.sessions_revoked_by_system", "SESSIONS_REVOKE", {
    actor: "SYSTEM",
    requires: ["accountRef", "count"],
    allows: ["systemActor"],
    projectable: ["affected_count"],
  }),
  identity("account.restricted", "ACCOUNT_RESTRICT", {
    actor: "SYSTEM",
    requires: ["accountRef", "reasonCode", "newVersion"],
    allows: ["systemActor", "previousVersion", "count"],
    idempotent: true,
    projectable: ["affected_count"],
  }),

  // M1.3 staff invitation, activation, MFA, recent auth, recovery.
  invitation("staff.invitation_issued", "INVITATION_ISSUE"),
  invitation("staff.invitation_superseded", "INVITATION_SUPERSEDE"),
  invitation("staff.invitation_revoked", "INVITATION_REVOKE"),
  invitation("staff.invitation_expired", "INVITATION_EXPIRE", {
    actor: "SYSTEM",
  }),
  invitation("staff.invitation_accepted", "INVITATION_ACCEPT", {
    actor: "SUBJECT",
    requires: ["recordRef", "accountRef"],
  }),
  security("staff.invitation_refused", "DENIED", {
    allows: ["accountRef", "recordRef"],
  }),
  identity("staff.activation_started", "STAFF_ACTIVATION_START", {
    allows: ["recordRef"],
  }),
  identity("staff.activation_completed", "STAFF_ACTIVATE"),
  security("staff.activation_failed", "FAILED"),
  providerCommitted("staff.mfa_enrolled", "MFA_ENROLL", {
    allows: ["methodCategory"],
    projectable: ["method_category"],
  }),
  providerCommitted(
    "staff.backup_codes_regenerated",
    "BACKUP_CODES_REGENERATE",
    {
      allows: selfService,
    },
  ),
  identity("staff.mfa_reset", "MFA_RESET", {
    actor: "ACTOR",
    requires: ["accountRef", "actorRef", "recordRef"],
  }),
  telemetry("staff.sign_in_first_factor_succeeded"),
  security("staff.sign_in_first_factor_failed", "FAILED"),
  telemetry("staff.mfa_challenge_succeeded"),
  security("staff.mfa_challenge_failed", "FAILED"),
  security("staff.mfa_locked", "DENIED"),
  providerCommitted("staff.backup_code_used", "BACKUP_CODE_USE"),
  security("staff.reauth_challenged", "DENIED"),
  providerCommitted("staff.reauth_succeeded", "REAUTHENTICATE", {
    allows: ["methodCategory"],
    projectable: ["method_category"],
  }),
  security("staff.reauth_failed", "FAILED"),
  recovery("staff.recovery_requested", "RECOVERY_REQUEST", {
    actor: "SUBJECT",
    requires: ["recordRef", "accountRef"],
    allows: [],
  }),
  recovery("staff.recovery_verification_started", "RECOVERY_VERIFY_START"),
  recovery("staff.recovery_identity_verified", "RECOVERY_IDENTITY_VERIFY"),
  recovery("staff.recovery_approved", "RECOVERY_APPROVE"),
  recovery("staff.recovery_rejected", "RECOVERY_REJECT"),
  recovery("staff.recovery_cancelled", "RECOVERY_CANCEL"),
  recovery("staff.recovery_expired", "RECOVERY_EXPIRE", {
    actor: "ACTOR_OR_SYSTEM",
    requires: ["recordRef"],
    allows: ["actorRef", "systemActor", "accountRef"],
  }),
  recovery("staff.recovery_completed", "RECOVERY_COMPLETE"),
  security("staff.recovery_denied", "DENIED", {
    allows: ["accountRef", "recordRef"],
  }),
  identity("staff.session_revoked", "SESSION_REVOKE", {
    requires: ["accountRef", "permissionCode"],
    allows: ["count"],
    projectable: ["affected_count"],
  }),
  identity("staff.sessions_revoked", "SESSIONS_REVOKE", {
    requires: ["accountRef", "permissionCode", "count"],
    projectable: ["affected_count"],
  }),
  providerCommitted("staff.password_changed", "PASSWORD_CHANGE", {
    allows: selfService,
  }),
  security("staff.password_change_failed", "FAILED"),
  providerCommitted("staff.sign_out", "SIGN_OUT", {
    atomicity: "STANDALONE_REQUIRED",
  }),

  // M1.4 authorization (ADR-0005).
  assignment("authz.assignment_proposed", "ROLE_ASSIGNMENT_PROPOSE"),
  assignment("authz.assignment_approved", "ROLE_ASSIGNMENT_APPROVE"),
  assignment("authz.assignment_rejected", "ROLE_ASSIGNMENT_REJECT"),
  assignment("authz.assignment_revoked", "ROLE_ASSIGNMENT_REVOKE"),
  assignment("authz.assignment_superseded", "ROLE_ASSIGNMENT_SUPERSEDE"),
  security("authz.assignment_refused", "DENIED", {
    requires: ["reasonCode"],
    allows: ["accountRef", "recordRef", "roleCode", "category"],
  }),
  identity("authz.subject_version_changed", "AUTHORIZATION_VERSION_CHANGE", {
    category: "ACCESS_CONTROL",
    actor: "ACTOR_OR_SYSTEM",
    requires: ["accountRef", "newVersion"],
    allows: ["actorRef", "systemActor", "previousVersion"],
    idempotent: true,
    projectable: ["policy_version"],
  }),
  def({
    name: "authz.catalog_applied",
    stream: "AUDIT",
    category: "CONFIGURATION",
    outcome: "SUCCEEDED",
    atomicity: "IN_TRANSACTION",
    action: "AUTHORIZATION_CATALOG_APPLY",
    actor: "SYSTEM",
    target: "AUTHORIZATION_CATALOG",
    targetFrom: null,
    requires: ["policyVersion", "systemActor"],
    projectable: ["policy_version"],
  }),
  def({
    name: "authz.high_risk_denied",
    stream: "AUDIT",
    category: "ACCESS_CONTROL",
    outcome: "DENIED",
    atomicity: "STANDALONE_REQUIRED",
    action: "AUTHORIZE",
    actor: "ACTOR",
    target: null,
    targetFrom: null,
    requires: ["actorRef", "permissionCode", "reasonCode"],
    // Placement of the denied resource once M2 records carry one.
    allows: ["organizationRef", "candidacyRef"],
    projectable: ["policy_version"],
  }),
  telemetry("authz.policy_unavailable"),

  // M1.5 route/field authorization (ADR-0011).
  security("authz.self_service_denied", "DENIED", {
    requires: ["permissionCode", "reasonCode"],
    allows: ["accountRef", "category"],
  }),
  def({
    name: "authz.restricted_access_allowed",
    stream: "AUDIT",
    category: "RESTRICTED_ACCESS",
    outcome: "SUCCEEDED",
    atomicity: "STANDALONE_REQUIRED",
    action: "RESTRICTED_READ",
    actor: "ACTOR",
    target: "PROTECTED_RESOURCE",
    targetFrom: "recordRef",
    requires: ["actorRef", "permissionCode", "recordRef"],
    allows: ["effective", "organizationRef", "candidacyRef"],
    projectable: ["policy_version"],
  }),

  // M1.6 audit access and integrity.
  def({
    name: "audit.query_executed",
    stream: "AUDIT",
    category: "AUDIT_ACCESS",
    outcome: "SUCCEEDED",
    atomicity: "STANDALONE_REQUIRED",
    action: "AUDIT_QUERY",
    actor: "ACTOR",
    target: "AUDIT_LOG",
    targetFrom: null,
    requires: ["actorRef", "permissionCode", "count", "filterCodes"],
    allows: ["effective"],
    projectable: ["affected_count", "filter_codes"],
  }),
  def({
    name: "audit.query_denied",
    stream: "AUDIT",
    category: "AUDIT_ACCESS",
    outcome: "DENIED",
    atomicity: "STANDALONE_REQUIRED",
    action: "AUDIT_QUERY",
    actor: "ACTOR",
    target: "AUDIT_LOG",
    targetFrom: null,
    requires: ["actorRef", "permissionCode", "reasonCode"],
  }),
  security("audit.integrity_verification_failed", "FAILED", {
    requires: ["reasonCode"],
    allows: [],
  }),
];

const registry = new Map<string, EventDefinition>();
for (const definition of definitions) {
  const key = `${definition.name}@${definition.version}`;
  if (registry.has(key)) throw new Error("duplicate catalog entry");
  registry.set(key, definition);
}

export const eventCatalog: readonly EventDefinition[] =
  Object.freeze(definitions);

/** The current version of every registered event name. */
export const catalogEventNames = [
  "auth.registration_requested",
  "auth.registration_account_created",
  "auth.verification_sent",
  "auth.verification_completed",
  "auth.verification_failed",
  "auth.sign_in_succeeded",
  "auth.sign_in_failed",
  "auth.sign_out",
  "auth.recovery_requested",
  "auth.recovery_email_sent",
  "auth.recovery_completed",
  "auth.recovery_failed",
  "auth.password_changed",
  "auth.password_change_failed",
  "auth.session_revoked",
  "auth.sessions_revoked",
  "auth.rate_limited",
  "account.sessions_revoked_by_system",
  "account.restricted",
  "staff.invitation_issued",
  "staff.invitation_superseded",
  "staff.invitation_revoked",
  "staff.invitation_expired",
  "staff.invitation_accepted",
  "staff.invitation_refused",
  "staff.activation_started",
  "staff.activation_completed",
  "staff.activation_failed",
  "staff.mfa_enrolled",
  "staff.backup_codes_regenerated",
  "staff.mfa_reset",
  "staff.sign_in_first_factor_succeeded",
  "staff.sign_in_first_factor_failed",
  "staff.mfa_challenge_succeeded",
  "staff.mfa_challenge_failed",
  "staff.mfa_locked",
  "staff.backup_code_used",
  "staff.reauth_challenged",
  "staff.reauth_succeeded",
  "staff.reauth_failed",
  "staff.recovery_requested",
  "staff.recovery_verification_started",
  "staff.recovery_identity_verified",
  "staff.recovery_approved",
  "staff.recovery_rejected",
  "staff.recovery_cancelled",
  "staff.recovery_expired",
  "staff.recovery_completed",
  "staff.recovery_denied",
  "staff.session_revoked",
  "staff.sessions_revoked",
  "staff.password_changed",
  "staff.password_change_failed",
  "staff.sign_out",
  "authz.assignment_proposed",
  "authz.assignment_approved",
  "authz.assignment_rejected",
  "authz.assignment_revoked",
  "authz.assignment_superseded",
  "authz.assignment_refused",
  "authz.subject_version_changed",
  "authz.catalog_applied",
  "authz.high_risk_denied",
  "authz.policy_unavailable",
  "authz.self_service_denied",
  "authz.restricted_access_allowed",
  "audit.query_executed",
  "audit.query_denied",
  "audit.integrity_verification_failed",
] as const;
export type CatalogEventName = (typeof catalogEventNames)[number];

/** Looks up a registered definition; null for unknown name or version. */
export function findEventDefinition(
  name: string,
  version = 1,
): EventDefinition | null {
  return registry.get(`${name}@${version}`) ?? null;
}

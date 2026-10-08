// Closed audit vocabulary (packet M1.6 §7–§9, ADR-0012). Every value here
// is also enforced by a database CHECK constraint in
// drizzle/0004_audit_foundation.sql; a unit test keeps the two in step.
// Stable codes only: display labels are a presentation concern.

export const ENVELOPE_SCHEMA_VERSION = 1;
export const CANONICALIZATION_VERSION = 1;

export const eventStreams = ["AUDIT", "SECURITY"] as const;
export type EventStream = (typeof eventStreams)[number];

export const auditCategories = [
  "IDENTITY",
  "ACCESS_CONTROL",
  "SECURITY",
  "RESTRICTED_ACCESS",
  "CONFIGURATION",
  "AUDIT_ACCESS",
] as const;
export type AuditCategory = (typeof auditCategories)[number];

export const eventOutcomes = ["SUCCEEDED", "DENIED", "FAILED"] as const;
export type EventOutcome = (typeof eventOutcomes)[number];

export const actorTypes = ["USER", "SERVICE", "SYSTEM", "ANONYMOUS"] as const;
export type ActorType = (typeof actorTypes)[number];

export const eventSources = [
  "WEB",
  "API",
  "JOB",
  "PROVIDER",
  "SYSTEM",
  "LOCAL_TEST",
] as const;
export type EventSource = (typeof eventSources)[number];

/** Mirrors the identity-access scope types (ADR-0005); a test asserts it. */
export const auditScopeTypes = [
  "ASSIGNED_RECORDS",
  "TEAM",
  "BRANCH",
  "ORGANIZATION",
  "AUDIT_ASSIGNMENT",
] as const;
export type AuditScopeType = (typeof auditScopeTypes)[number];

export const targetTypes = [
  "USER_ACCOUNT",
  "STAFF_INVITATION",
  "STAFF_RECOVERY_CASE",
  "ROLE_ASSIGNMENT",
  "AUTHORIZATION_CATALOG",
  "PROTECTED_RESOURCE",
  "AUDIT_LOG",
  // M2.1 organization configuration (packet M2.1 §20).
  "ORGANIZATION",
  "BRANCH",
  "TEAM",
  "POSITION",
  "JOB_DESCRIPTION_VERSION",
  "HIRING_CYCLE",
] as const;
export type TargetType = (typeof targetTypes)[number];

/**
 * Retention classes, not durations. Final legal durations, disposition,
 * and legal hold are M9.6; nothing in M1.6 deletes audit or security rows.
 */
export const retentionClasses = [
  "AUDIT_STANDARD_UNSET",
  "SECURITY_STANDARD_UNSET",
] as const;
export type RetentionClass = (typeof retentionClasses)[number];

export const codePattern = /^[A-Z][A-Z0-9_]{0,63}$/;
export const eventNamePattern = /^[a-z][a-z0-9_]{0,31}\.[a-z][a-z0-9_]{0,62}$/;
export const permissionPattern = /^[a-z][a-z0-9_.]{0,99}$/;
export const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Chain partitions are derived on the server only (ADR-0012). */
export const partitionPattern =
  /^(?:(?:IDENTITY|SECURITY):[0-9a-f]{2}|ORG:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

/** Number of global identity/security partitions (hot-lock bound). */
export const GLOBAL_PARTITION_BUCKETS = 16;

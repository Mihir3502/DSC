// Closed authorization vocabularies (packet M1.4 §7–§13, ADR-0005). Pure
// and framework-neutral. Every value the authorization service accepts or
// returns is drawn from one of these sets; anything else denies.

function guard<T extends string>(values: readonly T[]) {
  const set = new Set<string>(values);
  return (value: unknown): value is T =>
    typeof value === "string" && set.has(value);
}

/** Stable Release 1 role codes (ROLE_PERMISSION_MATRIX §4, DATA_MODEL §4.3). */
export const roleCodes = [
  "CANDIDATE",
  "RECRUITER",
  "HR_SPECIALIST",
  "CLASSIFICATION_REVIEWER",
  "COMPLIANCE_REVIEWER",
  "TRAINER_EVALUATOR",
  "PSA_MANAGER",
  "SYSTEM_ADMINISTRATOR",
  "AUDITOR_READ_ONLY",
] as const;
export type RoleCode = (typeof roleCodes)[number];
export const isRoleCode = guard(roleCodes);

export const principalTypes = ["CANDIDATE", "STAFF"] as const;
export type PrincipalType = (typeof principalTypes)[number];

export const catalogStatuses = ["ACTIVE", "RETIRED"] as const;
export type CatalogStatus = (typeof catalogStatuses)[number];

/** Initial assignment scope types (packet §10.1). */
export const scopeTypes = [
  "ASSIGNED_RECORDS",
  "TEAM",
  "BRANCH",
  "ORGANIZATION",
  "AUDIT_ASSIGNMENT",
] as const;
export type ScopeType = (typeof scopeTypes)[number];
export const isScopeType = guard(scopeTypes);

/** Approved data classifications (ROLE_PERMISSION_MATRIX §6). */
export const sensitivityLevels = [
  "PUBLIC",
  "INTERNAL",
  "CONFIDENTIAL_PERSONNEL",
  "RESTRICTED_IDENTITY_FINANCIAL",
  "RESTRICTED_SCREENING_MEDICAL",
  "SECURITY_AUDIT_RESTRICTED",
] as const;
export type SensitivityLevel = (typeof sensitivityLevels)[number];
export const isSensitivityLevel = guard(sensitivityLevels);

/** Kinds of operation a permission authorizes (packet §11.1). */
export const operations = [
  "READ",
  "CREATE",
  "EDIT",
  "REVIEW",
  "APPROVE",
  "DOWNLOAD",
  "EXPORT",
  "CONFIGURE",
  "ADMINISTER",
] as const;
export type Operation = (typeof operations)[number];
export const isOperation = guard(operations);

/**
 * Which part of the system a permission belongs to. TECHNICAL permissions
 * never reach business records; CANDIDATE_SELF permissions require the
 * candidate ownership relationship instead of a staff assignment.
 */
export const permissionDomains = [
  "BUSINESS",
  "TECHNICAL",
  "CANDIDATE_SELF",
] as const;
export type PermissionDomain = (typeof permissionDomains)[number];

/** Closed safe denial reasons. M1.5 adapters map them to 401/403/404/step-up. */
export const denialReasons = [
  "UNAUTHENTICATED",
  "ACCOUNT_INACTIVE",
  "INVALID_CONTEXT",
  "PERMISSION_UNKNOWN",
  "PERMISSION_MISSING",
  "ASSIGNMENT_INACTIVE",
  "OWNERSHIP_UNAVAILABLE",
  "SCOPE_MISMATCH",
  "SCOPE_UNAVAILABLE",
  "CONDITION_UNMET",
  "SENSITIVITY_DENIED",
  "WORKFLOW_STATE_DENIED",
  "SEPARATION_CONFLICT",
  "SEPARATION_FACTS_MISSING",
  "RECENT_AUTH_REQUIRED",
  "POLICY_UNAVAILABLE",
] as const;
export type DenialReason = (typeof denialReasons)[number];

export const assignmentStatuses = [
  "PROPOSED",
  "ACTIVE",
  "REJECTED",
  "REVOKED",
  "SUPERSEDED",
] as const;
export type AssignmentStatus = (typeof assignmentStatuses)[number];

/** Why an assignment was proposed. Codes only; never free text. */
export const assignmentReasonCodes = [
  "NEW_ACCESS",
  "ROLE_CHANGE",
  "SCOPE_CHANGE",
  "EFFECTIVE_DATE_CHANGE",
  "TEMPORARY_COVERAGE",
  "AUDIT_ENGAGEMENT",
  "ACCESS_REVIEW",
  "CORRECTION",
] as const;
export type AssignmentReasonCode = (typeof assignmentReasonCodes)[number];
export const isAssignmentReasonCode = guard(assignmentReasonCodes);

/** Why an assignment was revoked, rejected, or superseded. */
export const revocationReasonCodes = [
  "ACCESS_REVIEW",
  "ROLE_CHANGE",
  "SEPARATION",
  "SECURITY_INCIDENT",
  "PROPOSAL_REJECTED",
  "CORRECTION",
  "SUPERSEDED",
] as const;
export type RevocationReasonCode = (typeof revocationReasonCodes)[number];
export const isRevocationReasonCode = guard(revocationReasonCodes);

/** Opaque reason reference (ticket/case key); never free text. */
export const reasonReferencePattern = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * Designations required by "if designated / if configured" matrix cells.
 * No designation source exists before later milestones, so every grant
 * conditioned on one denies until a resolver adapter provides it.
 */
export const designations = [
  "PRESCREEN_APPROVER",
  "OFFER_APPROVER",
  "CLASSIFICATION_APPROVER",
  "ONBOARDING_APPROVER",
  "RESTRICTED_IDENTITY_REVIEWER",
  "FINAL_REVIEWER",
  "READINESS_APPROVER",
  "RESTRICTED_AUDIT_REVIEWER",
  "CONFIGURATION_APPROVER",
  "RETENTION_AUTHORITY",
] as const;
export type Designation = (typeof designations)[number];

/** Record relationships required by "if interviewer / if evaluator" cells. */
export const participantRelationships = ["INTERVIEWER", "EVALUATOR"] as const;
export type ParticipantRelationship = (typeof participantRelationships)[number];

/** Hold categories for limited hold authority (matrix §7, §8). */
export const holdCategories = [
  "DOCUMENT",
  "CLASSIFICATION",
  "TRAINING_COMPETENCY",
] as const;
export type HoldCategory = (typeof holdCategories)[number];
export const isHoldCategory = guard(holdCategories);

/** Named separation-of-duties policies (matrix §9.1). */
export const separationPolicyCodes = [
  "CLASSIFICATION_SELF_APPROVAL",
  "CANDIDATE_SELF_VERIFICATION",
  "RESTRICTED_RESULT_ENTRANT",
  "SIGNED_EVALUATION_IMMUTABLE",
  "OFFER_SELF_APPROVAL",
  "READINESS_APPROVAL",
  "AUDIT_SELF_MODIFICATION",
  "EXPORT_APPROVAL",
] as const;
export type SeparationPolicyCode = (typeof separationPolicyCodes)[number];

/** Configurable two-person approval hooks (matrix §9.2). */
export const dualControlHooks = [
  "CLASSIFICATION_DECISION",
  "HIGH_RISK_SCREENING_DISPOSITION",
  "OFFER_COMPENSATION_THRESHOLD",
  "MANUAL_COMPLIANCE_WAIVER",
  "FINAL_READINESS",
  "RESTRICTED_EXPORT",
  "RETENTION_LEGAL_HOLD",
] as const;
export type DualControlHook = (typeof dualControlHooks)[number];

/** Named workflow policies; owning domains register evaluators later. */
export const workflowPolicyCodes = ["CANDIDACY_WORKFLOW"] as const;
export type WorkflowPolicyCode = (typeof workflowPolicyCodes)[number];

/** Breadth order used to pick the least-privileged sufficient assignment. */
export const scopeBreadth: Readonly<Record<ScopeType, number>> = {
  ASSIGNED_RECORDS: 0,
  AUDIT_ASSIGNMENT: 0,
  TEAM: 1,
  BRANCH: 2,
  ORGANIZATION: 3,
};

export const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isUuid = (value: unknown): value is string =>
  typeof value === "string" && uuidPattern.test(value);

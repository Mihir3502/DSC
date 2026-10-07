import {
  isAssignmentReasonCode,
  isRevocationReasonCode,
  isUuid,
  reasonReferencePattern,
  scopeBreadth,
  type AssignmentStatus,
  type CatalogStatus,
  type PrincipalType,
  type RoleCode,
  type ScopeType,
} from "./authorization-vocabulary";

// Staff role-assignment invariants and lifecycle (packet M1.4 §9, ADR-0005).
// Pure. Time semantics: `effectiveFrom` is inclusive, `effectiveTo` is
// exclusive and nullable (open-ended). The database CHECK
// `effective_to > effective_from` and the SQL used by the repository
// (`effective_from <= now AND (effective_to IS NULL OR effective_to > now)`)
// use exactly the same semantics.

export type AssignmentSnapshot = Readonly<{
  id: string;
  userAccountId: string;
  roleCode: RoleCode;
  scopeType: ScopeType;
  scopeReferenceId: string;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  status: AssignmentStatus;
  createdByUserId: string;
  approvedByUserId: string | null;
  version: number;
}>;

/** Closed refusal codes for assignment commands (safe to log). */
export const assignmentRefusals = [
  "NOT_AUTHORIZED",
  "NOT_FOUND",
  "SUBJECT_NOT_STAFF",
  "SELF_ADMINISTRATION",
  "APPROVER_CONFLICT",
  "INVALID_DATES",
  "INVALID_REASON",
  "ROLE_UNAVAILABLE",
  "SCOPE_NOT_ALLOWED_FOR_ROLE",
  "SCOPE_UNRESOLVED",
  "OVERLAPPING_ASSIGNMENT",
  "INVALID_STATE",
  "STALE_VERSION",
  "ALREADY_ENDED",
] as const;
export type AssignmentRefusal = (typeof assignmentRefusals)[number];

/**
 * Scope types each staff role may be assigned with. Possession of a role
 * never implies organization scope; the administrator is limited to
 * organization scope for technical permissions only, and the auditor only
 * ever works through an approved audit assignment.
 */
export const allowedScopeTypesByRole: Readonly<
  Record<RoleCode, readonly ScopeType[]>
> = {
  CANDIDATE: [],
  RECRUITER: ["ASSIGNED_RECORDS", "TEAM", "BRANCH", "ORGANIZATION"],
  HR_SPECIALIST: ["ASSIGNED_RECORDS", "TEAM", "BRANCH", "ORGANIZATION"],
  CLASSIFICATION_REVIEWER: [
    "ASSIGNED_RECORDS",
    "TEAM",
    "BRANCH",
    "ORGANIZATION",
  ],
  COMPLIANCE_REVIEWER: ["ASSIGNED_RECORDS", "TEAM", "BRANCH", "ORGANIZATION"],
  TRAINER_EVALUATOR: ["ASSIGNED_RECORDS", "TEAM", "BRANCH", "ORGANIZATION"],
  PSA_MANAGER: ["ASSIGNED_RECORDS", "TEAM", "BRANCH", "ORGANIZATION"],
  SYSTEM_ADMINISTRATOR: ["ORGANIZATION"],
  AUDITOR_READ_ONLY: ["AUDIT_ASSIGNMENT"],
};

/** True when the assignment grants authority at `now`. */
export function isEffectiveAt(
  assignment: Pick<
    AssignmentSnapshot,
    "status" | "effectiveFrom" | "effectiveTo"
  >,
  now: Date,
): boolean {
  const t = now.getTime();
  return (
    assignment.status === "ACTIVE" &&
    assignment.effectiveFrom.getTime() <= t &&
    (assignment.effectiveTo === null || t < assignment.effectiveTo.getTime())
  );
}

/** Half-open interval intersection; `null` end means open-ended. */
export function intervalsOverlap(
  a: Readonly<{ effectiveFrom: Date; effectiveTo: Date | null }>,
  b: Readonly<{ effectiveFrom: Date; effectiveTo: Date | null }>,
): boolean {
  const aEnd = a.effectiveTo?.getTime() ?? Number.POSITIVE_INFINITY;
  const bEnd = b.effectiveTo?.getTime() ?? Number.POSITIVE_INFINITY;
  return a.effectiveFrom.getTime() < bEnd && b.effectiveFrom.getTime() < aEnd;
}

/**
 * Equivalent assignments (same subject, role, scope type, and scope
 * reference) that are pending or active may not overlap in time, so no two
 * rows ever express ambiguous effective authority. `ignoreId` excludes an
 * assignment being superseded by its replacement.
 */
export function findOverlap(
  candidate: Pick<
    AssignmentSnapshot,
    | "userAccountId"
    | "roleCode"
    | "scopeType"
    | "scopeReferenceId"
    | "effectiveFrom"
    | "effectiveTo"
  >,
  existing: readonly AssignmentSnapshot[],
  ignoreIds: readonly string[] = [],
): AssignmentSnapshot | null {
  return (
    existing.find(
      (row) =>
        !ignoreIds.includes(row.id) &&
        (row.status === "PROPOSED" || row.status === "ACTIVE") &&
        row.userAccountId === candidate.userAccountId &&
        row.roleCode === candidate.roleCode &&
        row.scopeType === candidate.scopeType &&
        row.scopeReferenceId === candidate.scopeReferenceId &&
        intervalsOverlap(row, candidate),
    ) ?? null
  );
}

export type ProposalInput = Readonly<{
  actorAccountId: string;
  subject: Readonly<{ id: string; accountType: string; status: string }> | null;
  role: Readonly<{
    code: RoleCode;
    principalType: PrincipalType;
    status: CatalogStatus;
  }> | null;
  scopeType: ScopeType;
  scopeReferenceId: unknown;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  reasonCode: unknown;
  reasonReference: unknown;
}>;

/** Validates a proposed assignment, before scope resolution and overlap. */
export function validateProposal(
  input: ProposalInput,
): AssignmentRefusal | null {
  if (!input.subject || input.subject.accountType !== "STAFF") {
    return "SUBJECT_NOT_STAFF";
  }
  // Staff may be proposed while INVITED (pre-provisioning) but never while
  // restricted; restricted accounts cannot resolve a principal anyway.
  if (input.subject.status !== "ACTIVE" && input.subject.status !== "INVITED") {
    return "SUBJECT_NOT_STAFF";
  }
  if (input.subject.id === input.actorAccountId) return "SELF_ADMINISTRATION";
  if (
    !input.role ||
    input.role.status !== "ACTIVE" ||
    input.role.principalType !== "STAFF"
  ) {
    return "ROLE_UNAVAILABLE";
  }
  if (!allowedScopeTypesByRole[input.role.code].includes(input.scopeType)) {
    return "SCOPE_NOT_ALLOWED_FOR_ROLE";
  }
  if (!isUuid(input.scopeReferenceId)) return "SCOPE_UNRESOLVED";
  if (
    !(input.effectiveFrom instanceof Date) ||
    Number.isNaN(input.effectiveFrom.getTime()) ||
    (input.effectiveTo !== null &&
      (!(input.effectiveTo instanceof Date) ||
        Number.isNaN(input.effectiveTo.getTime()) ||
        input.effectiveTo.getTime() <= input.effectiveFrom.getTime()))
  ) {
    return "INVALID_DATES";
  }
  if (!isAssignmentReasonCode(input.reasonCode)) return "INVALID_REASON";
  if (
    input.reasonReference !== undefined &&
    input.reasonReference !== null &&
    (typeof input.reasonReference !== "string" ||
      !reasonReferencePattern.test(input.reasonReference))
  ) {
    return "INVALID_REASON";
  }
  return null;
}

/** May `approverId` approve the proposed assignment at `now`? */
export function decideApproval(
  assignment: AssignmentSnapshot,
  approverId: string,
  expectedVersion: number,
  now: Date,
): AssignmentRefusal | null {
  if (assignment.status !== "PROPOSED") return "INVALID_STATE";
  if (assignment.version !== expectedVersion) return "STALE_VERSION";
  if (approverId === assignment.userAccountId) return "SELF_ADMINISTRATION";
  // Dual control: the requester never approves their own request.
  if (approverId === assignment.createdByUserId) return "APPROVER_CONFLICT";
  if (
    assignment.effectiveTo !== null &&
    assignment.effectiveTo.getTime() <= now.getTime()
  ) {
    return "ALREADY_ENDED";
  }
  return null;
}

/** May `actorId` reject a proposal? Same separation as approval. */
export function decideRejection(
  assignment: AssignmentSnapshot,
  actorId: string,
  expectedVersion: number,
  reasonCode: unknown,
): AssignmentRefusal | null {
  if (assignment.status !== "PROPOSED") return "INVALID_STATE";
  if (assignment.version !== expectedVersion) return "STALE_VERSION";
  if (actorId === assignment.userAccountId) return "SELF_ADMINISTRATION";
  if (!isRevocationReasonCode(reasonCode)) return "INVALID_REASON";
  return null;
}

/**
 * May `actorId` revoke the assignment? Revocation applies to ACTIVE rows
 * (current, future-dated, or already ended); a revoked row never becomes
 * active again, so restoration always creates a new assignment.
 */
export function decideRevocation(
  assignment: AssignmentSnapshot,
  actorId: string,
  expectedVersion: number,
  reasonCode: unknown,
): AssignmentRefusal | null {
  if (assignment.status !== "ACTIVE") return "INVALID_STATE";
  if (assignment.version !== expectedVersion) return "STALE_VERSION";
  if (actorId === assignment.userAccountId) return "SELF_ADMINISTRATION";
  if (!isRevocationReasonCode(reasonCode) || reasonCode === "SUPERSEDED") {
    return "INVALID_REASON";
  }
  return null;
}

/**
 * Deterministic least-privilege ordering among assignments that could
 * grant the same permission: narrowest scope first, then role code, then
 * assignment ID.
 */
export function compareLeastPrivilege(
  a: Readonly<{ scopeType: ScopeType; roleCode: RoleCode; id: string }>,
  b: Readonly<{ scopeType: ScopeType; roleCode: RoleCode; id: string }>,
): number {
  return (
    scopeBreadth[a.scopeType] - scopeBreadth[b.scopeType] ||
    a.roleCode.localeCompare(b.roleCode) ||
    a.id.localeCompare(b.id)
  );
}

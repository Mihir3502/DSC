import {
  isSensitivityLevel,
  isUuid,
  type ScopeType,
  type SensitivityLevel,
} from "./authorization-vocabulary";

// Typed scope containment (packet M1.4 §10.3, ADR-0005). Pure. Both inputs
// come only from a server-owned ScopeResourceResolver; nothing here is ever
// built from browser, session, URL, or request-body data. Containment is
// structural (typed IDs), never string-prefix matching. Missing hierarchy,
// membership, category, or time context means "not contained".

/** A resolved, currently active scope (the assignment's grant boundary). */
export type ScopeDescriptor =
  | Readonly<{ type: "ORGANIZATION"; id: string; organizationId: string }>
  | Readonly<{ type: "BRANCH"; id: string; organizationId: string }>
  | Readonly<{
      type: "TEAM";
      id: string;
      organizationId: string;
      branchId: string;
    }>
  /** An explicit assignment set: only its member records are in scope. */
  | Readonly<{ type: "ASSIGNED_RECORDS"; id: string; organizationId: string }>
  | Readonly<{
      type: "AUDIT_ASSIGNMENT";
      id: string;
      organizationId: string;
      auditorAccountId: string;
      /** Data categories the audit may read. */
      categories: readonly SensitivityLevel[];
      recordGroupIds: readonly string[];
      /** Inclusive start / exclusive end of the records' dates. */
      recordsFrom: Date;
      recordsTo: Date;
    }>;

/** Where a resource sits, as resolved by its owning module. */
export type ResourcePlacement = Readonly<{
  organizationId: string;
  branchId: string | null;
  teamId: string | null;
  /** Assignment sets that explicitly include this record. */
  assignmentSetIds: readonly string[];
  /** Record groups used by audit assignments. */
  recordGroupIds: readonly string[];
  /** Business date of the record, for audit date bounds. */
  recordedAt: Date | null;
  /** Accounts whose own candidacy/worker file this record is. */
  subjectAccountIds: readonly string[];
}>;

const validDate = (d: unknown): d is Date =>
  d instanceof Date && !Number.isNaN(d.getTime());

/** Shape check of a resolver result; anything malformed fails closed. */
export function isValidDescriptor(
  descriptor: ScopeDescriptor,
  expectedType: ScopeType,
  expectedId: string,
): boolean {
  if (descriptor.type !== expectedType || descriptor.id !== expectedId) {
    return false;
  }
  if (!isUuid(descriptor.id) || !isUuid(descriptor.organizationId)) {
    return false;
  }
  switch (descriptor.type) {
    case "ORGANIZATION":
      return descriptor.id === descriptor.organizationId;
    case "BRANCH":
    case "ASSIGNED_RECORDS":
      return descriptor.id !== descriptor.organizationId;
    case "TEAM":
      return (
        isUuid(descriptor.branchId) &&
        new Set([descriptor.id, descriptor.branchId, descriptor.organizationId])
          .size === 3
      );
    case "AUDIT_ASSIGNMENT":
      return (
        isUuid(descriptor.auditorAccountId) &&
        descriptor.categories.length > 0 &&
        descriptor.categories.every(isSensitivityLevel) &&
        descriptor.recordGroupIds.length > 0 &&
        descriptor.recordGroupIds.every(isUuid) &&
        validDate(descriptor.recordsFrom) &&
        validDate(descriptor.recordsTo) &&
        descriptor.recordsFrom.getTime() < descriptor.recordsTo.getTime()
      );
  }
}

export function isValidPlacement(placement: ResourcePlacement): boolean {
  return (
    isUuid(placement.organizationId) &&
    (placement.branchId === null || isUuid(placement.branchId)) &&
    (placement.teamId === null ||
      (isUuid(placement.teamId) && placement.branchId !== null)) &&
    placement.assignmentSetIds.every(isUuid) &&
    placement.recordGroupIds.every(isUuid) &&
    (placement.recordedAt === null || validDate(placement.recordedAt)) &&
    placement.subjectAccountIds.every(isUuid)
  );
}

export type ContainmentContext = Readonly<{
  actorAccountId: string;
  /** Classification of the data being accessed. */
  category: SensitivityLevel;
}>;

/**
 * Does the scope contain the resource? A scope from one organization never
 * contains a resource from another, whatever the other IDs say.
 */
export function scopeContains(
  scope: ScopeDescriptor,
  placement: ResourcePlacement,
  context: ContainmentContext,
): boolean {
  if (!isValidPlacement(placement)) return false;
  if (placement.organizationId !== scope.organizationId) return false;
  switch (scope.type) {
    case "ORGANIZATION":
      return scope.id === placement.organizationId;
    case "BRANCH":
      return placement.branchId === scope.id;
    case "TEAM":
      return (
        placement.teamId === scope.id && placement.branchId === scope.branchId
      );
    case "ASSIGNED_RECORDS":
      return placement.assignmentSetIds.includes(scope.id);
    case "AUDIT_ASSIGNMENT": {
      if (scope.auditorAccountId !== context.actorAccountId) return false;
      if (!scope.categories.includes(context.category)) return false;
      if (
        !placement.recordGroupIds.some((g) => scope.recordGroupIds.includes(g))
      ) {
        return false;
      }
      const at = placement.recordedAt?.getTime();
      return (
        at !== undefined &&
        scope.recordsFrom.getTime() <= at &&
        at < scope.recordsTo.getTime()
      );
    }
  }
}

/**
 * Placement of an administrative target that is itself a scope (for
 * example, the scope of a role assignment being granted). An
 * administrator's scope must contain it, so nobody grants beyond their own
 * administrative scope.
 */
export function placementOfScope(scope: ScopeDescriptor): ResourcePlacement {
  return Object.freeze({
    organizationId: scope.organizationId,
    branchId:
      scope.type === "BRANCH"
        ? scope.id
        : scope.type === "TEAM"
          ? scope.branchId
          : null,
    teamId: scope.type === "TEAM" ? scope.id : null,
    assignmentSetIds: scope.type === "ASSIGNED_RECORDS" ? [scope.id] : [],
    recordGroupIds: [],
    recordedAt: null,
    subjectAccountIds: [],
  });
}

/** Is this the linear part of the classification order? */
const linear: readonly SensitivityLevel[] = [
  "PUBLIC",
  "INTERNAL",
  "CONFIDENTIAL_PERSONNEL",
];

/**
 * Does a permission whose maximum sensitivity is `max` cover data
 * classified `actual`? PUBLIC < INTERNAL < CONFIDENTIAL_PERSONNEL form an
 * order; each restricted category is matched only by itself (a screening
 * permission never reaches identity/financial data, and vice versa). The
 * maximum is an upper bound, never a grant.
 */
export function sensitivityPermits(
  max: SensitivityLevel,
  actual: unknown,
): boolean {
  if (!isSensitivityLevel(actual)) return false;
  if (max === actual) return true;
  const maxRank = linear.indexOf(max);
  const actualRank = linear.indexOf(actual);
  return maxRank >= 0 && actualRank >= 0 && actualRank <= maxRank;
}

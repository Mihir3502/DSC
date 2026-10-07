import "server-only";
import {
  and,
  eq,
  gte,
  inArray,
  isNull,
  lt,
  ne,
  or,
  sql,
  type AnyColumn,
  type SQL,
} from "drizzle-orm";
import type {
  QueryConstraint,
  ScopeConstraint,
} from "../application/authorize";

// SQL predicates for authorized list/search queries (packet M1.5 §14,
// ADR-0011). Owning-module repositories pass the columns that place their
// rows; the predicate is applied in WHERE, so out-of-scope rows are never
// ordered, counted, paginated, or materialized. Each value is a bound
// parameter. An unknown constraint shape yields FALSE (fail closed).

export type ScopeColumns = Readonly<{
  organizationId: AnyColumn;
  branchId: AnyColumn;
  teamId: AnyColumn;
  /** The assignment set a row belongs to (when the module has one). */
  assignmentSetId?: AnyColumn;
  /** Record group and business date (audit assignments). */
  recordGroupId?: AnyColumn;
  recordedAt?: AnyColumn;
  /** Account whose own candidacy/worker file the row is, if any. */
  subjectAccountId: AnyColumn;
  /** Candidate-owned rows: the owning account. */
  ownerAccountId?: AnyColumn;
}>;

const never = sql`false`;

function scopePredicate(scope: ScopeConstraint, c: ScopeColumns): SQL {
  const inOrganization = eq(c.organizationId, scope.organizationId);
  switch (scope.type) {
    case "ORGANIZATION":
      return inOrganization;
    case "BRANCH":
      return and(inOrganization, eq(c.branchId, scope.branchId))!;
    case "TEAM":
      return and(
        inOrganization,
        eq(c.branchId, scope.branchId),
        eq(c.teamId, scope.teamId),
      )!;
    case "ASSIGNED_RECORDS":
      return c.assignmentSetId
        ? and(inOrganization, eq(c.assignmentSetId, scope.assignmentSetId))!
        : never;
    case "AUDIT_ASSIGNMENT":
      return c.recordGroupId && c.recordedAt && scope.recordGroupIds.length > 0
        ? and(
            inOrganization,
            inArray(c.recordGroupId, [...scope.recordGroupIds]),
            gte(c.recordedAt, scope.recordsFrom),
            lt(c.recordedAt, scope.recordsTo),
          )!
        : never;
    default:
      return never;
  }
}

/** The WHERE predicate for an authorized query constraint. */
export function constraintPredicate(
  constraint: QueryConstraint,
  columns: ScopeColumns,
): SQL {
  if (constraint.kind === "OWNER") {
    return columns.ownerAccountId
      ? eq(columns.ownerAccountId, constraint.accountId)
      : never;
  }
  if (constraint.kind !== "SCOPES" || constraint.scopes.length === 0) {
    return never;
  }
  const union = or(
    ...constraint.scopes.map((s) => scopePredicate(s, columns)),
  )!;
  // The actor's own candidacy/worker file never appears in a staff list.
  return and(
    union,
    or(
      isNull(columns.subjectAccountId),
      ne(columns.subjectAccountId, constraint.excludeSubjectAccountId),
    ),
  )!;
}

import "server-only";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  isRoleCode,
  isScopeType,
  isUuid,
  type AssignmentReasonCode,
  type AssignmentStatus,
  type CatalogStatus,
  type PrincipalType,
  type RevocationReasonCode,
  type RoleCode,
  type ScopeType,
} from "../domain/authorization-vocabulary";
import type { AssignmentSnapshot } from "../domain/role-assignment";
import type { Executor } from "./authorization-repository";
import {
  authorizationSubject,
  role,
  userRoleAssignment,
} from "./authorization-schema";

// Role-assignment persistence (packet M1.4 §9, ADR-0005). The runtime role
// may INSERT assignments and UPDATE only lifecycle columns (status,
// approval, revocation, supersession, version, updated_at): subject, role,
// scope, and dates are immutable once written, enforced by column-level
// grants. Nothing is ever deleted.

export type RoleRecord = Readonly<{
  id: string;
  code: RoleCode;
  principalType: PrincipalType;
  status: CatalogStatus;
}>;

const assignmentColumns = {
  id: userRoleAssignment.id,
  userAccountId: userRoleAssignment.userAccountId,
  roleCode: role.code,
  scopeType: userRoleAssignment.scopeType,
  scopeReferenceId: userRoleAssignment.scopeReferenceId,
  effectiveFrom: userRoleAssignment.effectiveFrom,
  effectiveTo: userRoleAssignment.effectiveTo,
  status: userRoleAssignment.status,
  createdByUserId: userRoleAssignment.createdByUserId,
  approvedByUserId: userRoleAssignment.approvedByUserId,
  replacesAssignmentId: userRoleAssignment.replacesAssignmentId,
  version: userRoleAssignment.version,
};

export type StoredAssignment = AssignmentSnapshot &
  Readonly<{ replacesAssignmentId: string | null }>;

type AssignmentRow = Omit<
  StoredAssignment,
  "roleCode" | "scopeType" | "status"
> &
  Readonly<{ roleCode: string; scopeType: string; status: string }>;

function toSnapshot(row: AssignmentRow): StoredAssignment | null {
  // CHECK constraints make these valid; fail closed anyway.
  if (!isRoleCode(row.roleCode) || !isScopeType(row.scopeType)) return null;
  return Object.freeze({
    ...row,
    roleCode: row.roleCode,
    scopeType: row.scopeType,
    status: row.status as AssignmentStatus,
  });
}

export async function findRoleByCode(
  db: Executor,
  code: string,
): Promise<RoleRecord | null> {
  if (!isRoleCode(code)) return null;
  const [row] = await db
    .select({
      id: role.id,
      code: role.code,
      principalType: role.principalType,
      status: role.status,
    })
    .from(role)
    .where(eq(role.code, code))
    .limit(1);
  if (!row || !isRoleCode(row.code)) return null;
  return Object.freeze({
    id: row.id,
    code: row.code,
    principalType: row.principalType as PrincipalType,
    status: row.status as CatalogStatus,
  });
}

/** Loads (and with `lock`, locks FOR UPDATE) one assignment. */
export async function findAssignment(
  db: Executor,
  assignmentId: string,
  lock = false,
): Promise<StoredAssignment | null> {
  if (!isUuid(assignmentId)) return null;
  // Lock only the assignment row (the runtime role cannot lock catalog
  // rows, which would need UPDATE privilege on auth.role).
  if (lock) {
    await db
      .select({ id: userRoleAssignment.id })
      .from(userRoleAssignment)
      .where(eq(userRoleAssignment.id, assignmentId))
      .for("update");
  }
  const [row] = await db
    .select(assignmentColumns)
    .from(userRoleAssignment)
    .innerJoin(role, eq(role.id, userRoleAssignment.roleId))
    .where(eq(userRoleAssignment.id, assignmentId))
    .limit(1);
  return row ? toSnapshot(row) : null;
}

/** Every pending/active assignment of a subject (for overlap checks). */
export async function listOpenAssignments(
  db: Executor,
  userAccountId: string,
): Promise<readonly StoredAssignment[]> {
  const rows = await db
    .select(assignmentColumns)
    .from(userRoleAssignment)
    .innerJoin(role, eq(role.id, userRoleAssignment.roleId))
    .where(
      and(
        eq(userRoleAssignment.userAccountId, userAccountId),
        inArray(userRoleAssignment.status, ["PROPOSED", "ACTIVE"]),
      ),
    );
  return rows.map(toSnapshot).filter((r): r is StoredAssignment => r !== null);
}

/** Every assignment of a subject, newest first (for listing). */
export async function listSubjectAssignments(
  db: Executor,
  userAccountId: string,
): Promise<readonly StoredAssignment[]> {
  if (!isUuid(userAccountId)) return [];
  const rows = await db
    .select(assignmentColumns)
    .from(userRoleAssignment)
    .innerJoin(role, eq(role.id, userRoleAssignment.roleId))
    .where(eq(userRoleAssignment.userAccountId, userAccountId))
    .orderBy(sql`${userRoleAssignment.createdAt} DESC`, userRoleAssignment.id);
  return rows.map(toSnapshot).filter((r): r is StoredAssignment => r !== null);
}

export async function insertProposedAssignment(
  db: Executor,
  input: Readonly<{
    userAccountId: string;
    roleId: string;
    scopeType: ScopeType;
    scopeReferenceId: string;
    effectiveFrom: Date;
    effectiveTo: Date | null;
    reasonCode: AssignmentReasonCode;
    reasonReference: string | null;
    createdByUserId: string;
    replacesAssignmentId: string | null;
    now: Date;
  }>,
): Promise<string> {
  const [row] = await db
    .insert(userRoleAssignment)
    .values({
      userAccountId: input.userAccountId,
      roleId: input.roleId,
      principalType: "STAFF",
      scopeType: input.scopeType,
      scopeReferenceId: input.scopeReferenceId,
      effectiveFrom: input.effectiveFrom,
      effectiveTo: input.effectiveTo,
      status: "PROPOSED",
      reasonCode: input.reasonCode,
      reasonReference: input.reasonReference,
      createdByUserId: input.createdByUserId,
      replacesAssignmentId: input.replacesAssignmentId,
      createdAt: input.now,
      updatedAt: input.now,
    })
    .returning({ id: userRoleAssignment.id });
  return row!.id;
}

/** PROPOSED → ACTIVE, guarded by status and expected version. */
export async function activateAssignment(
  db: Executor,
  assignmentId: string,
  expectedVersion: number,
  approverId: string,
  now: Date,
): Promise<boolean> {
  const updated = await db
    .update(userRoleAssignment)
    .set({
      status: "ACTIVE",
      approvedByUserId: approverId,
      approvedAt: now,
      version: sql`${userRoleAssignment.version} + 1`,
      updatedAt: now,
    })
    .where(
      and(
        eq(userRoleAssignment.id, assignmentId),
        eq(userRoleAssignment.status, "PROPOSED"),
        eq(userRoleAssignment.version, expectedVersion),
      ),
    )
    .returning({ id: userRoleAssignment.id });
  return updated.length === 1;
}

/**
 * Ends an assignment: PROPOSED → REJECTED, ACTIVE → REVOKED, or ACTIVE →
 * SUPERSEDED (with the successor's ID). Guarded by status and version.
 */
export async function endAssignment(
  db: Executor,
  input: Readonly<{
    assignmentId: string;
    from: "PROPOSED" | "ACTIVE";
    to: "REJECTED" | "REVOKED" | "SUPERSEDED";
    expectedVersion: number;
    actorId: string;
    reasonCode: RevocationReasonCode;
    supersededById?: string;
    now: Date;
  }>,
): Promise<boolean> {
  const updated = await db
    .update(userRoleAssignment)
    .set({
      status: input.to,
      revokedAt: input.now,
      revokedByUserId: input.actorId,
      revocationReasonCode: input.reasonCode,
      supersededByAssignmentId: input.supersededById ?? null,
      version: sql`${userRoleAssignment.version} + 1`,
      updatedAt: input.now,
    })
    .where(
      and(
        eq(userRoleAssignment.id, input.assignmentId),
        eq(userRoleAssignment.status, input.from),
        eq(userRoleAssignment.version, input.expectedVersion),
      ),
    )
    .returning({ id: userRoleAssignment.id });
  return updated.length === 1;
}

/** Increments the subject's authorization epoch; returns the new version. */
export async function bumpAuthorizationVersion(
  db: Executor,
  userAccountId: string,
  now: Date,
): Promise<number> {
  const [row] = await db
    .insert(authorizationSubject)
    .values({
      userAccountId,
      authorizationVersion: 1,
      versionChangedAt: now,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: authorizationSubject.userAccountId,
      set: {
        authorizationVersion: sql`${authorizationSubject.authorizationVersion} + 1`,
        versionChangedAt: now,
        updatedAt: now,
      },
    })
    .returning({ version: authorizationSubject.authorizationVersion });
  return row!.version;
}

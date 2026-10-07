import "server-only";
import { and, eq, gt, inArray, isNull, lte, not, or } from "drizzle-orm";
import type { Database } from "@/shared/database";
import type { AssuranceEvidence } from "../domain/authentication-assurance";
import { isUuid } from "../domain/authorization-vocabulary";
import type {
  AccountFact,
  AuthorizationFactsSource,
  GrantFact,
  PermissionFact,
  SubjectEpoch,
} from "../application/ports/authorization-facts";
import { user } from "./auth-schema";
import {
  authorizationSubject,
  permission,
  role,
  rolePermission,
  userRoleAssignment,
} from "./authorization-schema";
import { readSessionAssurance } from "./better-auth-mfa-adapter";

// Current-state authorization reads (packet M1.4 §15). Runs on the
// least-privileged runtime connection. With `lockSubject`, the subject's
// account row is read FOR SHARE inside the caller's transaction: every
// assignment change and account restriction takes FOR UPDATE on the same
// row, so a revocation either commits before this read (and is seen) or
// waits until the protected command's transaction ends.

export type Executor = Pick<
  Database,
  "select" | "update" | "delete" | "insert"
>;

const permissionColumns = {
  code: permission.code,
  resource: permission.resource,
  action: permission.action,
  operation: permission.operation,
  maxSensitivity: permission.maxSensitivity,
  permissionDomain: permission.permissionDomain,
  description: permission.description,
  status: permission.status,
  requiresScope: permission.requiresScope,
  workflowPolicyCode: permission.workflowPolicyCode,
  recentAuthPolicy: permission.recentAuthPolicy,
  recentAuthPurpose: permission.recentAuthPurpose,
  separationPolicyCode: permission.separationPolicyCode,
  dualControlHook: permission.dualControlHook,
  requiresReason: permission.requiresReason,
  restrictedData: permission.restrictedData,
  isExport: permission.isExport,
  highRisk: permission.highRisk,
  catalogVersion: permission.catalogVersion,
};

export class DatabaseAuthorizationFacts implements AuthorizationFactsSource {
  constructor(
    private readonly db: Executor,
    private readonly options: Readonly<{ lockSubject: boolean }> = {
      lockSubject: false,
    },
  ) {}

  async loadAccount(accountId: string): Promise<AccountFact | null> {
    if (!isUuid(accountId)) return null;
    const query = this.db
      .select({
        id: user.id,
        accountType: user.accountType,
        status: user.status,
      })
      .from(user)
      .where(eq(user.id, accountId))
      .limit(1);
    const [row] = this.options.lockSubject
      ? await query.for("share")
      : await query;
    return row ?? null;
  }

  loadAssurance(
    accountId: string,
    sessionId: string,
  ): Promise<AssuranceEvidence | null> {
    return readSessionAssurance(this.db, accountId, sessionId);
  }

  async loadSubjectEpoch(accountId: string): Promise<SubjectEpoch | null> {
    if (!isUuid(accountId)) return null;
    const [row] = await this.db
      .select({
        authorizationVersion: authorizationSubject.authorizationVersion,
        versionChangedAt: authorizationSubject.versionChangedAt,
      })
      .from(authorizationSubject)
      .where(eq(authorizationSubject.userAccountId, accountId))
      .limit(1);
    return row ?? null;
  }

  async loadPermission(code: string): Promise<PermissionFact | null> {
    const [row] = await this.db
      .select(permissionColumns)
      .from(permission)
      .where(eq(permission.code, code))
      .limit(1);
    return row ?? null;
  }

  async loadStaffGrants(
    accountId: string,
    permissionCode: string,
    at: Date,
  ): Promise<readonly GrantFact[]> {
    if (!isUuid(accountId)) return [];
    return this.db
      .select({
        assignmentId: userRoleAssignment.id,
        roleCode: role.code,
        scopeType: userRoleAssignment.scopeType,
        scopeReferenceId: userRoleAssignment.scopeReferenceId,
        effectiveFrom: userRoleAssignment.effectiveFrom,
        condition: rolePermission.condition,
      })
      .from(userRoleAssignment)
      .innerJoin(role, eq(role.id, userRoleAssignment.roleId))
      .innerJoin(rolePermission, eq(rolePermission.roleId, role.id))
      .innerJoin(permission, eq(permission.id, rolePermission.permissionId))
      .where(
        and(
          eq(userRoleAssignment.userAccountId, accountId),
          eq(userRoleAssignment.status, "ACTIVE"),
          // Inclusive start, exclusive end (same as isEffectiveAt).
          lte(userRoleAssignment.effectiveFrom, at),
          or(
            isNull(userRoleAssignment.effectiveTo),
            gt(userRoleAssignment.effectiveTo, at),
          ),
          eq(role.principalType, "STAFF"),
          eq(role.status, "ACTIVE"),
          eq(rolePermission.status, "ACTIVE"),
          eq(permission.status, "ACTIVE"),
          eq(permission.code, permissionCode),
        ),
      );
  }

  async hasIneffectiveAssignment(
    accountId: string,
    permissionCode: string,
    at: Date,
  ): Promise<boolean> {
    if (!isUuid(accountId)) return false;
    const rows = await this.db
      .select({ id: userRoleAssignment.id })
      .from(userRoleAssignment)
      .innerJoin(role, eq(role.id, userRoleAssignment.roleId))
      .innerJoin(rolePermission, eq(rolePermission.roleId, role.id))
      .innerJoin(permission, eq(permission.id, rolePermission.permissionId))
      .where(
        and(
          eq(userRoleAssignment.userAccountId, accountId),
          inArray(userRoleAssignment.status, [
            "ACTIVE",
            "REVOKED",
            "SUPERSEDED",
          ]),
          eq(permission.code, permissionCode),
          not(
            and(
              eq(userRoleAssignment.status, "ACTIVE"),
              eq(role.status, "ACTIVE"),
              lte(userRoleAssignment.effectiveFrom, at),
              or(
                isNull(userRoleAssignment.effectiveTo),
                gt(userRoleAssignment.effectiveTo, at),
              ),
            )!,
          ),
        ),
      )
      .limit(1);
    return rows.length > 0;
  }

  async loadCandidateGrants(
    permissionCode: string,
  ): Promise<readonly GrantFact[]> {
    const rows = await this.db
      .select({ roleCode: role.code, condition: rolePermission.condition })
      .from(rolePermission)
      .innerJoin(role, eq(role.id, rolePermission.roleId))
      .innerJoin(permission, eq(permission.id, rolePermission.permissionId))
      .where(
        and(
          eq(role.code, "CANDIDATE"),
          eq(role.principalType, "CANDIDATE"),
          eq(role.status, "ACTIVE"),
          eq(rolePermission.status, "ACTIVE"),
          eq(permission.status, "ACTIVE"),
          eq(permission.code, permissionCode),
        ),
      );
    return rows.map((row) => ({
      assignmentId: null,
      roleCode: row.roleCode,
      scopeType: null,
      scopeReferenceId: null,
      effectiveFrom: null,
      condition: row.condition,
    }));
  }
}

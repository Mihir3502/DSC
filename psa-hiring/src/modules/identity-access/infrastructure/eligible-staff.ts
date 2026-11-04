import "server-only";
import { and, asc, eq, gt, inArray, isNull, lte, ne, or } from "drizzle-orm";
import type { Database } from "@/shared/database";
import { user } from "./auth-schema";
import {
  permission,
  role,
  rolePermission,
  userRoleAssignment,
} from "./authorization-schema";

// Staff who hold a permission at a record's placement right now (packet M3.1).
// Used to offer, and to re-verify, an owner. Active MFA-complete staff with a
// current, unconditional grant at the record's organization, branch, or team.
// Returns ids and names only, and never authorizes anything by itself.

type Executor = Pick<Database, "select" | "selectDistinct">;

export async function listStaffHoldingPermissionAt(
  db: Executor,
  input: Readonly<{
    permission: string;
    organizationId: string;
    branchId: string;
    teamId: string | null;
    excludeAccountIds: readonly string[];
    /** Re-verify one account rather than listing. */
    onlyAccountId?: string;
    at: Date;
    limit: number;
  }>,
): Promise<readonly Readonly<{ accountId: string; name: string }>[]> {
  const scopes = [
    and(
      eq(userRoleAssignment.scopeType, "ORGANIZATION"),
      eq(userRoleAssignment.scopeReferenceId, input.organizationId),
    ),
    and(
      eq(userRoleAssignment.scopeType, "BRANCH"),
      eq(userRoleAssignment.scopeReferenceId, input.branchId),
    ),
    ...(input.teamId
      ? [
          and(
            eq(userRoleAssignment.scopeType, "TEAM"),
            eq(userRoleAssignment.scopeReferenceId, input.teamId),
          ),
        ]
      : []),
  ];
  const excluded = input.excludeAccountIds.map((id) => ne(user.id, id));
  return db
    .selectDistinct({ accountId: user.id, name: user.name })
    .from(userRoleAssignment)
    .innerJoin(user, eq(user.id, userRoleAssignment.userAccountId))
    .innerJoin(role, eq(role.id, userRoleAssignment.roleId))
    .innerJoin(rolePermission, eq(rolePermission.roleId, role.id))
    .innerJoin(permission, eq(permission.id, rolePermission.permissionId))
    .where(
      and(
        eq(permission.code, input.permission),
        eq(permission.status, "ACTIVE"),
        eq(rolePermission.status, "ACTIVE"),
        isNull(rolePermission.condition),
        eq(role.status, "ACTIVE"),
        eq(userRoleAssignment.status, "ACTIVE"),
        lte(userRoleAssignment.effectiveFrom, input.at),
        or(
          isNull(userRoleAssignment.effectiveTo),
          gt(userRoleAssignment.effectiveTo, input.at),
        ),
        inArray(user.accountType, ["STAFF"]),
        eq(user.status, "ACTIVE"),
        eq(user.twoFactorEnabled, true),
        or(...scopes),
        ...excluded,
        ...(input.onlyAccountId ? [eq(user.id, input.onlyAccountId)] : []),
      ),
    )
    .orderBy(asc(user.name), asc(user.id))
    .limit(input.limit);
}

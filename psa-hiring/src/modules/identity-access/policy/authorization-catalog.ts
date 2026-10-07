import { canonicalCondition } from "../domain/grant-condition";
import {
  permissionCatalog,
  type PermissionDefinition,
} from "./permission-catalog";
import { roleCatalog, type RoleDefinition } from "./role-catalog";
import { grantCatalog, type GrantDefinition } from "./role-permission-catalog";

// The versioned authorization catalog (packet M1.4 §16, ADR-0005).
//
// Changing any role, permission, or grant requires, in one reviewed change:
// 1. increment AUTHORIZATION_CATALOG_VERSION;
// 2. update AUTHORIZATION_CATALOG_DIGEST (the unit test prints the new one);
// 3. update tests, ROLE_PERMISSION_MATRIX traceability, and ADR-0005;
// 4. apply with `pnpm db:catalog:apply` as a reviewed deployment step.
// Codes are never deleted or reused; retire them instead.

export const AUTHORIZATION_CATALOG_VERSION = 1;

/** Version of the decision engine's rules (ordering, containment, SoD). */
export const AUTHORIZATION_POLICY_ENGINE_VERSION = 1;

/** Opaque, log-safe policy version carried by every decision. */
export const AUTHORIZATION_POLICY_VERSION = `authz-p${AUTHORIZATION_POLICY_ENGINE_VERSION}-c${AUTHORIZATION_CATALOG_VERSION}`;

/** SHA-256 of canonicalCatalog(); guards unreviewed edits. */
export const AUTHORIZATION_CATALOG_DIGEST =
  "371ccf74985ea29b5b7e482657c93f526e13c59b20b899460f2f22ffd5776c5d";

export type AuthorizationCatalog = Readonly<{
  version: number;
  roles: readonly RoleDefinition[];
  permissions: readonly PermissionDefinition[];
  grants: readonly GrantDefinition[];
}>;

export const authorizationCatalog: AuthorizationCatalog = Object.freeze({
  version: AUTHORIZATION_CATALOG_VERSION,
  roles: roleCatalog,
  permissions: permissionCatalog,
  grants: grantCatalog,
});

/** Controlled role columns written to the database. */
export function roleRow(role: RoleDefinition) {
  return {
    code: role.code,
    name: role.name,
    description: role.description,
    principalType: role.principalType,
    status: role.status,
    isSystemRole: role.isSystemRole,
  };
}

/** Controlled permission columns written to the database. */
export function permissionRow(permission: PermissionDefinition) {
  return {
    code: permission.code,
    resource: permission.resource,
    action: permission.action,
    operation: permission.operation,
    maxSensitivity: permission.maxSensitivity,
    permissionDomain: permission.domain,
    description: permission.description,
    status: permission.status,
    requiresScope: permission.requiresScope,
    workflowPolicyCode: permission.workflowPolicy,
    recentAuthPolicy: permission.recentAuth?.policy ?? null,
    recentAuthPurpose: permission.recentAuth?.purpose ?? null,
    separationPolicyCode: permission.separationPolicy,
    dualControlHook: permission.dualControlHook,
    requiresReason: permission.requiresReason,
    restrictedData: permission.restrictedData,
    isExport: permission.isExport,
    highRisk: permission.highRisk,
  };
}

/** Controlled grant columns written to the database. */
export function grantRow(grant: GrantDefinition) {
  return {
    roleCode: grant.roleCode,
    permissionCode: grant.permissionCode,
    condition: canonicalCondition(grant.condition),
    status: grant.status,
  };
}

/** Deterministic serialization of everything the database stores. */
export function canonicalCatalog(
  catalog: AuthorizationCatalog = authorizationCatalog,
): string {
  const sortBy = <T>(rows: T[], key: (row: T) => string) =>
    rows.sort((a, b) => key(a).localeCompare(key(b)));
  return JSON.stringify({
    version: catalog.version,
    roles: sortBy(catalog.roles.map(roleRow), (r) => r.code),
    permissions: sortBy(catalog.permissions.map(permissionRow), (p) => p.code),
    grants: sortBy(
      catalog.grants.map(grantRow),
      (g) => `${g.roleCode}|${g.permissionCode}`,
    ),
  });
}

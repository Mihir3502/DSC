import {
  canonicalCondition,
  parseGrantCondition,
} from "../../../src/modules/identity-access/domain/grant-condition";
import {
  authorizationCatalog,
  grantRow,
  permissionRow,
  roleRow,
  type AuthorizationCatalog,
} from "../../../src/modules/identity-access/policy/authorization-catalog";

// Plans and applies the reviewed authorization catalog (packet M1.4 §16,
// ADR-0005). One planner compares the TypeScript manifest with the database:
//
// - `apply` (migration role, reviewed deployment step) inserts missing rows
//   and updates controlled columns that differ, in one transaction under a
//   table lock. Unchanged rows are not touched (re-running is a no-op).
// - `check` (runtime role, read-only) fails when anything would change.
//
// Both refuse when the database contains a role, permission, or grant that
// the manifest does not (tampering or an unreviewed change), when a code
// would be repurposed (principal type, resource/action/operation/domain),
// or when a row claims a newer catalog version. Nothing is ever deleted,
// and no user, assignment, organization, or session is created. Output
// contains counts only, never row contents.

export type Query = (
  text: string,
  params?: readonly unknown[],
) => Promise<readonly Record<string, unknown>[]>;

type Columns = Record<string, unknown>;

export type CatalogPlan = Readonly<{
  problems: readonly string[];
  roles: Readonly<{ insert: Columns[]; update: Columns[]; unchanged: number }>;
  permissions: Readonly<{
    insert: Columns[];
    update: Columns[];
    unchanged: number;
  }>;
  grants: Readonly<{
    insert: Columns[];
    update: Columns[];
    unchanged: number;
  }>;
}>;

const roleColumns: Record<string, string> = {
  code: "code",
  name: "name",
  description: "description",
  principalType: "principal_type",
  status: "status",
  isSystemRole: "is_system_role",
};

const permissionColumns: Record<string, string> = {
  code: "code",
  resource: "resource",
  action: "action",
  operation: "operation",
  maxSensitivity: "max_sensitivity",
  permissionDomain: "permission_domain",
  description: "description",
  status: "status",
  requiresScope: "requires_scope",
  workflowPolicyCode: "workflow_policy_code",
  recentAuthPolicy: "recent_auth_policy",
  recentAuthPurpose: "recent_auth_purpose",
  separationPolicyCode: "separation_policy_code",
  dualControlHook: "dual_control_hook",
  requiresReason: "requires_reason",
  restrictedData: "restricted_data",
  isExport: "is_export",
  highRisk: "high_risk",
};

/** Columns whose change would repurpose a code (refused, never updated). */
const roleIdentity = ["principalType"];
const permissionIdentity = [
  "resource",
  "action",
  "operation",
  "permissionDomain",
];

function differs(
  expected: Columns,
  stored: Columns,
  columns: Record<string, string>,
): string[] {
  return Object.entries(columns)
    .filter(([key, column]) => expected[key] !== stored[column])
    .map(([key]) => key);
}

export async function planCatalog(
  query: Query,
  catalog: AuthorizationCatalog = authorizationCatalog,
): Promise<CatalogPlan> {
  const problems: string[] = [];
  const version = catalog.version;

  const storedRoles = new Map(
    (await query(`SELECT * FROM auth.role`)).map((r) => [r.code as string, r]),
  );
  const storedPermissions = new Map(
    (await query(`SELECT * FROM auth.permission`)).map((p) => [
      p.code as string,
      p,
    ]),
  );
  const storedGrants = new Map(
    (
      await query(
        `SELECT r.code AS role_code, p.code AS permission_code, rp.condition, rp.status, rp.catalog_version
           FROM auth.role_permission rp
           JOIN auth.role r ON r.id = rp.role_id
           JOIN auth.permission p ON p.id = rp.permission_id`,
      )
    ).map((g) => [
      `${g.role_code as string}|${g.permission_code as string}`,
      g,
    ]),
  );

  const newer = [
    ...storedRoles.values(),
    ...storedPermissions.values(),
    ...storedGrants.values(),
  ].filter((row) => Number(row.catalog_version) > version).length;
  if (newer > 0) {
    problems.push(
      `${newer} row(s) claim a catalog version newer than ${version}`,
    );
  }

  const roleCodes = new Set(catalog.roles.map((r) => r.code as string));
  const unknownRoles = [...storedRoles.keys()].filter((c) => !roleCodes.has(c));
  if (unknownRoles.length > 0) {
    problems.push(
      `${unknownRoles.length} role row(s) not in the reviewed catalog`,
    );
  }
  const permissionCodes = new Set(catalog.permissions.map((p) => p.code));
  const unknownPermissions = [...storedPermissions.keys()].filter(
    (c) => !permissionCodes.has(c),
  );
  if (unknownPermissions.length > 0) {
    problems.push(
      `${unknownPermissions.length} permission row(s) not in the reviewed catalog`,
    );
  }
  const grantKeys = new Set(
    catalog.grants.map((g) => `${g.roleCode}|${g.permissionCode}`),
  );
  const unknownGrants = [...storedGrants.keys()].filter(
    (k) => !grantKeys.has(k),
  );
  if (unknownGrants.length > 0) {
    problems.push(
      `${unknownGrants.length} grant row(s) not in the reviewed catalog`,
    );
  }

  const roles = {
    insert: [] as Columns[],
    update: [] as Columns[],
    unchanged: 0,
  };
  for (const role of catalog.roles) {
    const expected = roleRow(role);
    const stored = storedRoles.get(role.code);
    if (!stored) {
      roles.insert.push(expected);
      continue;
    }
    const changed = differs(expected, stored, roleColumns);
    if (changed.some((key) => roleIdentity.includes(key))) {
      problems.push("a role code would be repurposed");
    } else if (changed.length > 0) {
      roles.update.push(expected);
    } else {
      roles.unchanged += 1;
    }
  }

  const permissions = {
    insert: [] as Columns[],
    update: [] as Columns[],
    unchanged: 0,
  };
  for (const permission of catalog.permissions) {
    const expected = permissionRow(permission);
    const stored = storedPermissions.get(permission.code);
    if (!stored) {
      permissions.insert.push(expected);
      continue;
    }
    const changed = differs(expected, stored, permissionColumns);
    if (changed.some((key) => permissionIdentity.includes(key))) {
      problems.push("a permission code would be repurposed");
    } else if (changed.length > 0) {
      permissions.update.push(expected);
    } else {
      permissions.unchanged += 1;
    }
  }

  const grants = {
    insert: [] as Columns[],
    update: [] as Columns[],
    unchanged: 0,
  };
  for (const grant of catalog.grants) {
    const expected = grantRow(grant);
    const stored = storedGrants.get(
      `${grant.roleCode}|${grant.permissionCode}`,
    );
    if (!stored) {
      grants.insert.push(expected);
      continue;
    }
    const parsed = parseGrantCondition(stored.condition);
    const storedCondition =
      parsed === "INVALID" ? "INVALID" : canonicalCondition(parsed);
    if (
      storedCondition !== expected.condition ||
      stored.status !== expected.status
    ) {
      grants.update.push(expected);
    } else {
      grants.unchanged += 1;
    }
  }

  return { problems, roles, permissions, grants };
}

export function planChanges(plan: CatalogPlan): number {
  return (
    plan.roles.insert.length +
    plan.roles.update.length +
    plan.permissions.insert.length +
    plan.permissions.update.length +
    plan.grants.insert.length +
    plan.grants.update.length
  );
}

export function describePlan(plan: CatalogPlan): string {
  const part = (
    label: string,
    p: { insert: unknown[]; update: unknown[]; unchanged: number },
  ) =>
    `${label}: ${p.insert.length} inserted, ${p.update.length} updated, ${p.unchanged} unchanged`;
  return [
    part("roles", plan.roles),
    part("permissions", plan.permissions),
    part("grants", plan.grants),
  ].join("; ");
}

function upsert(
  table: string,
  conflict: string,
  columns: Record<string, string>,
  row: Columns,
  version: number,
): [string, unknown[]] {
  const keys = Object.keys(columns);
  const names = keys.map((k) => columns[k]);
  const params = keys.map((k) => row[k]);
  const updates = names
    .filter((n) => n !== conflict)
    .map((n) => `${n} = EXCLUDED.${n}`);
  return [
    `INSERT INTO ${table} (${names.join(", ")}, catalog_version)
       VALUES (${names.map((_, i) => `$${i + 1}`).join(", ")}, $${names.length + 1})
     ON CONFLICT (${conflict}) DO UPDATE SET ${updates.join(", ")},
       catalog_version = EXCLUDED.catalog_version, updated_at = now()`,
    [...params, version],
  ];
}

/** Applies a problem-free plan. The caller owns the transaction. */
export async function applyPlan(
  query: Query,
  plan: CatalogPlan,
  version: number,
): Promise<void> {
  if (plan.problems.length > 0) {
    throw new Error("refusing to apply a catalog plan with problems");
  }
  await query(
    `LOCK TABLE auth.role, auth.permission, auth.role_permission IN SHARE ROW EXCLUSIVE MODE`,
  );
  for (const row of [...plan.roles.insert, ...plan.roles.update]) {
    await query(...upsert("auth.role", "code", roleColumns, row, version));
  }
  for (const row of [...plan.permissions.insert, ...plan.permissions.update]) {
    await query(
      ...upsert("auth.permission", "code", permissionColumns, row, version),
    );
  }
  for (const row of [...plan.grants.insert, ...plan.grants.update]) {
    await query(
      `INSERT INTO auth.role_permission (role_id, permission_id, condition, status, catalog_version)
       SELECT r.id, p.id, $3::jsonb, $4, $5
         FROM auth.role r, auth.permission p
        WHERE r.code = $1 AND p.code = $2
       ON CONFLICT (role_id, permission_id) DO UPDATE SET
         condition = EXCLUDED.condition, status = EXCLUDED.status,
         catalog_version = EXCLUDED.catalog_version, updated_at = now()`,
      [
        row.roleCode,
        row.permissionCode,
        row.condition === "null" ? null : row.condition,
        row.status,
        version,
      ],
    );
  }
}

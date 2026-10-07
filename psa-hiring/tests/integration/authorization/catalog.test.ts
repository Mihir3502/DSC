import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import {
  AUTHORIZATION_CATALOG_VERSION,
  authorizationCatalog,
  grantRow,
  permissionRow,
  roleRow,
} from "@/modules/identity-access/policy/authorization-catalog";
import { pgErrorCode } from "@/shared/database/errors";
import {
  adminClient,
  assertNoSecrets,
  buildHarnessEnv,
  createOwnedDatabase,
  dropOwnedDatabase,
  runDbScript,
  type OwnedDatabase,
} from "../support/harness";
import { Client as PgClient } from "pg";

// M1.4 catalog: migration from empty, reviewed apply, idempotence, drift
// and tamper detection, least-privilege writes, and no default users or
// assignments (packet M1.4 §16, AC-M1.4-01..03, AC-M1.4-06, AC-M1.4-14).

const ctx = inject("postgres");
let db: OwnedDatabase;
let admin: Client;
let env: NodeJS.ProcessEnv;
const roles = authorizationCatalog.roles.length;
const permissions = authorizationCatalog.permissions.length;
const grants = authorizationCatalog.grants.length;

async function script(name: "catalog" | "catalogCheck" | "check") {
  const result = await runDbScript(name, env);
  assertNoSecrets(ctx, result.output);
  return result;
}

async function count(table: string): Promise<number> {
  const { rows } = await admin.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM ${table}`,
  );
  return rows[0]!.n;
}

beforeAll(async () => {
  db = await createOwnedDatabase(ctx, "authz_catalog");
  env = buildHarnessEnv(db);
  for (const step of ["bootstrap", "migrate", "bootstrap"] as const) {
    const result = await runDbScript(step, env);
    assertNoSecrets(ctx, result.output);
    expect(result.code, `${step} failed`).toBe(0);
  }
  admin = await adminClient(ctx, db.name);
});

afterAll(async () => {
  await admin?.end();
  if (db) await dropOwnedDatabase(ctx, db.name);
});

describe("authorization catalog", () => {
  it("migrates from empty with empty catalog tables and the drift check failing", async () => {
    for (const table of [
      "auth.role",
      "auth.permission",
      "auth.role_permission",
      "auth.user_role_assignment",
      "auth.authorization_subject",
    ]) {
      expect(await count(table), table).toBe(0);
    }
    const check = await script("catalogCheck");
    expect(check.code).not.toBe(0);
    expect(check.output).toMatch(/drift/);
  });

  it("applies the reviewed catalog through the migration role", async () => {
    const result = await script("catalog");
    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain(
      `roles: ${roles} inserted, 0 updated, 0 unchanged; permissions: ${permissions} inserted, 0 updated, 0 unchanged; grants: ${grants} inserted, 0 updated, 0 unchanged`,
    );
    expect(await count("auth.role")).toBe(9);
    expect(await count("auth.permission")).toBe(permissions);
    expect(await count("auth.role_permission")).toBe(grants);
  });

  it("stores exactly the manifest, at the catalog version", async () => {
    const { rows: storedRoles } = await admin.query(
      "SELECT code, name, description, principal_type, status, is_system_role, catalog_version FROM auth.role ORDER BY code",
    );
    expect(storedRoles).toEqual(
      authorizationCatalog.roles
        .map(roleRow)
        .sort((a, b) => a.code.localeCompare(b.code))
        .map((r) => ({
          code: r.code,
          name: r.name,
          description: r.description,
          principal_type: r.principalType,
          status: r.status,
          is_system_role: r.isSystemRole,
          catalog_version: AUTHORIZATION_CATALOG_VERSION,
        })),
    );
    const { rows: storedPermissions } = await admin.query(
      "SELECT code, max_sensitivity, operation, recent_auth_policy, recent_auth_purpose FROM auth.permission",
    );
    const byCode = new Map(storedPermissions.map((p) => [p.code, p]));
    for (const p of authorizationCatalog.permissions.map(permissionRow)) {
      expect(byCode.get(p.code), p.code).toEqual({
        code: p.code,
        max_sensitivity: p.maxSensitivity,
        operation: p.operation,
        recent_auth_policy: p.recentAuthPolicy,
        recent_auth_purpose: p.recentAuthPurpose,
      });
    }
    const { rows: storedGrants } = await admin.query(
      `SELECT r.code AS role, p.code AS permission, rp.condition FROM auth.role_permission rp
       JOIN auth.role r ON r.id = rp.role_id JOIN auth.permission p ON p.id = rp.permission_id`,
    );
    const grantKeys = new Set(
      storedGrants.map((g) => `${g.role}|${g.permission}`),
    );
    for (const g of authorizationCatalog.grants.map(grantRow)) {
      expect(grantKeys.has(`${g.roleCode}|${g.permissionCode}`)).toBe(true);
    }
    // No wildcard, admin, or bypass codes exist.
    const { rows: wild } = await admin.query(
      "SELECT code FROM auth.permission WHERE code ~ '[*]|(^|\\.)(all|admin|superuser)(\\.|$)'",
    );
    expect(wild).toEqual([]);
  });

  it("creates no users, sessions, assignments, or authorization subjects", async () => {
    expect(await count('auth."user"')).toBe(0);
    expect(await count("auth.session")).toBe(0);
    expect(await count("auth.user_role_assignment")).toBe(0);
    expect(await count("auth.authorization_subject")).toBe(0);
  });

  it("is idempotent: re-running changes nothing", async () => {
    const before = await admin.query(
      "SELECT code, updated_at, xmin::text FROM auth.permission ORDER BY code",
    );
    const result = await script("catalog");
    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain(
      `roles: 0 inserted, 0 updated, ${roles} unchanged; permissions: 0 inserted, 0 updated, ${permissions} unchanged; grants: 0 inserted, 0 updated, ${grants} unchanged`,
    );
    const after = await admin.query(
      "SELECT code, updated_at, xmin::text FROM auth.permission ORDER BY code",
    );
    expect(after.rows).toEqual(before.rows);
    const check = await script("catalogCheck");
    expect(check.code, check.output).toBe(0);
  });

  it("detects drift and repairs controlled fields through a reviewed apply", async () => {
    await admin.query(
      "UPDATE auth.permission SET max_sensitivity = 'RESTRICTED_SCREENING_MEDICAL', restricted_data = true WHERE code = 'candidate.read.assigned'",
    );
    const check = await script("catalogCheck");
    expect(check.code).not.toBe(0);
    expect(check.output).toContain("permissions: 0 inserted, 1 updated");
    // Output carries counts only, never row contents.
    expect(check.output).not.toContain("candidate.read.assigned");
    const repaired = await script("catalog");
    expect(repaired.code).toBe(0);
    expect((await script("catalogCheck")).code).toBe(0);
  });

  it("refuses unknown (tampered) rows and code repurposing", async () => {
    const { rows } = await admin.query<{ id: string }>(
      `INSERT INTO auth.permission (code, resource, action, operation, max_sensitivity, permission_domain, description, status,
         requires_scope, requires_reason, restricted_data, is_export, high_risk, catalog_version)
       VALUES ('backdoor.read', 'backdoor', 'read', 'READ', 'INTERNAL', 'BUSINESS', 'TEST tamper', 'ACTIVE',
         true, false, false, false, false, 1) RETURNING id`,
    );
    for (const name of ["catalog", "catalogCheck"] as const) {
      const result = await script(name);
      expect(result.code, name).not.toBe(0);
      expect(result.output).toMatch(/not in the reviewed catalog/);
      expect(result.output).not.toContain("backdoor");
    }
    await admin.query("DELETE FROM auth.permission WHERE id = $1", [
      rows[0]!.id,
    ]);

    await admin.query(
      "UPDATE auth.role SET principal_type = 'CANDIDATE' WHERE code = 'RECRUITER'",
    );
    const repurposed = await script("catalog");
    expect(repurposed.code).not.toBe(0);
    expect(repurposed.output).toMatch(/repurposed/);
    await admin.query(
      "UPDATE auth.role SET principal_type = 'STAFF' WHERE code = 'RECRUITER'",
    );
    expect((await script("catalogCheck")).code).toBe(0);
  });

  it("rejects wildcard codes and malformed conditions at the database", async () => {
    const insertPermission = (code: string) =>
      admin.query(
        `INSERT INTO auth.permission (code, resource, action, operation, max_sensitivity, permission_domain, description, status,
           requires_scope, requires_reason, restricted_data, is_export, high_risk, catalog_version)
         VALUES ($1::varchar, $2::varchar, $3::varchar, 'READ', 'INTERNAL', 'BUSINESS', 'x', 'ACTIVE',
           true, false, false, false, false, 1)`,
        [
          code,
          code.split(".")[0],
          code.includes(".") ? code.slice(code.indexOf(".") + 1) : "",
        ],
      );
    for (const code of [
      "candidate.*",
      "*",
      "admin",
      "Candidate.Read",
      "a.b.c.d.e",
    ]) {
      await expect(insertPermission(code), code).rejects.toMatchObject({
        code: "23514",
      });
    }
    await expect(
      admin.query(
        `UPDATE auth.role_permission SET condition = '{"v":1,"kind":"EXPRESSION"}'::jsonb
         WHERE role_id = (SELECT id FROM auth.role WHERE code = 'RECRUITER') AND permission_id = (SELECT id FROM auth.permission WHERE code = 'application.read')`,
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("lets the runtime role read but never write the catalog", async () => {
    const app = new PgClient({ connectionString: db.urls.app });
    await app.connect();
    try {
      const { rows } = await app.query(
        "SELECT count(*)::int AS n FROM auth.permission",
      );
      expect(rows[0].n).toBe(permissions);
      for (const statement of [
        "UPDATE auth.permission SET description = 'x' WHERE code = 'application.read'",
        "INSERT INTO auth.role (code, name, description, principal_type, status, is_system_role, catalog_version) VALUES ('SUPERUSER', 'x', 'x', 'STAFF', 'ACTIVE', true, 1)",
        "DELETE FROM auth.role_permission",
        "DELETE FROM auth.user_role_assignment",
        "UPDATE auth.user_role_assignment SET role_id = role_id",
        "UPDATE auth.user_role_assignment SET effective_to = NULL",
        "DELETE FROM auth.authorization_subject",
      ]) {
        const error = await app.query(statement).catch((e: unknown) => e);
        expect(pgErrorCode(error), statement).toBe("42501");
      }
      // Lifecycle columns are updatable (no rows match; privilege only).
      await app.query(
        "UPDATE auth.user_role_assignment SET status = status, version = version WHERE false",
      );
    } finally {
      await app.end();
    }
  });

  it("passes the least-privilege runtime check", async () => {
    const result = await script("check");
    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain(
      "authorization privileges: catalog read-only, assignments insert + lifecycle-column update, no DELETE",
    );
  });
});

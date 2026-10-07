import type { Client } from "pg";
import {
  databaseUrlParts,
  localDatabaseRoles,
  type LocalBootstrapEnv,
} from "../../../src/config/env-schema";

// Idempotent local role and privilege setup. Uses only fixed, reviewed
// identifiers; passwords are passed as bind parameters and quoted by
// PostgreSQL's format(%L). Nothing here drops or deletes anything.

const { migrator, app } = localDatabaseRoles;
const safeDatabaseName = /^[a-z][a-z0-9_]{0,62}$/;

const roleAttributes =
  "LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS";

/** Creates or updates the migrator and application login roles. */
export async function ensureLocalRoles(
  admin: Client,
  env: LocalBootstrapEnv,
): Promise<string[]> {
  const report: string[] = [];
  const passwords: Record<string, string> = {
    [migrator]: databaseUrlParts(env.DATABASE_MIGRATION_URL).password,
    [app]: databaseUrlParts(env.DATABASE_URL).password,
  };

  for (const role of [migrator, app]) {
    const { rowCount } = await admin.query(
      "SELECT 1 FROM pg_roles WHERE rolname = $1",
      [role],
    );
    const verb = rowCount ? "ALTER" : "CREATE";
    const { rows } = await admin.query<{ statement: string }>(
      `SELECT format('${verb} ROLE %I WITH ${roleAttributes} PASSWORD %L', $1::text, $2::text) AS statement`,
      [role, passwords[role]],
    );
    await admin.query(rows[0].statement);
    report.push(
      `${role}: ${rowCount ? "already present, attributes ensured" : "created"}`,
    );
  }
  return report;
}

/**
 * Applies database, schema, and default privileges for `database`.
 * The admin client must be connected to that database.
 */
export async function applyLocalDatabaseGrants(
  admin: Client,
  database: string,
): Promise<string[]> {
  if (!safeDatabaseName.test(database)) {
    throw new Error("refusing to grant on an unexpected database name");
  }
  const { rows: current } = await admin.query<{ db: string }>(
    "SELECT current_database() AS db",
  );
  if (current[0].db !== database) {
    throw new Error("admin connection is not on the expected database");
  }

  for (const schema of ["app", "drizzle", "auth", "audit"]) {
    const { rows } = await admin.query<{ owner: string }>(
      "SELECT pg_get_userbyid(nspowner) AS owner FROM pg_namespace WHERE nspname = $1",
      [schema],
    );
    if (rows.length && rows[0].owner !== migrator) {
      throw new Error(
        `schema "${schema}" exists but is owned by another role. Manual recovery: ` +
          `as the local admin run ALTER SCHEMA ${schema} OWNER TO ${migrator}; ` +
          `and reassign its objects, then rerun this command. Do not delete the volume.`,
      );
    }
  }

  const db = await quoteIdent(admin, database);
  const statements = [
    `REVOKE ALL ON DATABASE ${db} FROM PUBLIC`,
    `GRANT CONNECT ON DATABASE ${db} TO ${app}`,
    // CREATE lets the migrator create the app/journal schemas; the
    // application role never receives it.
    `GRANT CONNECT, CREATE ON DATABASE ${db} TO ${migrator}`,
    `REVOKE CREATE ON SCHEMA public FROM PUBLIC`,
    `CREATE SCHEMA IF NOT EXISTS app AUTHORIZATION ${migrator}`,
    `CREATE SCHEMA IF NOT EXISTS drizzle AUTHORIZATION ${migrator}`,
    `REVOKE ALL ON SCHEMA app FROM PUBLIC`,
    `REVOKE ALL ON SCHEMA drizzle FROM PUBLIC`,
    `GRANT USAGE ON SCHEMA app TO ${app}`,
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA app TO ${app}`,
    `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA app TO ${app}`,
    `ALTER DEFAULT PRIVILEGES FOR ROLE ${migrator} IN SCHEMA app GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${app}`,
    `ALTER DEFAULT PRIVILEGES FOR ROLE ${migrator} IN SCHEMA app GRANT USAGE, SELECT ON SEQUENCES TO ${app}`,
    // Better Auth tables (ADR-0002): read/insert/update only by default.
    `CREATE SCHEMA IF NOT EXISTS auth AUTHORIZATION ${migrator}`,
    `REVOKE ALL ON SCHEMA auth FROM PUBLIC`,
    `GRANT USAGE ON SCHEMA auth TO ${app}`,
    `GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA auth TO ${app}`,
    `ALTER DEFAULT PRIVILEGES FOR ROLE ${migrator} IN SCHEMA auth GRANT SELECT, INSERT, UPDATE ON TABLES TO ${app}`,
    // M1.6 append-only audit (ADR-0012): a separate schema with NO default
    // privileges, so no audit table ever inherits runtime write access.
    `CREATE SCHEMA IF NOT EXISTS audit AUTHORIZATION ${migrator}`,
    `REVOKE ALL ON SCHEMA audit FROM PUBLIC`,
    `GRANT USAGE ON SCHEMA audit TO ${app}`,
  ];
  // Table-specific DELETE, applied once the auth migration has created the
  // tables (run db:bootstrap:local again after db:migrate). Sessions and
  // verification records are deleted on revocation/consumption; accounts and
  // credentials are never deleted by the application. M1.3: the
  // two-factor enrollment is removed by MFA reset and expired TOTP replay
  // markers are pruned; staff invitations and recovery cases are security
  // evidence and are never deleted.
  for (const table of [
    "session",
    "verification",
    "two_factor",
    "totp_replay_guard",
  ]) {
    if (await tableExists(admin, `auth.${table}`)) {
      statements.push(`GRANT DELETE ON auth.${table} TO ${app}`);
    }
  }
  for (const table of [
    "user",
    "account",
    "staff_invitation",
    "staff_recovery_case",
  ]) {
    if (await tableExists(admin, `auth.${table}`)) {
      statements.push(`REVOKE DELETE, TRUNCATE ON auth."${table}" FROM ${app}`);
    }
  }

  // M1.4 authorization (ADR-0005). The catalog tables are written only by
  // the reviewed catalog apply step under the migration role, so the
  // runtime role may only read them. Assignments are insert-only for the
  // runtime role except their lifecycle columns, so subject, role, scope,
  // and effective dates can never be rewritten; the authorization epoch is
  // never deleted.
  for (const table of ["role", "permission", "role_permission"]) {
    if (await tableExists(admin, `auth.${table}`)) {
      statements.push(
        `REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON auth.${table} FROM ${app}`,
      );
    }
  }
  if (await tableExists(admin, "auth.user_role_assignment")) {
    statements.push(
      `REVOKE UPDATE, DELETE, TRUNCATE ON auth.user_role_assignment FROM ${app}`,
      `GRANT UPDATE (${assignmentLifecycleColumns.join(", ")}) ON auth.user_role_assignment TO ${app}`,
    );
  }
  if (await tableExists(admin, "auth.authorization_subject")) {
    statements.push(
      `REVOKE DELETE, TRUNCATE ON auth.authorization_subject FROM ${app}`,
    );
  }

  // The runtime role reaches audit storage only through the reviewed
  // SECURITY DEFINER append functions, and may read only the projection
  // columns of audit_event: never integrity hashes, key versions, chain
  // positions, request IDs, the chain head, or security_event.
  if (await tableExists(admin, "audit.audit_event")) {
    statements.push(
      `REVOKE ALL ON ALL TABLES IN SCHEMA audit FROM ${app}`,
      `GRANT SELECT (${auditProjectionColumns.join(", ")}) ON audit.audit_event TO ${app}`,
      `GRANT EXECUTE ON FUNCTION audit.claim_chain_head(text), audit.append_audit_event(jsonb), audit.append_security_event(jsonb) TO ${app}`,
    );
  }

  await admin.query("BEGIN");
  try {
    for (const statement of statements) await admin.query(statement);
    await admin.query("COMMIT");
  } catch (error) {
    await admin.query("ROLLBACK");
    throw error;
  }
  return [
    `database ${database}: CONNECT for ${app}; CONNECT, CREATE for ${migrator}; PUBLIC access revoked`,
    `schemas app, drizzle, auth: owned by ${migrator}; ${app} has USAGE on app and auth`,
    `${app}: SELECT/INSERT/UPDATE/DELETE on app tables, including future ones (default privileges)`,
    `schema auth: owned by ${migrator}; ${app} has SELECT/INSERT/UPDATE, DELETE only on auth.session, auth.verification, auth.two_factor, and auth.totp_replay_guard`,
    `authorization: ${app} has SELECT only on auth.role, auth.permission, auth.role_permission; INSERT and lifecycle-column UPDATE only on auth.user_role_assignment; no DELETE`,
    `audit: owned by ${migrator}, no default privileges; ${app} has EXECUTE on the append functions and column-limited SELECT on audit.audit_event only`,
  ];
}

/** Assignment columns the runtime role may update (lifecycle only). */
export const assignmentLifecycleColumns = [
  "status",
  "approved_by_user_id",
  "approved_at",
  "revoked_at",
  "revoked_by_user_id",
  "revocation_reason_code",
  "superseded_by_assignment_id",
  "version",
  "updated_at",
] as const;

/** audit_event columns the runtime role may read (query projection). */
export const auditProjectionColumns = [
  "id",
  "event_name",
  "event_version",
  "category",
  "outcome",
  "organization_id",
  "candidacy_id",
  "actor_type",
  "actor_user_id",
  "effective_role_code",
  "effective_scope_type",
  "permission_code",
  "action",
  "target_type",
  "target_id",
  "reason_code",
  "correlation_id",
  "occurred_at",
  "metadata_json",
] as const;

async function tableExists(client: Client, table: string): Promise<boolean> {
  const { rows } = await client.query<{ exists: boolean }>(
    "SELECT to_regclass($1) IS NOT NULL AS exists",
    [table],
  );
  return rows[0].exists;
}

async function quoteIdent(client: Client, name: string): Promise<string> {
  const { rows } = await client.query<{ q: string }>(
    "SELECT quote_ident($1) AS q",
    [name],
  );
  return rows[0].q;
}

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

  for (const schema of ["app", "drizzle", "auth"]) {
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
  ];
  // Table-specific DELETE, applied once the auth migration has created the
  // tables (run db:bootstrap:local again after db:migrate). Sessions and
  // verification records are deleted on revocation/consumption; accounts and
  // credentials are never deleted by the application.
  for (const table of ["session", "verification"]) {
    if (await tableExists(admin, `auth.${table}`)) {
      statements.push(`GRANT DELETE ON auth.${table} TO ${app}`);
    }
  }
  for (const table of ["user", "account"]) {
    if (await tableExists(admin, `auth.${table}`)) {
      statements.push(`REVOKE DELETE, TRUNCATE ON auth."${table}" FROM ${app}`);
    }
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
    `schema auth: owned by ${migrator}; ${app} has SELECT/INSERT/UPDATE, DELETE only on auth.session and auth.verification`,
  ];
}

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

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

  for (const schema of ["app", "drizzle"]) {
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
  ];

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
    `schemas app, drizzle: owned by ${migrator}; ${app} has USAGE on app only`,
    `${app}: SELECT/INSERT/UPDATE/DELETE on app tables, including future ones (default privileges)`,
  ];
}

async function quoteIdent(client: Client, name: string): Promise<string> {
  const { rows } = await client.query<{ q: string }>(
    "SELECT quote_ident($1) AS q",
    [name],
  );
  return rows[0].q;
}

import { sql, type SQL } from "drizzle-orm";
import { closeDatabasePool, getDatabase } from "../../src/shared/database";
import {
  assertCheck,
  CheckFailure,
  pgErrorCode,
  runScript,
} from "./lib/tooling";

// Verifies the runtime connection through the least-privileged application
// role: connectivity, PostgreSQL version, UTC session, migrated schema, DML,
// and the absence of DDL/role privileges. Leaves no data behind.

class Rollback extends Error {}

void runScript("db:check", async () => {
  const db = getDatabase();
  const ok = (label: string) => console.log(`ok    ${label}`);
  const one = async <T>(query: SQL) => (await db.execute(query)).rows[0] as T;

  try {
    await db.execute(sql`SELECT 1`);
    ok("connected as application role");

    const version = await one<{ num: number; text: string }>(
      sql`SELECT current_setting('server_version_num')::int AS num, current_setting('server_version') AS text`,
    );
    assertCheck(
      version.num >= 180000 && version.num < 190000,
      `unsupported PostgreSQL version ${version.text} (expected 18.x)`,
    );
    ok(`PostgreSQL ${version.text}`);

    const tz = await one<{ tz: string; offset: number }>(
      sql`SELECT current_setting('TimeZone') AS tz, extract(timezone FROM now())::int AS offset`,
    );
    assertCheck(
      tz.tz === "UTC" && tz.offset === 0,
      `session timezone is ${tz.tz}, expected UTC`,
    );
    ok("session timezone is UTC");

    const role = await one<Record<string, boolean | string>>(sql`
      SELECT current_user AS name, r.rolsuper, r.rolcreaterole, r.rolcreatedb, r.rolbypassrls,
        has_database_privilege(current_database(), 'CREATE') AS db_create,
        has_database_privilege(current_database(), 'TEMP') AS db_temp,
        has_schema_privilege('app', 'CREATE') AS app_create,
        has_schema_privilege('public', 'CREATE') AS public_create
      FROM pg_roles r WHERE r.rolname = current_user`);
    for (const flag of [
      "rolsuper",
      "rolcreaterole",
      "rolcreatedb",
      "rolbypassrls",
      "db_create",
      "db_temp",
      "app_create",
      "public_create",
    ]) {
      assertCheck(
        role[flag] === false,
        `application role unexpectedly has ${flag}`,
      );
    }
    ok(
      `role ${role.name} has no superuser, role, database, schema, or temp privileges`,
    );

    const table = await one<{ reg: string | null }>(
      sql`SELECT to_regclass('app.system_metadata')::text AS reg`,
    );
    assertCheck(
      table.reg,
      "app.system_metadata is missing (run pnpm db:migrate)",
    );
    ok("app.system_metadata exists");

    // DML round trip inside a transaction that is always rolled back.
    try {
      await db.transaction(async (tx) => {
        await tx.execute(
          sql`INSERT INTO app.system_metadata (key, value) VALUES ('check.probe', '{"probe":true}')`,
        );
        await tx.execute(
          sql`UPDATE app.system_metadata SET value = '{"probe":false}', updated_at = now() WHERE key = 'check.probe'`,
        );
        const read = await tx.execute(
          sql`SELECT value, updated_at AT TIME ZONE 'UTC' AS utc FROM app.system_metadata WHERE key = 'check.probe'`,
        );
        assertCheck(read.rows.length === 1, "probe row was not readable");
        await tx.execute(
          sql`DELETE FROM app.system_metadata WHERE key = 'check.probe'`,
        );
        throw new Rollback();
      });
    } catch (error) {
      if (!(error instanceof Rollback)) throw error;
    }
    ok("select/insert/update/delete on app.system_metadata (rolled back)");

    for (const [label, statement] of [
      ["create table in app", sql`CREATE TABLE app.__db_check_probe (id int)`],
      [
        "create table in public",
        sql`CREATE TABLE public.__db_check_probe (id int)`,
      ],
      [
        "create temporary table",
        sql`CREATE TEMP TABLE __db_check_probe (id int)`,
      ],
      ["create schema", sql`CREATE SCHEMA __db_check_probe`],
      ["create role", sql`CREATE ROLE __db_check_probe`],
    ] as const) {
      let succeeded = false;
      try {
        await db.transaction(async (tx) => {
          await tx.execute(statement);
          succeeded = true;
          throw new Rollback();
        });
      } catch (error) {
        if (!(error instanceof Rollback)) {
          const code = pgErrorCode(error);
          assertCheck(
            code === "42501",
            `${label}: unexpected error ${code ?? "unknown"}`,
          );
        }
      }
      if (succeeded)
        throw new CheckFailure(`application role was able to ${label}`);
      ok(`denied: ${label}`);
    }

    console.log("Database check passed.");
  } finally {
    await closeDatabasePool();
  }
});

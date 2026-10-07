import { randomBytes } from "node:crypto";
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type { Client } from "pg";
import {
  databaseUrlParts,
  localDatabaseRoles,
  parseLocalBootstrapEnv,
} from "../../src/config/env-schema";
import { applyLocalDatabaseGrants, ensureLocalRoles } from "./lib/local-roles";
import {
  appliedMigrationCount,
  countRowsIfTableExists,
  migrationJournal,
  migrationsFolder,
} from "./lib/migrations";
import {
  assertCheck,
  CheckFailure,
  connectTool,
  pgErrorCode,
  runScript,
  withDatabase,
} from "./lib/tooling";

// Proves the committed migrations rebuild the expected schema from an empty
// database. Works only on a disposable database that this run creates
// itself (name psa_verify_*), on a loopback server, in local/test. The
// normal developer database is never modified; the only database dropped is
// the exact one created by this run.

const disposablePattern = /^psa_verify_[a-z0-9_]{1,40}$/;

const expectedColumns = [
  "key|character varying|100|NO|",
  "value|jsonb||NO|",
  "created_at|timestamp with time zone||NO|now()",
  "updated_at|timestamp with time zone||NO|now()",
];

void runScript("db:verify-empty", async () => {
  const env = parseLocalBootstrapEnv(process.env);
  const timeoutMs = env.DATABASE_CONNECTION_TIMEOUT_MS;
  const normalDatabase = databaseUrlParts(env.DATABASE_ADMIN_URL).database;

  const target =
    process.env.DB_VERIFY_DATABASE ??
    `psa_verify_${Date.now().toString(36)}_${randomBytes(4).toString("hex")}`;
  const reserved = new Set([
    "postgres",
    "template0",
    "template1",
    normalDatabase,
  ]);
  for (const url of [env.DATABASE_URL, env.DATABASE_MIGRATION_URL]) {
    reserved.add(databaseUrlParts(url).database);
  }
  if (!disposablePattern.test(target) || reserved.has(target)) {
    throw new CheckFailure(
      "refusing: the verification target must be a new disposable database named psa_verify_*, never the developer database",
    );
  }

  const ok = (label: string) => console.log(`ok    ${label}`);
  const admin = await connectTool({
    url: env.DATABASE_ADMIN_URL,
    applicationName: "psa-hiring-verify",
    timeoutMs,
  });
  let created = false;
  let tempDir: string | undefined;

  try {
    const exists = await admin.query(
      "SELECT 1 FROM pg_database WHERE datname = $1",
      [target],
    );
    if (exists.rowCount) {
      throw new CheckFailure(
        `refusing: database ${target} already exists; it was not created by this run`,
      );
    }
    await admin.query(`CREATE DATABASE ${await quoteIdent(admin, target)}`);
    created = true;
    ok(`created disposable database ${target}`);

    await withClient(
      withDatabase(env.DATABASE_ADMIN_URL, target),
      timeoutMs,
      async (c) => {
        await ensureLocalRoles(c, env);
        await applyLocalDatabaseGrants(c, target);
      },
    );
    ok("applied local roles and grants");

    const migratorUrl = withDatabase(env.DATABASE_MIGRATION_URL, target);
    await withClient(migratorUrl, timeoutMs, async (c) => {
      await migrate(drizzle({ client: c }), {
        migrationsFolder,
        ...migrationJournal,
      });
      await migrate(drizzle({ client: c }), {
        migrationsFolder,
        ...migrationJournal,
      });
      const journal = JSON.parse(
        readFileSync(path.join(migrationsFolder, "meta/_journal.json"), "utf8"),
      ) as { entries: unknown[] };
      const applied = await appliedMigrationCount(c);
      assertCheck(
        applied === journal.entries.length,
        `journal has ${applied} entries, expected ${journal.entries.length}`,
      );
      ok(
        `applied all ${applied} committed migration(s) from empty; second run was a no-op`,
      );
    });

    // Second bootstrap pass: table-specific grants for tables the migrations
    // just created (DELETE on auth.session/verification/two_factor/
    // totp_replay_guard).
    await withClient(
      withDatabase(env.DATABASE_ADMIN_URL, target),
      timeoutMs,
      async (c) => {
        await applyLocalDatabaseGrants(c, target);
      },
    );
    ok("re-applied post-migration grants");

    await withClient(
      withDatabase(env.DATABASE_ADMIN_URL, target),
      timeoutMs,
      async (c) => {
        const schemas = await c.query<{ name: string; owner: string }>(`
        SELECT nspname AS name, pg_get_userbyid(nspowner) AS owner FROM pg_namespace
        WHERE nspname NOT LIKE 'pg\\_%' AND nspname <> 'information_schema' ORDER BY 1`);
        assertCheck(
          schemas.rows.map((r) => r.name).join(",") ===
            "app,auth,drizzle,public",
          `unexpected schemas: ${schemas.rows.map((r) => r.name).join(",")}`,
        );
        ok("schemas are exactly app, auth, drizzle, public");

        const tables = await c.query<{ t: string }>(`
        SELECT schemaname || '.' || tablename AS t FROM pg_tables
        WHERE schemaname NOT IN ('pg_catalog', 'information_schema') ORDER BY 1`);
        assertCheck(
          tables.rows.map((r) => r.t).join(",") ===
            "app.system_metadata,auth.account,auth.authorization_subject,auth.permission,auth.role,auth.role_permission,auth.session,auth.staff_invitation,auth.staff_recovery_case,auth.totp_replay_guard,auth.two_factor,auth.user,auth.user_role_assignment,auth.verification,drizzle.__drizzle_migrations",
          `unexpected tables: ${tables.rows.map((r) => r.t).join(",")}`,
        );
        ok(
          "tables are exactly app.system_metadata, the M1.1–M1.4 auth tables, and the migration journal",
        );

        const columns = await c.query<{ c: string }>(`
        SELECT concat_ws('|', column_name, data_type, coalesce(character_maximum_length::text, ''),
          is_nullable, coalesce(column_default, '')) AS c
        FROM information_schema.columns
        WHERE table_schema = 'app' AND table_name = 'system_metadata' ORDER BY ordinal_position`);
        assertCheck(
          columns.rows.map((r) => r.c).join(";") === expectedColumns.join(";"),
          "app.system_metadata columns do not match the expected definition",
        );
        const pk = await c.query<{ def: string }>(`
        SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conrelid = 'app.system_metadata'::regclass AND contype = 'p'`);
        assertCheck(
          pk.rows[0]?.def === "PRIMARY KEY (key)",
          "primary key is not (key)",
        );
        ok(
          "app.system_metadata columns, types, nullability, defaults, and primary key match",
        );
      },
    );

    const appUrl = withDatabase(env.DATABASE_URL, target);
    await withClient(appUrl, timeoutMs, async (c) => {
      await c.query("BEGIN");
      await c.query(
        `INSERT INTO app.system_metadata (key, value) VALUES ('verify.probe', '{}')`,
      );
      await c.query(
        `UPDATE app.system_metadata SET updated_at = now() WHERE key = 'verify.probe'`,
      );
      await c.query(`SELECT key FROM app.system_metadata`);
      await c.query(
        `DELETE FROM app.system_metadata WHERE key = 'verify.probe'`,
      );
      await c.query("ROLLBACK");
      ok(
        `${localDatabaseRoles.app} can select/insert/update/delete app.system_metadata`,
      );
      for (const [label, statement] of [
        ["create table in app", "CREATE TABLE app.__verify_probe (id int)"],
        [
          "create table in public",
          "CREATE TABLE public.__verify_probe (id int)",
        ],
        ["create temporary table", "CREATE TEMP TABLE __verify_probe (id int)"],
        ["create schema", "CREATE SCHEMA __verify_probe"],
        [
          "read migration journal",
          "SELECT 1 FROM drizzle.__drizzle_migrations",
        ],
      ] as const) {
        await expectDenied(c, label, statement);
      }
      ok(
        `${localDatabaseRoles.app} is denied DDL, temp tables, and the migration journal`,
      );
    });

    // A new forward migration applied by the migration role in the
    // disposable database; default privileges must cover the new table.
    tempDir = mkdtempSync(path.join(os.tmpdir(), "psa-verify-migrations-"));
    const probeFolder = path.join(tempDir, "drizzle");
    cpSync(migrationsFolder, probeFolder, { recursive: true });
    const journalPath = path.join(probeFolder, "meta/_journal.json");
    const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
      entries: {
        idx: number;
        version: string;
        when: number;
        tag: string;
        breakpoints: boolean;
      }[];
    };
    const last = journal.entries[journal.entries.length - 1];
    const tag = `${String(last.idx + 1).padStart(4, "0")}_verify_probe`;
    journal.entries.push({
      ...last,
      idx: last.idx + 1,
      when: last.when + 1,
      tag,
    });
    writeFileSync(journalPath, JSON.stringify(journal, null, 2));
    writeFileSync(
      path.join(probeFolder, `${tag}.sql`),
      `CREATE TABLE "app"."verify_probe" ("id" integer PRIMARY KEY NOT NULL);\n`,
    );
    await withClient(migratorUrl, timeoutMs, async (c) => {
      await migrate(drizzle({ client: c }), {
        migrationsFolder: probeFolder,
        ...migrationJournal,
      });
      assertCheck(
        (await appliedMigrationCount(c)) === journal.entries.length,
        "probe migration was not recorded",
      );
    });
    await withClient(appUrl, timeoutMs, async (c) => {
      await c.query("BEGIN");
      await c.query("INSERT INTO app.verify_probe (id) VALUES (1)");
      await c.query("ROLLBACK");
    });
    ok(
      `${localDatabaseRoles.migrator} applied a new migration; ${localDatabaseRoles.app} inherited DML on the new table`,
    );

    console.log("Empty-database verification passed.");
  } finally {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    try {
      if (created) {
        if (!disposablePattern.test(target) || reserved.has(target)) {
          throw new CheckFailure("refusing to drop an unexpected database");
        }
        await admin.query(
          `DROP DATABASE ${await quoteIdent(admin, target)} WITH (FORCE)`,
        );
        console.log(`ok    dropped disposable database ${target}`);
      }
      const applied = await appliedMigrationCount(admin);
      const metadataRows = await countRowsIfTableExists(
        admin,
        "app.system_metadata",
      );
      console.log(
        `ok    developer database ${normalDatabase} untouched (${applied} migration(s), ${metadataRows} metadata row(s))`,
      );
    } finally {
      await admin.end();
    }
  }
});

async function withClient(
  url: string,
  timeoutMs: number,
  fn: (client: Client) => Promise<void>,
) {
  const client = await connectTool({
    url,
    applicationName: "psa-hiring-verify",
    timeoutMs,
  });
  try {
    await fn(client);
  } finally {
    await client.end();
  }
}

async function expectDenied(client: Client, label: string, statement: string) {
  await client.query("BEGIN");
  try {
    await client.query(statement);
    throw new CheckFailure(`${localDatabaseRoles.app} was able to ${label}`);
  } catch (error) {
    if (error instanceof CheckFailure) throw error;
    assertCheck(
      pgErrorCode(error) === "42501",
      `${label}: unexpected error ${pgErrorCode(error) ?? "unknown"}`,
    );
  } finally {
    await client.query("ROLLBACK");
  }
}

async function quoteIdent(client: Client, name: string): Promise<string> {
  const { rows } = await client.query<{ q: string }>(
    "SELECT quote_ident($1) AS q",
    [name],
  );
  return rows[0].q;
}

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { sql } from "drizzle-orm";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, inject, it, vi } from "vitest";
import {
  closeDatabasePool,
  getDatabase,
  systemMetadata,
} from "@/shared/database";
import { buildSystemMetadataRecord } from "../../fixtures/foundation";
import {
  adminClient,
  assertNoSecrets,
  buildHarnessEnv,
  createOwnedDatabase,
  dropOwnedDatabase,
  runDbScript,
  type OwnedDatabase,
} from "../support/harness";

// M0.3 database foundation, proven against a fresh database in the owned
// disposable container using the real committed migrations and real scripts.

const ctx = inject("postgres");
const drizzleDir = path.resolve(import.meta.dirname, "../../../drizzle");
const journal = JSON.parse(
  readFileSync(path.join(drizzleDir, "meta/_journal.json"), "utf8"),
) as { entries: { tag: string; when: number }[] };

class Rollback extends Error {}

let db: OwnedDatabase;
let env: ReturnType<typeof buildHarnessEnv>;
let admin: Client;
let firstMigrateOutput = "";

/** Points the real runtime client (src/shared/database) at the owned DB. */
function useOwnedRuntimeEnv() {
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
}

async function sqlState(
  fn: () => Promise<unknown>,
): Promise<string | undefined> {
  try {
    await fn();
    return undefined;
  } catch (error) {
    const e = error as { code?: string; cause?: { code?: string } };
    return e.code ?? e.cause?.code ?? "unknown";
  }
}

beforeAll(async () => {
  db = await createOwnedDatabase(ctx, "foundation");
  env = buildHarnessEnv(db);
  const bootstrap = await runDbScript("bootstrap", env);
  assertNoSecrets(ctx, bootstrap.output);
  expect(bootstrap.code, bootstrap.output).toBe(0);
  const migrate = await runDbScript("migrate", env);
  assertNoSecrets(ctx, migrate.output);
  expect(migrate.code, migrate.output).toBe(0);
  firstMigrateOutput = migrate.output;
  // Second pass applies table-specific grants for newly created tables.
  const regrant = await runDbScript("bootstrap", env);
  expect(regrant.code, regrant.output).toBe(0);
  admin = await adminClient(ctx, db.name);
});

afterAll(async () => {
  await closeDatabasePool();
  await admin?.end();
  if (db) await dropOwnedDatabase(ctx, db.name);
});

describe("committed migrations", () => {
  it("1. apply every committed migration to an empty database", async () => {
    expect(firstMigrateOutput).toContain(
      `Applied ${journal.entries.length} migration(s); ${journal.entries.length} total.`,
    );
    const { rows } = await admin.query<{ hash: string; created_at: string }>(
      "SELECT hash, created_at FROM drizzle.__drizzle_migrations ORDER BY id",
    );
    expect(rows).toHaveLength(journal.entries.length);
    journal.entries.forEach((entry, i) => {
      const sqlText = readFileSync(
        path.join(drizzleDir, `${entry.tag}.sql`),
        "utf8",
      );
      expect(rows[i].hash).toBe(
        createHash("sha256").update(sqlText).digest("hex"),
      );
      expect(Number(rows[i].created_at)).toBe(entry.when);
    });
  });

  it("2. create app.system_metadata with the approved shape", async () => {
    const columns = await admin.query(`
      SELECT column_name, data_type, character_maximum_length AS len, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_schema = 'app' AND table_name = 'system_metadata'
      ORDER BY ordinal_position`);
    expect(columns.rows).toEqual([
      {
        column_name: "key",
        data_type: "character varying",
        len: 100,
        is_nullable: "NO",
        column_default: null,
      },
      {
        column_name: "value",
        data_type: "jsonb",
        len: null,
        is_nullable: "NO",
        column_default: null,
      },
      {
        column_name: "created_at",
        data_type: "timestamp with time zone",
        len: null,
        is_nullable: "NO",
        column_default: "now()",
      },
      {
        column_name: "updated_at",
        data_type: "timestamp with time zone",
        len: null,
        is_nullable: "NO",
        column_default: "now()",
      },
    ]);
    const pk = await admin.query<{ def: string }>(`
      SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE conrelid = 'app.system_metadata'::regclass AND contype = 'p'`);
    expect(pk.rows.map((r) => r.def)).toEqual(["PRIMARY KEY (key)"]);
  });

  it("3. keep the migration journal in the drizzle schema, owned by the migrator", async () => {
    const { rows } = await admin.query(`
      SELECT schemaname, tablename, tableowner FROM pg_tables
      WHERE tablename = '__drizzle_migrations'`);
    expect(rows).toEqual([
      {
        schemaname: "drizzle",
        tablename: "__drizzle_migrations",
        tableowner: "psa_migrator",
      },
    ]);
  });

  it("4. treat a second migration run as a no-op", async () => {
    const before = await admin.query(
      "SELECT 'app.system_metadata'::regclass::oid AS oid, (SELECT count(*)::int FROM drizzle.__drizzle_migrations) AS n",
    );
    const again = await runDbScript("migrate", env);
    assertNoSecrets(ctx, again.output);
    expect(again.code, again.output).toBe(0);
    expect(again.output).toContain(
      `No pending migrations; ${journal.entries.length} applied.`,
    );
    const after = await admin.query(
      "SELECT 'app.system_metadata'::regclass::oid AS oid, (SELECT count(*)::int FROM drizzle.__drizzle_migrations) AS n",
    );
    expect(after.rows).toEqual(before.rows);
  });
});

describe("seed", () => {
  it("5. leaves exactly one deterministic technical record when run twice", async () => {
    const first = await runDbScript("seed", env);
    const second = await runDbScript("seed", env);
    for (const r of [first, second]) {
      assertNoSecrets(ctx, r.output);
      expect(r.code, r.output).toBe(0);
    }
    expect(second.output).toContain(
      "Seed updated: foundation.seed (1 metadata row total)",
    );

    const { rows } = await admin.query(
      "SELECT key, value, updated_at >= created_at AS ordered FROM app.system_metadata",
    );
    expect(rows).toEqual([
      {
        key: "foundation.seed",
        value: {
          schemaVersion: 1,
          foundation: "M0.3",
          purpose: "database foundation",
        },
        ordered: true,
      },
    ]);
  });
});

describe("runtime client (src/shared/database)", () => {
  it("6. uses UTC sessions and UTC timestamp semantics", async () => {
    useOwnedRuntimeEnv();
    try {
      const database = getDatabase();
      const tz = await database.execute(
        sql`SELECT current_setting('TimeZone') AS tz`,
      );
      expect(tz.rows[0]).toEqual({ tz: "UTC" });
      const read = await database.execute(
        sql`SELECT ('2026-01-15 08:00:00-05'::timestamptz)::text AS utc_text`,
      );
      expect(read.rows[0]).toEqual({ utc_text: "2026-01-15 13:00:00+00" });
    } finally {
      await closeDatabasePool();
    }
  });

  it("7. lets the application role select, insert, update, and delete metadata", async () => {
    useOwnedRuntimeEnv();
    const fixture = buildSystemMetadataRecord({}, 7);
    try {
      const database = getDatabase();
      await expect(
        database.transaction(async (tx) => {
          await tx.insert(systemMetadata).values(fixture);
          await tx
            .update(systemMetadata)
            .set({
              value: { ...fixture.value, updated: true },
              updatedAt: sql`now()`,
            })
            .where(sql`${systemMetadata.key} = ${fixture.key}`);
          const rows = await tx
            .select({ key: systemMetadata.key, value: systemMetadata.value })
            .from(systemMetadata)
            .where(sql`${systemMetadata.key} = ${fixture.key}`);
          expect(rows).toEqual([
            { key: fixture.key, value: { ...fixture.value, updated: true } },
          ]);
          await tx
            .delete(systemMetadata)
            .where(sql`${systemMetadata.key} = ${fixture.key}`);
          throw new Rollback();
        }),
      ).rejects.toBeInstanceOf(Rollback);
      const left = await admin.query(
        "SELECT 1 FROM app.system_metadata WHERE key = $1",
        [fixture.key],
      );
      expect(left.rowCount).toBe(0);
    } finally {
      await closeDatabasePool();
    }
  });

  it("8. denies the application role DDL and role management", async () => {
    useOwnedRuntimeEnv();
    try {
      const database = getDatabase();
      for (const statement of [
        sql`CREATE TABLE app.__probe (id int)`,
        sql`ALTER TABLE app.system_metadata ADD COLUMN probe int`,
        sql`DROP TABLE app.system_metadata`,
        sql`CREATE SCHEMA __probe`,
        sql`CREATE TABLE public.__probe (id int)`,
        sql`CREATE TEMP TABLE __probe (id int)`,
        sql`CREATE ROLE __probe`,
        sql`TRUNCATE app.system_metadata`,
        sql`SELECT 1 FROM drizzle.__drizzle_migrations`,
      ]) {
        await expect(sqlState(() => database.execute(statement))).resolves.toBe(
          "42501",
        );
      }
      const role = await admin.query(`
        SELECT rolsuper, rolcreaterole, rolcreatedb, rolbypassrls
        FROM pg_roles WHERE rolname = 'psa_app'`);
      expect(role.rows).toEqual([
        {
          rolsuper: false,
          rolcreaterole: false,
          rolcreatedb: false,
          rolbypassrls: false,
        },
      ]);
    } finally {
      await closeDatabasePool();
    }
  });

  it("9. drains its pool so no application connections remain", async () => {
    useOwnedRuntimeEnv();
    const database = getDatabase();
    await database.execute(sql`SELECT 1`);
    const openNow = await admin.query(
      "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1 AND application_name = 'psa-hiring-app'",
      [db.name],
    );
    expect(openNow.rows[0].n).toBeGreaterThan(0);
    await closeDatabasePool();
    await expect
      .poll(
        async () =>
          (
            await admin.query(
              "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1 AND application_name LIKE 'psa-hiring-%'",
              [db.name],
            )
          ).rows[0].n,
        { timeout: 5_000, interval: 100 },
      )
      .toBe(0);
  });
});

describe("scope", () => {
  it("10. contains no business-domain, audit, or job tables", async () => {
    const { rows } = await admin.query<{ t: string }>(`
      SELECT schemaname || '.' || tablename AS t FROM pg_tables
      WHERE schemaname NOT IN ('pg_catalog', 'information_schema') ORDER BY 1`);
    // M1.1 adds exactly the four Better Auth tables (ADR-0002).
    expect(rows.map((r) => r.t)).toEqual([
      "app.system_metadata",
      "auth.account",
      "auth.session",
      "auth.user",
      "auth.verification",
      "drizzle.__drizzle_migrations",
    ]);
    const forbidden =
      /candida|account|person|screening|offer|onboard|readiness|assignment|timesheet|payroll|leave|audit|job|outbox/;
    expect(
      rows.filter((r) => !r.t.startsWith("auth.") && forbidden.test(r.t)),
    ).toEqual([]);
  });
});

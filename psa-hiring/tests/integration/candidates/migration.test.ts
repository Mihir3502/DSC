import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, describe, expect, inject, it } from "vitest";
import { AUTHORIZATION_CATALOG_VERSION } from "@/modules/identity-access/policy/authorization-catalog";
import { connect } from "../support/audit";
import {
  adminClient,
  assertNoSecrets,
  buildHarnessEnv,
  createOwnedDatabase,
  dropOwnedDatabase,
  runDbScript,
} from "../support/harness";

// M2.2 migration from the accepted M2.1 schema (packet M2.2 §22, AC-M2.2-14):
// 0006 applies over 0000–0005 with existing synthetic hierarchy data,
// creates no person or candidacy row, adds no audit history beyond the
// catalog apply, and leaves the runtime role without DELETE.

const ctx = inject("postgres");
const databases: string[] = [];

afterAll(async () => {
  for (const name of databases) await dropOwnedDatabase(ctx, name);
});

describe("migration from the accepted M2.1 schema", () => {
  it("applies 0006 over M2.1 with synthetic data, fabricating no person or candidacy rows", async () => {
    const m21 = await createOwnedDatabase(ctx, "cand_m21");
    databases.push(m21.name);
    const env = buildHarnessEnv(m21);
    const boot = await runDbScript("bootstrap", env);
    expect(boot.code, boot.output).toBe(0);
    const folder = mkdtempSync(path.join(tmpdir(), "psa-m21-"));
    try {
      cpSync(path.resolve(import.meta.dirname, "../../../drizzle"), folder, {
        recursive: true,
      });
      const journalPath = path.join(folder, "meta/_journal.json");
      const journal = JSON.parse(readFileSync(journalPath, "utf8"));
      journal.entries = journal.entries.filter(
        (e: { idx: number }) => e.idx <= 5,
      );
      writeFileSync(journalPath, JSON.stringify(journal));
      rmSync(path.join(folder, "0006_person_candidacy.sql"));
      const migrator = await connect(m21.urls.migrator);
      try {
        await migrate(drizzle({ client: migrator }), {
          migrationsFolder: folder,
          migrationsSchema: "drizzle",
          migrationsTable: "__drizzle_migrations",
        });
      } finally {
        await migrator.end();
      }
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
    const admin = await adminClient(ctx, m21.name);
    try {
      expect(
        (await admin.query("SELECT to_regclass('app.person') AS t")).rows[0].t,
      ).toBeNull();
      const email = `test.m21.${randomUUID()}@example.test`;
      const { rows } = await admin.query<{ id: string }>(
        `INSERT INTO auth."user" (name, email, email_display, email_verified, account_type, status)
         VALUES ('TEST m21 staff', $1, $2, true, 'STAFF', 'ACTIVE') RETURNING id`,
        [email, email],
      );
      await admin.query(
        `INSERT INTO app.organization (code, legal_name, display_name, timezone, created_by_account_id, updated_by_account_id)
         VALUES ('M21ORG', 'TEST M21 LLC', 'TEST M21', 'UTC', $1, $1)`,
        [rows[0]!.id],
      );
      for (const step of [
        "migrate",
        "bootstrap",
        "catalog",
        "check",
      ] as const) {
        const result = await runDbScript(step, env);
        assertNoSecrets(ctx, result.output);
        expect(result.code, `${step}: ${result.output}`).toBe(0);
      }
      expect(
        (await admin.query("SELECT count(*)::int AS n FROM app.organization"))
          .rows[0].n,
      ).toBe(1);
      for (const table of [
        "person",
        "candidacy",
        "candidacy_stage_history",
        "duplicate_candidate_match",
        "person_merge_record",
      ]) {
        expect(
          (await admin.query(`SELECT count(*)::int AS n FROM app.${table}`))
            .rows[0].n,
          table,
        ).toBe(0);
      }
      expect(
        (
          await admin.query(
            "SELECT max(catalog_version)::int AS v FROM auth.permission",
          )
        ).rows[0].v,
      ).toBe(AUTHORIZATION_CATALOG_VERSION);
      const events = await admin.query(
        "SELECT event_name FROM audit.audit_event",
      );
      expect(events.rows.map((r) => r.event_name)).toEqual([
        "authz.catalog_applied",
      ]);
      const grants = await admin.query(
        "SELECT has_table_privilege('psa_app', 'app.person', 'DELETE') AS person, has_table_privilege('psa_app', 'app.candidacy_stage_history', 'UPDATE') AS history",
      );
      expect(grants.rows[0]).toEqual({ person: false, history: false });
    } finally {
      await admin.end();
    }
  });
});

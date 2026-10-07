import { execFile } from "node:child_process";
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { randomBytes, randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import {
  AuditRecorder,
  parseAuditKeyRing,
  queryAuditEvents,
  noRecordGroups,
  type AuditKeyRing,
} from "@/modules/audit";
import { chainPartitionFor } from "@/modules/audit/domain/integrity-chain";
import { closeDatabasePool, getDatabase } from "@/shared/database";
import { createLogger } from "@/shared/logging";
import { createMemoryDestination } from "../../fixtures/canaries";
import { connect, testKeys, verify } from "../support/audit";
import { prepareAuthorizationDatabase } from "../support/authorization";
import {
  adminClient,
  assertNoSecrets,
  buildHarnessEnv,
  createOwnedDatabase,
  dropOwnedDatabase,
  runDbScript,
  type OwnedDatabase,
} from "../support/harness";

// M1.6 tamper evidence, key rotation, migration, and recovery (packet M1.6
// §12.3, §17, §18, §24, §26 (13–15); AC-M1.6-05/06/12/13). Corruption is
// applied only by the privileged test admin inside the disposable
// database; the application and verifier never repair anything. Failure
// output is checked for hashes and metadata without printing either.

const ctx = inject("postgres");
const run = promisify(execFile);
let db: OwnedDatabase;
let admin: Client;
let restoreEnv: () => void;
const extraDatabases: string[] = [];
const logger = createLogger({ destination: createMemoryDestination() });

const recorder = (keys: AuditKeyRing = testKeys()) =>
  new AuditRecorder({ db: getDatabase(), logger, keys, source: "LOCAL_TEST" });

async function account(label: string): Promise<string> {
  const email = `test.${label}.${randomUUID()}@example.test`;
  const { rows } = await admin.query<{ id: string }>(
    `INSERT INTO auth."user" (name, email, email_display, email_verified, account_type, status)
     VALUES ('TEST staff', $1, $2, true, 'STAFF', 'ACTIVE') RETURNING id`,
    [email, email],
  );
  return rows[0]!.id;
}

/** A verification ring holding several versions (retained old keys). */
function combined(...rings: AuditKeyRing[]): AuditKeyRing {
  const owner = (v: string) => rings.find((r) => r.versions.includes(v));
  return {
    activeVersion: rings.at(-1)!.activeVersion,
    versions: rings.flatMap((r) => r.versions),
    sign: (v, c) => owner(v)!.sign(v, c),
    verify: (v, c, h) => owner(v)?.verify(v, c, h) ?? false,
  };
}

/** Applies privileged fixture SQL with triggers bypassed (test admin only). */
async function tamper(...statements: string[]) {
  await admin.query("BEGIN");
  await admin.query("SET LOCAL session_replication_role = replica");
  for (const statement of statements) await admin.query(statement);
  await admin.query("COMMIT");
}

const docker = (args: string[]) =>
  run(
    "docker",
    ["exec", "-e", `PGPASSWORD=${ctx.adminPassword}`, ctx.containerId, ...args],
    {
      timeout: 120_000,
    },
  );

let partition: string;
let ids: string[];
/** Every key version referenced so far (old versions are retained). */
let retainedKeys: AuditKeyRing = testKeys();

beforeAll(async () => {
  ({ db, admin, restoreEnv } = await prepareAuthorizationDatabase(
    ctx,
    "audit_integrity",
  ));
  const subject = await account("chain");
  for (let i = 0; i < 4; i++) {
    expect(
      await recorder().record({
        code: "auth.sign_in_failed",
        category: "invalid_credentials",
        accountRef: subject,
      }),
    ).toBe(true);
  }
  partition = chainPartitionFor("SECURITY", null, subject);
  ids = (
    await admin.query<{ id: string }>(
      "SELECT id FROM audit.security_event WHERE chain_partition = $1 ORDER BY chain_sequence",
      [partition],
    )
  ).rows.map((r) => r.id);
  await admin.query(
    "CREATE TEMP TABLE saved_rows AS SELECT * FROM audit.security_event WHERE chain_partition = $1",
    [partition],
  );
  await admin.query(
    "CREATE TEMP TABLE saved_head AS SELECT * FROM audit.chain_head WHERE chain_partition = $1",
    [partition],
  );
}, 180_000);

afterAll(async () => {
  await closeDatabasePool();
  await admin?.end();
  for (const name of extraDatabases) await dropOwnedDatabase(ctx, name);
  if (db) await dropOwnedDatabase(ctx, db.name);
  restoreEnv?.();
});

/** Restores the fixture partition exactly (test admin only). */
async function restoreFixture() {
  await tamper(
    `ALTER TABLE audit.security_event DROP CONSTRAINT IF EXISTS security_event_chain_unique`,
    `DELETE FROM audit.security_event WHERE chain_partition = '${partition}' OR chain_partition LIKE 'ORG:%' OR id IN (SELECT id FROM saved_rows)`,
    `INSERT INTO audit.security_event SELECT * FROM saved_rows`,
    `ALTER TABLE audit.security_event ADD CONSTRAINT security_event_chain_unique UNIQUE (chain_partition, chain_sequence)`,
    `DELETE FROM audit.chain_head WHERE chain_partition = '${partition}'`,
    `INSERT INTO audit.chain_head SELECT * FROM saved_head`,
  );
  expect((await verify(db)).ok).toBe(true);
}

describe("tamper-evident verification", () => {
  it("passes for an intact chain and verifies through the read-only script", async () => {
    const report = await verify(db);
    expect(report.ok).toBe(true);
    expect(report.rowsChecked).toBeGreaterThanOrEqual(4);
    const result = await runDbScript("auditVerify", buildHarnessEnv(db));
    assertNoSecrets(ctx, result.output);
    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain("audit:verify passed");
  });

  const cases: [string, () => string[], string, number | null][] = [
    [
      "modified row",
      () => [
        `UPDATE audit.security_event SET risk_code = 'TAMPERED' WHERE id = '${ids[1]}'`,
      ],
      "HMAC_MISMATCH",
      2,
    ],
    [
      "modified metadata",
      () => [
        `UPDATE audit.security_event SET metadata_json = '{"affected_count":1}' WHERE id = '${ids[1]}'`,
      ],
      "HMAC_MISMATCH",
      2,
    ],
    [
      "deleted middle row",
      () => [`DELETE FROM audit.security_event WHERE id = '${ids[1]}'`],
      "SEQUENCE_GAP",
      2,
    ],
    [
      "deleted last row",
      () => [`DELETE FROM audit.security_event WHERE id = '${ids[3]}'`],
      "HEAD_MISMATCH",
      4,
    ],
    [
      "inserted row",
      () => [
        `INSERT INTO audit.security_event SELECT (r).* FROM (SELECT s AS r FROM audit.security_event s WHERE id = '${ids[3]}') x`.replace(
          "SELECT (r).*",
          "SELECT gen_random_uuid(), (r).schema_version, (r).event_name, (r).event_version, (r).outcome, (r).account_id, (r).risk_code, (r).source, (r).correlation_id, (r).request_id, (r).occurred_at, (r).recorded_at, (r).metadata_json, (r).retention_class_code, (r).chain_partition, 5, (r).integrity_hash, (r).integrity_hash, (r).integrity_key_version, (r).canonicalization_version",
        ),
        `UPDATE audit.chain_head SET last_sequence = 5 WHERE chain_partition = '${partition}'`,
      ],
      "HMAC_MISMATCH",
      5,
    ],
    [
      "reordered rows",
      () => [
        `UPDATE audit.security_event SET chain_sequence = 1000 WHERE id = '${ids[0]}'`,
        `UPDATE audit.security_event SET chain_sequence = 1 WHERE id = '${ids[1]}'`,
        `UPDATE audit.security_event SET chain_sequence = 2 WHERE id = '${ids[0]}'`,
      ],
      "PREVIOUS_HASH_MISMATCH",
      1,
    ],
    [
      "duplicated/forked sequence",
      () => [
        `ALTER TABLE audit.security_event DROP CONSTRAINT security_event_chain_unique`,
        `INSERT INTO audit.security_event SELECT gen_random_uuid(), schema_version, event_name, event_version, outcome, account_id, risk_code, source, correlation_id, request_id, occurred_at, recorded_at, metadata_json, retention_class_code, chain_partition, chain_sequence, previous_hash, integrity_hash, integrity_key_version, canonicalization_version FROM audit.security_event WHERE id = '${ids[1]}'`,
      ],
      "DUPLICATE_SEQUENCE",
      2,
    ],
    [
      "chain-head mismatch",
      () => [
        `UPDATE audit.chain_head SET last_sequence = last_sequence + 1 WHERE chain_partition = '${partition}'`,
      ],
      "HEAD_MISMATCH",
      5,
    ],
    [
      "unknown key version",
      () => [
        `UPDATE audit.security_event SET integrity_key_version = 'v9' WHERE id = '${ids[2]}'`,
      ],
      "UNKNOWN_KEY_VERSION",
      3,
    ],
    [
      "row outside any chain head",
      () => [
        `INSERT INTO audit.security_event SELECT gen_random_uuid(), schema_version, event_name, event_version, outcome, account_id, risk_code, source, correlation_id, request_id, occurred_at, recorded_at, metadata_json, retention_class_code, 'ORG:${randomUUID()}', 1, previous_hash, integrity_hash, integrity_key_version, canonicalization_version FROM audit.security_event WHERE id = '${ids[0]}'`,
      ],
      "ORPHAN_PARTITION",
      null,
    ],
  ];

  for (const [label, statements, reason, sequence] of cases) {
    it(`detects ${label}`, async () => {
      await tamper(...statements());
      try {
        const report = await verify(db);
        expect(report.ok).toBe(false);
        expect(report.failure).toMatchObject({
          stream: "SECURITY",
          reason,
          sequence,
        });
        if (reason !== "ORPHAN_PARTITION") {
          expect(report.failure!.partition).toBe(partition);
        }
      } finally {
        await restoreFixture();
      }
    });
  }

  it("fails safely through the script: nonzero exit, no hashes, metadata, or keys, and one alert event", async () => {
    await tamper(
      `UPDATE audit.security_event SET risk_code = 'TAMPERED' WHERE id = '${ids[1]}'`,
    );
    try {
      const before = (
        await admin.query(
          "SELECT count(*)::int AS n FROM audit.security_event WHERE event_name = 'audit.integrity_verification_failed'",
        )
      ).rows[0].n;
      const result = await runDbScript("auditVerify", buildHarnessEnv(db));
      assertNoSecrets(ctx, result.output);
      expect(result.code).toBe(1);
      expect(result.output).toContain("HMAC_MISMATCH");
      expect(result.output).not.toMatch(/[0-9a-f]{64}/);
      expect(result.output).not.toContain("TAMPERED");
      expect(result.output).not.toContain("metadata");
      const after = (
        await admin.query(
          "SELECT count(*)::int AS n FROM audit.security_event WHERE event_name = 'audit.integrity_verification_failed'",
        )
      ).rows[0].n;
      expect(after).toBe(before + 1);
      // The verifier never repaired the tampered row.
      const { rows } = await admin.query(
        "SELECT risk_code FROM audit.security_event WHERE id = $1",
        [ids[1]],
      );
      expect(rows[0].risk_code).toBe("TAMPERED");
    } finally {
      await tamper(
        `DELETE FROM audit.security_event WHERE event_name = 'audit.integrity_verification_failed'`,
        `UPDATE audit.chain_head h SET last_sequence = 0, last_hash = decode(repeat('00', 32), 'hex')
           WHERE NOT EXISTS (SELECT 1 FROM audit.security_event s WHERE s.chain_partition = h.chain_partition)
             AND NOT EXISTS (SELECT 1 FROM audit.audit_event a WHERE a.chain_partition = h.chain_partition)`,
      );
      await restoreFixture();
    }
  });

  it("rejects verification with a wrong key for a stored version", async () => {
    const wrong = parseAuditKeyRing({
      APP_ENV: "test",
      AUDIT_INTEGRITY_KEYS: `t1:${randomBytes(32).toString("base64")}`,
      AUDIT_INTEGRITY_ACTIVE_KEY_VERSION: "t1",
    });
    const report = await verify(db, wrong);
    expect(report.ok).toBe(false);
    expect(report.failure?.reason).toBe("HMAC_MISMATCH");
  });

  it("keeps history verifiable across a key rotation with retained old keys", async () => {
    const env = (active: string) => ({
      APP_ENV: "test",
      AUDIT_INTEGRITY_KEYS: `t2:${k2},t3:${k3}`,
      AUDIT_INTEGRITY_ACTIVE_KEY_VERSION: active,
    });
    const k2 = randomBytes(32).toString("base64");
    const k3 = randomBytes(32).toString("base64");
    const before = parseAuditKeyRing(env("t2"));
    const after = parseAuditKeyRing(env("t3"));
    const subject = await account("rotation");
    await recorder(before).record({
      code: "auth.rate_limited",
      category: "rate_limited",
      accountRef: subject,
    });
    await recorder(after).record({
      code: "auth.rate_limited",
      category: "rate_limited",
      accountRef: subject,
    });
    const { rows } = await admin.query(
      "SELECT integrity_key_version AS v FROM audit.security_event WHERE account_id = $1 ORDER BY chain_sequence",
      [subject],
    );
    expect(rows.map((r) => r.v)).toEqual(["t2", "t3"]);
    retainedKeys = combined(testKeys(), after);
    expect((await verify(db, retainedKeys)).ok).toBe(true);
    // Dropping a still-referenced key version is detected, never ignored.
    const withoutOld = parseAuditKeyRing({
      APP_ENV: "test",
      AUDIT_INTEGRITY_KEYS: `t3:${k3}`,
      AUDIT_INTEGRITY_ACTIVE_KEY_VERSION: "t3",
    });
    const report = await verify(db, combined(testKeys(), withoutOld));
    expect(report.failure?.reason).toBe("UNKNOWN_KEY_VERSION");
  });
});

describe("backup and restore", () => {
  it("restores events, chain heads, sequences, and key references that still verify", async () => {
    const restored = await createOwnedDatabase(ctx, "audit_restored");
    extraDatabases.push(restored.name);
    const file = `/tmp/${restored.name}.dump`;
    await docker([
      "pg_dump",
      "-U",
      ctx.adminUser,
      "-d",
      db.name,
      "-Fc",
      "-f",
      file,
    ]);
    await docker([
      "pg_restore",
      "-U",
      ctx.adminUser,
      "-d",
      restored.name,
      // The chain-head guard (correctly) rejects non-genesis inserts, so a
      // data reload runs as a superuser with triggers disabled for the load
      // only; docs/OPERATIONS.md records this as the approved procedure.
      "--disable-triggers",
      "--exit-on-error",
      file,
    ]);
    await docker(["rm", "-f", file]);

    const original = await verify(db, retainedKeys);
    const report = await verify(restored, retainedKeys);
    expect(report, JSON.stringify(report)).toEqual(original);
    expect(report.ok).toBe(true);

    const restoredAdmin = await adminClient(ctx, restored.name);
    try {
      const count = async (client: Client) =>
        (
          await client.query(
            "SELECT (SELECT count(*) FROM audit.audit_event) + (SELECT count(*) FROM audit.security_event) AS n, (SELECT string_agg(chain_partition || ':' || last_sequence, ',' ORDER BY chain_partition) FROM audit.chain_head) AS heads",
          )
        ).rows[0];
      expect(await count(restoredAdmin)).toEqual(await count(admin));
      const triggers = await restoredAdmin.query(
        "SELECT count(*)::int AS n FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'audit' AND NOT t.tgisinternal AND t.tgenabled = 'O'",
      );
      expect(triggers.rows[0].n).toBe(6);
    } finally {
      await restoredAdmin.end();
    }
    // Database-level ACLs are not part of a dump: the environment's grants
    // are re-applied, then the least-privilege check must pass.
    const regrant = await runDbScript("bootstrap", buildHarnessEnv(restored));
    expect(regrant.code, regrant.output).toBe(0);
    const check = await runDbScript("check", buildHarnessEnv(restored));
    assertNoSecrets(ctx, check.output);
    expect(check.code, check.output).toBe(0);
    // Queries stay authorization-scoped after restore.
    const result = await queryAuditEvents(
      null,
      {
        category: "IDENTITY",
        from: new Date(Date.now() - 86_400_000),
        to: new Date(Date.now() + 60_000),
      },
      {
        db: getDatabase(),
        events: recorder(),
        recordGroups: noRecordGroups,
        authorizer: {
          authorize: async () => ({
            decision: "DENY",
            reasonCode: "UNAUTHENTICATED",
            recorded: false,
          }),
        },
      },
    );
    expect(result).toEqual({ kind: "NOT_PERMITTED" });
  });
});

describe("migration from the accepted M1.5 schema", () => {
  it("applies 0004 over M1.5 with synthetic data, preserving data and adding no audit rows or backfill", async () => {
    const m15 = await createOwnedDatabase(ctx, "audit_m15");
    extraDatabases.push(m15.name);
    const env = buildHarnessEnv(m15);
    const boot = await runDbScript("bootstrap", env);
    expect(boot.code, boot.output).toBe(0);

    // A migrations folder truncated to the accepted M1.5 journal (0000–0003).
    const folder = mkdtempSync(path.join(tmpdir(), "psa-m15-"));
    try {
      const source = path.resolve(import.meta.dirname, "../../../drizzle");
      cpSync(source, folder, { recursive: true });
      const journalPath = path.join(folder, "meta/_journal.json");
      const journal = JSON.parse(readFileSync(journalPath, "utf8"));
      journal.entries = journal.entries.filter(
        (e: { idx: number }) => e.idx <= 3,
      );
      writeFileSync(journalPath, JSON.stringify(journal));
      rmSync(path.join(folder, "0004_audit_foundation.sql"));
      const migrator = await connect(m15.urls.migrator);
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

    const m15Admin = await adminClient(ctx, m15.name);
    try {
      expect(
        (await m15Admin.query("SELECT to_regclass('audit.audit_event') AS t"))
          .rows[0].t,
      ).toBeNull();
      const email = `test.m15.${randomUUID()}@example.test`;
      const { rows } = await m15Admin.query<{ id: string }>(
        `INSERT INTO auth."user" (name, email, email_display, email_verified, account_type, status)
         VALUES ('TEST m15', $1, $2, true, 'CANDIDATE', 'ACTIVE') RETURNING id`,
        [email, email],
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
      const kept = await m15Admin.query(
        'SELECT status FROM auth."user" WHERE id = $1',
        [rows[0]!.id],
      );
      expect(kept.rows[0].status).toBe("ACTIVE");
      // No fabricated history: only the catalog apply that just ran.
      const events = await m15Admin.query(
        "SELECT event_name FROM audit.audit_event UNION ALL SELECT event_name FROM audit.security_event",
      );
      expect(events.rows.map((r) => r.event_name)).toEqual([
        "authz.catalog_applied",
      ]);
      expect((await verify(m15)).ok).toBe(true);
    } finally {
      await m15Admin.end();
    }
  });
});

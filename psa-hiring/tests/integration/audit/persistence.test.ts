import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  inject,
  it,
} from "vitest";
import { drizzle } from "drizzle-orm/node-postgres";
import {
  AuditRecorder,
  AuditWriteError,
  checkAuditReadiness,
  createAuditRecorder,
  parseAuditKeyRing,
  withAuditedTransaction,
} from "@/modules/audit";
import { chainPartitionFor } from "@/modules/audit/domain/integrity-chain";
import { authorize } from "@/modules/identity-access/application/authorize";
import {
  approveRoleAssignment,
  proposeRoleAssignment,
} from "@/modules/identity-access/application/role-assignments";
import { lockAccount } from "@/modules/identity-access/application/restrict-account";
import { closeDatabasePool, getDatabase } from "@/shared/database";
import { createLogger } from "@/shared/logging";
import { sql } from "drizzle-orm";
import { createMemoryDestination } from "../../fixtures/canaries";
import {
  allAuditText,
  auditRowsFor,
  connect,
  countRows,
  failingKeys,
  sqlState,
  testKeys,
  verify,
  waitForLockWait,
} from "../support/audit";
import {
  activateStaff,
  assignmentDeps,
  authzDeps,
  bootstrap,
  createAuthorizationHarness,
  createBootstrapPair,
  prepareAuthorizationDatabase,
  scopes,
  signIn,
  type AuthorizationHarness,
  type BootstrapPair,
} from "../support/authorization";
import { dropOwnedDatabase, type OwnedDatabase } from "../support/harness";

// M1.6 append-only persistence on real PostgreSQL (packet M1.6 §12–§15,
// §24, §26; AC-M1.6-01/04/07/08/09/10/12). Synthetic data only; no key,
// hash, or metadata payload is ever printed.

const ctx = inject("postgres");
let db: OwnedDatabase;
let admin: Client;
let restoreEnv: () => void;
let h: AuthorizationHarness;
let pair: BootstrapPair;
const alerts = createMemoryDestination();
const alertLogger = createLogger({ destination: alerts });

async function staffAccount(label: string): Promise<string> {
  const email = `test.${label}.${randomUUID()}@example.test`;
  const { rows } = await admin.query<{ id: string }>(
    `INSERT INTO auth."user" (name, email, email_display, email_verified, account_type, status)
     VALUES ('TEST staff', $1, $2, true, 'STAFF', 'ACTIVE') RETURNING id`,
    [email, email],
  );
  return rows[0]!.id;
}

const recorder = () =>
  new AuditRecorder({
    db: getDatabase(),
    logger: alertLogger,
    keys: testKeys(),
    source: "LOCAL_TEST",
  });
const failingRecorder = () =>
  new AuditRecorder({
    db: getDatabase(),
    logger: alertLogger,
    keys: failingKeys(),
    source: "LOCAL_TEST",
  });

const metadataValue = async (key: string) =>
  (await admin.query("SELECT 1 FROM app.system_metadata WHERE key = $1", [key]))
    .rowCount;

beforeAll(async () => {
  ({ db, admin, restoreEnv } = await prepareAuthorizationDatabase(
    ctx,
    "audit_store",
  ));
  // Every competitor must reach PostgreSQL: barriers are database locks.
  process.env.DATABASE_POOL_MAX = "8";
  h = createAuthorizationHarness();
  pair = await createBootstrapPair(admin);
}, 180_000);

afterEach(() => {
  h.events.length = 0;
});

afterAll(async () => {
  await closeDatabasePool();
  await admin?.end();
  if (db) await dropOwnedDatabase(ctx, db.name);
  restoreEnv?.();
});

describe("append-only envelope", () => {
  it("appends one exact, chained envelope for a registered event", async () => {
    const account = await staffAccount("envelope");
    expect(
      await recorder().record({
        code: "auth.sign_in_failed",
        category: "invalid_credentials",
        accountRef: account,
      }),
    ).toBe(true);
    const { rows } = await admin.query(
      `SELECT event_name, outcome, risk_code, source, account_id, schema_version,
              canonicalization_version, integrity_key_version, retention_class_code,
              octet_length(integrity_hash) AS mac_bytes, chain_partition, metadata_json
       FROM audit.security_event WHERE account_id = $1`,
      [account],
    );
    expect(rows).toEqual([
      {
        event_name: "auth.sign_in_failed",
        outcome: "FAILED",
        risk_code: "INVALID_CREDENTIALS",
        source: "LOCAL_TEST",
        account_id: account,
        schema_version: 1,
        canonicalization_version: 1,
        integrity_key_version: "t1",
        retention_class_code: "SECURITY_STANDARD_UNSET",
        mac_bytes: 32,
        chain_partition: chainPartitionFor("SECURITY", null, account),
        metadata_json: {},
      },
    ]);
    expect((await verify(db)).ok).toBe(true);
  });

  it("rejects unknown events, facts, and prohibited values with no row and a safe alert", async () => {
    const before =
      (await countRows(admin, "audit_event")) +
      (await countRows(admin, "security_event"));
    const r = recorder();
    expect(await r.record({ code: "auth.unregistered" as never })).toBe(false);
    expect(
      await r.record({
        code: "auth.sign_in_failed",
        category: "denied",
        accountRef: "TESTCANARY@example.test",
      }),
    ).toBe(false);
    expect(
      await r.record({
        code: "auth.sign_in_failed",
        category: "denied",
        note: "TESTCANARY free text",
      } as never),
    ).toBe(false);
    expect(
      (await countRows(admin, "audit_event")) +
        (await countRows(admin, "security_event")),
    ).toBe(before);
    expect(alerts.raw()).toContain("audit.write_failed");
    expect(alerts.raw()).not.toContain("TESTCANARY");
    expect(alerts.raw()).not.toContain("auth.unregistered");
  });
});

describe("runtime privileges and immutability", () => {
  it("denies runtime UPDATE, DELETE, TRUNCATE, INSERT, DDL, integrity reads, and trigger bypass", async () => {
    await recorder().record({
      code: "auth.rate_limited",
      category: "rate_limited",
    });
    const app = await connect(db.urls.app);
    try {
      for (const statement of [
        "UPDATE audit.security_event SET risk_code = NULL",
        "UPDATE audit.audit_event SET reason_code = NULL",
        "DELETE FROM audit.security_event",
        "DELETE FROM audit.audit_event",
        "TRUNCATE audit.audit_event",
        "TRUNCATE audit.security_event",
        "INSERT INTO audit.audit_event (id) VALUES (gen_random_uuid())",
        "SELECT integrity_hash FROM audit.audit_event",
        "SELECT request_id FROM audit.audit_event",
        "SELECT * FROM audit.security_event",
        "SELECT * FROM audit.chain_head",
        "UPDATE audit.chain_head SET last_sequence = 0",
        "ALTER TABLE audit.audit_event DISABLE TRIGGER audit_event_append_only",
        "ALTER TABLE audit.audit_event OWNER TO psa_app",
        "DROP TABLE audit.audit_event",
        "SET session_replication_role = replica",
        "CREATE FUNCTION audit.x() RETURNS int LANGUAGE sql AS 'SELECT 1'",
      ]) {
        const error = await app.query(statement).catch((e: unknown) => e);
        expect(sqlState(error), statement).toBe("42501");
      }
    } finally {
      await app.end();
    }
  });

  it("rejects a forged append that does not extend the locked chain head", async () => {
    const app = await connect(db.urls.app);
    try {
      await app.query("BEGIN");
      const forged = {
        id: randomUUID(),
        schema_version: 1,
        event_name: "auth.rate_limited",
        event_version: 1,
        outcome: "DENIED",
        source: "LOCAL_TEST",
        correlation_id: randomUUID(),
        request_id: randomUUID(),
        occurred_at: new Date().toISOString(),
        metadata_json: {},
        retention_class_code: "SECURITY_STANDARD_UNSET",
        chain_partition: "SECURITY:00",
        chain_sequence: 999_999,
        previous_hash: `\\x${"0".repeat(64)}`,
        integrity_hash: `\\x${"1".repeat(64)}`,
        integrity_key_version: "t1",
        canonicalization_version: 1,
      };
      const error = await app
        .query("SELECT audit.append_security_event($1::jsonb)", [
          JSON.stringify(forged),
        ])
        .catch((e: unknown) => e);
      expect(sqlState(error)).toBe("AU001");
      await app.query("ROLLBACK");
      const partitionError = await app
        .query("SELECT * FROM audit.claim_chain_head($1)", ["CLIENT:ab"])
        .catch((e: unknown) => e);
      expect(sqlState(partitionError)).toBe("22023");
    } finally {
      await app.end();
    }
  });

  it("rejects UPDATE, DELETE, TRUNCATE, and head rewinds even for the owner", async () => {
    await recorder().record({
      code: "auth.rate_limited",
      category: "rate_limited",
    });
    const owner = await connect(db.urls.migrator);
    try {
      for (const [statement, state] of [
        ["UPDATE audit.security_event SET risk_code = risk_code", "AU002"],
        ["DELETE FROM audit.security_event", "AU002"],
        ["TRUNCATE audit.security_event", "AU002"],
        ["TRUNCATE audit.chain_head", "AU002"],
        ["DELETE FROM audit.chain_head", "AU002"],
        [
          "UPDATE audit.chain_head SET last_sequence = last_sequence + 5",
          "AU003",
        ],
        ["UPDATE audit.chain_head SET last_sequence = 0", "AU003"],
      ] as const) {
        const error = await owner.query(statement).catch((e: unknown) => e);
        expect(sqlState(error), statement).toBe(state);
      }
    } finally {
      await owner.end();
    }
  });

  it("never lets an account deletion cascade into audit history", async () => {
    const account = await staffAccount("cascade");
    await recorder().record({
      code: "auth.sign_in_failed",
      category: "denied",
      accountRef: account,
    });
    const error = await admin
      .query('DELETE FROM auth."user" WHERE id = $1', [account])
      .catch((e: unknown) => e);
    // ON DELETE RESTRICT: restrict_violation, never a cascade.
    expect(sqlState(error)).toBe("23001");
    expect(
      await countRows(admin, "security_event", "account_id = $1", [account]),
    ).toBe(1);
  });
});

describe("atomic audited transactions", () => {
  const facts = (account: string) => ({
    code: "account.sessions_revoked_by_system" as const,
    accountRef: account,
    systemActor: "SYSTEM_PROCESS" as const,
    count: 0,
  });

  it("commits the mutation and its audit event together", async () => {
    const account = await staffAccount("atomic-ok");
    const key = `test.atomic.${randomUUID()}`;
    await withAuditedTransaction(
      { db: getDatabase(), events: recorder() },
      async (tx, audit) => {
        await tx.execute(
          sql`INSERT INTO app.system_metadata (key, value) VALUES (${key}, '{}')`,
        );
        await audit.append(facts(account));
      },
    );
    expect(await metadataValue(key)).toBe(1);
    expect((await auditRowsFor(admin, account)).length).toBe(1);
  });

  it("rolls the audit event back when the mutation fails", async () => {
    const account = await staffAccount("atomic-mutation");
    const key = `test.atomic.${randomUUID()}`;
    await expect(
      withAuditedTransaction(
        { db: getDatabase(), events: recorder() },
        async (tx, audit) => {
          await audit.append(facts(account));
          await tx.execute(
            sql`INSERT INTO app.system_metadata (key, value) VALUES (${key}, '{}')`,
          );
          throw new Error("TEST forced mutation failure");
        },
      ),
    ).rejects.toThrow("TEST forced mutation failure");
    expect(await metadataValue(key)).toBe(0);
    expect((await auditRowsFor(admin, account)).length).toBe(0);
  });

  it("rolls the mutation back when audit validation, integrity, or append fails", async () => {
    const account = await staffAccount("atomic-audit");
    for (const [events, appendFacts] of [
      [
        recorder(),
        { code: "account.sessions_revoked_by_system", accountRef: account },
      ],
      [failingRecorder(), facts(account)],
    ] as const) {
      const key = `test.atomic.${randomUUID()}`;
      await expect(
        withAuditedTransaction(
          { db: getDatabase(), events },
          async (tx, audit) => {
            await tx.execute(
              sql`INSERT INTO app.system_metadata (key, value) VALUES (${key}, '{}')`,
            );
            await audit.append(appendFacts as never);
            return "SUCCESS";
          },
        ),
      ).rejects.toBeInstanceOf(AuditWriteError);
      expect(await metadataValue(key)).toBe(0);
    }
    expect((await auditRowsFor(admin, account)).length).toBe(0);
  });

  it("reports neither change nor audit when the commit itself fails", async () => {
    const account = await staffAccount("atomic-commit");
    await admin.query(`
      CREATE OR REPLACE FUNCTION app.test_fail_commit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.key LIKE 'test.commit_fail.%' THEN
          RAISE EXCEPTION 'TEST forced commit failure' USING ERRCODE = 'P0001';
        END IF;
        RETURN NEW;
      END $$`);
    await admin.query(`
      CREATE CONSTRAINT TRIGGER test_fail_commit AFTER INSERT ON app.system_metadata
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.test_fail_commit()`);
    try {
      const key = `test.commit_fail.${randomUUID()}`;
      let returned = false;
      await expect(
        withAuditedTransaction(
          { db: getDatabase(), events: recorder() },
          async (tx, audit) => {
            await tx.execute(
              sql`INSERT INTO app.system_metadata (key, value) VALUES (${key}, '{}')`,
            );
            await audit.append(facts(account));
            return "SUCCESS";
          },
        ).then(() => (returned = true)),
      ).rejects.toBeDefined();
      expect(returned).toBe(false);
      expect(await metadataValue(key)).toBe(0);
      expect((await auditRowsFor(admin, account)).length).toBe(0);
    } finally {
      await admin.query("DROP TRIGGER test_fail_commit ON app.system_metadata");
      await admin.query("DROP FUNCTION app.test_fail_commit()");
    }
  });

  it("keeps a real account restriction from committing without its audit event", async () => {
    const account = await staffAccount("restrict");
    await expect(
      lockAccount(account, undefined, {
        db: getDatabase(),
        logger: alertLogger,
        events: failingRecorder(),
      }),
    ).rejects.toBeInstanceOf(AuditWriteError);
    const { rows } = await admin.query(
      'SELECT status, version FROM auth."user" WHERE id = $1',
      [account],
    );
    expect(rows[0]).toMatchObject({ status: "ACTIVE", version: 1 });

    await lockAccount(account, undefined, {
      db: getDatabase(),
      logger: alertLogger,
      events: recorder(),
    });
    const events = await auditRowsFor(admin, account);
    expect(
      events.map((e) => [e.event_name, e.actor_type, e.reason_code]),
    ).toEqual([["account.restricted", "SYSTEM", "SECURITY_LOCK"]]);
    expect(events[0]).toMatchObject({
      previous_record_version: "1",
      new_record_version: "2",
    });
  });
});

describe("denials, idempotency, and distinct attempts", () => {
  it("records a high-risk denial once and keeps it denied when the append fails", async () => {
    const staff = await activateStaff(h, "audit-deny");
    const session = await signIn(h, staff);
    const request = {
      principal: {
        accountId: session.principal.accountId,
        accountType: "STAFF" as const,
        sessionId: session.principal.sessionId,
      },
      permission: "screening.result.read_restricted",
      operation: "READ" as const,
      resource: {
        kind: "RECORD" as const,
        id: scopes.RECORD,
        sensitivity: "RESTRICTED_SCREENING_MEDICAL" as const,
      },
      correlationId: randomUUID(),
    };
    const decision = await authorize(request, authzDeps(h));
    expect(decision.decision).toBe("DENY");
    const denials = (await auditRowsFor(admin, staff.accountId)).filter(
      (e) => e.event_name === "authz.high_risk_denied",
    );
    expect(denials).toHaveLength(1);
    expect(denials[0]).toMatchObject({
      outcome: "DENIED",
      actor_type: "USER",
      permission_code: "screening.result.read_restricted",
      correlation_id: request.correlationId,
      target_id: null,
    });
    expect(JSON.stringify(denials)).not.toContain(scopes.RECORD);

    const failing = await authorize(request, {
      ...authzDeps(h),
      events: failingRecorder(),
    });
    expect(failing.decision).toBe("DENY");
    expect(
      (await auditRowsFor(admin, staff.accountId)).filter(
        (e) => e.event_name === "authz.high_risk_denied",
      ),
    ).toHaveLength(1);
    expect(alerts.raw()).toContain("audit.write_failed");
  });

  it("records one success event for one accepted command and refuses the retry", async () => {
    const subject = await staffAccount("idem");
    const proposed = await proposeRoleAssignment(
      {
        subjectAccountId: subject,
        roleCode: "RECRUITER",
        scopeType: "BRANCH",
        scopeReferenceId: scopes.BRANCH,
        effectiveFrom: new Date(Date.now() - 60_000),
        effectiveTo: null,
        reasonCode: "NEW_ACCESS",
      },
      bootstrap(pair.creator),
      assignmentDeps(h),
    );
    if (proposed.kind !== "PROPOSED") throw new Error(proposed.kind);
    const approve = () =>
      approveRoleAssignment(
        { assignmentId: proposed.assignmentId, expectedVersion: 1 },
        bootstrap(pair.approver),
        assignmentDeps(h),
      );
    expect((await approve()).kind).toBe("APPROVED");
    expect(await approve()).toMatchObject({ kind: "REFUSED" });
    expect(
      await countRows(
        admin,
        "audit_event",
        "event_name = 'authz.assignment_approved' AND target_id = $1",
        [proposed.assignmentId],
      ),
    ).toBe(1);
    const names = (await auditRowsFor(admin, subject)).map((e) => e.event_name);
    expect(
      names.filter((n) => n === "authz.subject_version_changed"),
    ).toHaveLength(1);
    const approved = (
      await admin.query(
        "SELECT actor_type, idempotency_key, previous_record_version, new_record_version, metadata_json FROM audit.audit_event WHERE event_name = 'authz.assignment_approved' AND target_id = $1",
        [proposed.assignmentId],
      )
    ).rows[0];
    expect(approved).toMatchObject({
      actor_type: "SYSTEM",
      idempotency_key: `${proposed.assignmentId}:2`,
      previous_record_version: "1",
      new_record_version: "2",
      metadata_json: {
        assigned_role_code: "RECRUITER",
        assigned_scope_type: "BRANCH",
      },
    });
  });

  it("deduplicates a replayed idempotent event without a second row", async () => {
    const account = await staffAccount("replay");
    const replay = {
      code: "authz.subject_version_changed" as const,
      accountRef: account,
      systemActor: "TEST_HARNESS" as const,
      newVersion: 41,
      previousVersion: 40,
    };
    for (let i = 0; i < 3; i++) {
      await withAuditedTransaction(
        { db: getDatabase(), events: recorder() },
        (_tx, audit) => audit.append(replay),
      );
    }
    expect(
      await countRows(
        admin,
        "audit_event",
        "event_name = 'authz.subject_version_changed' AND target_id = $1",
        [account],
      ),
    ).toBe(1);
    expect((await verify(db)).ok).toBe(true);
  });

  it("keeps distinct failed attempts as distinct bounded security events", async () => {
    const account = await staffAccount("attempts");
    for (let i = 0; i < 3; i++) {
      await recorder().record({
        code: "auth.sign_in_failed",
        category: "invalid_credentials",
        accountRef: account,
      });
    }
    expect(
      await countRows(admin, "security_event", "account_id = $1", [account]),
    ).toBe(3);
  });
});

describe("chain concurrency", () => {
  it("serializes same-partition appends into a contiguous chain without forks", async () => {
    const account = await staffAccount("race");
    const partition = chainPartitionFor("SECURITY", null, account);
    const holder = await connect(db.urls.app);
    try {
      // Barrier: hold the partition head so the competitor provably waits.
      await holder.query("BEGIN");
      await holder.query("SELECT * FROM audit.claim_chain_head($1)", [
        partition,
      ]);
      const competitor = recorder().record({
        code: "auth.sign_in_failed",
        category: "denied",
        accountRef: account,
      });
      await waitForLockWait(admin);
      await holder.query("ROLLBACK");
      expect(await competitor).toBe(true);
    } finally {
      await holder.end();
    }
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        recorder().record({
          code: "auth.sign_in_failed",
          category: "denied",
          accountRef: account,
        }),
      ),
    );
    expect(results.every(Boolean)).toBe(true);
    const { rows } = await admin.query<{ s: string }>(
      "SELECT chain_sequence AS s FROM audit.security_event WHERE chain_partition = $1 ORDER BY chain_sequence",
      [partition],
    );
    const sequences = rows.map((r) => Number(r.s));
    expect(sequences).toEqual(
      Array.from({ length: sequences.length }, (_, i) => i + 1),
    );
    expect((await verify(db)).ok).toBe(true);
  });

  it("lets independent partitions append while one head is locked", async () => {
    const first = await staffAccount("partition-a");
    let second = await staffAccount("partition-b");
    while (
      chainPartitionFor("SECURITY", null, second) ===
      chainPartitionFor("SECURITY", null, first)
    ) {
      second = await staffAccount("partition-b");
    }
    const holder = await connect(db.urls.app);
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT * FROM audit.claim_chain_head($1)", [
        chainPartitionFor("SECURITY", null, first),
      ]);
      expect(
        await recorder().record({
          code: "auth.sign_in_failed",
          category: "denied",
          accountRef: second,
        }),
      ).toBe(true);
      // A same-partition standalone append gives up within its lock timeout
      // instead of waiting forever, and reports the failure safely.
      expect(
        await recorder().record({
          code: "auth.sign_in_failed",
          category: "denied",
          accountRef: first,
        }),
      ).toBe(false);
      await holder.query("ROLLBACK");
    } finally {
      await holder.end();
    }
  });
});

describe("current M1 integration", () => {
  it("records staff invitation, activation, MFA, sign-in, and role changes once each with safe context", async () => {
    const staff = await activateStaff(h, "audit-flow");
    await signIn(h, staff);
    const names = (await auditRowsFor(admin, staff.accountId)).map(
      (e) => e.event_name,
    );
    for (const name of [
      "staff.activation_started",
      "staff.mfa_enrolled",
      "staff.activation_completed",
      "auth.sign_in_succeeded",
    ]) {
      expect(
        names.filter((n) => n === name),
        name,
      ).toHaveLength(1);
    }
    const { rows: invitation } = await admin.query(
      `SELECT e.event_name, e.actor_type FROM audit.audit_event e
       JOIN auth.staff_invitation i ON i.id = e.target_id
       WHERE i.account_id = $1 ORDER BY e.occurred_at`,
      [staff.accountId],
    );
    expect(invitation.map((r) => r.event_name)).toEqual(
      expect.arrayContaining([
        "staff.invitation_issued",
        "staff.invitation_accepted",
      ]),
    );
    const text = await allAuditText(admin);
    for (const canary of [
      staff.email,
      staff.secret,
      "TEST-agent",
      "198.51.100.",
    ]) {
      expect(text.includes(canary)).toBe(false);
    }
    expect((await verify(db)).ok).toBe(true);
  });

  it("appends the authorization catalog event atomically with the catalog apply", async () => {
    expect(
      await countRows(
        admin,
        "audit_event",
        "event_name = 'authz.catalog_applied'",
      ),
    ).toBe(1);
    const { rows } = await admin.query(
      "SELECT actor_type, source, target_type, category FROM audit.audit_event WHERE event_name = 'authz.catalog_applied'",
    );
    expect(rows[0]).toEqual({
      actor_type: "SYSTEM",
      source: "SYSTEM",
      target_type: "AUTHORIZATION_CATALOG",
      category: "CONFIGURATION",
    });
  });

  it("builds the default runtime recorder from the validated key ring", () => {
    expect(createAuditRecorder()).toBeInstanceOf(AuditRecorder);
  });
});

describe("production-like startup readiness", () => {
  it("passes for the least-privileged runtime and refuses excess grants, disabled triggers, or unsafe keys", async () => {
    const app = await connect(db.urls.app);
    try {
      const check = () => checkAuditReadiness(drizzle({ client: app }));
      expect(await check()).toEqual([]);

      await admin.query("GRANT UPDATE ON audit.audit_event TO psa_app");
      try {
        expect(await check()).toEqual(["RUNTIME_HAS_WRITE_PRIVILEGE"]);
      } finally {
        await admin.query("REVOKE UPDATE ON audit.audit_event FROM psa_app");
      }

      await admin.query(
        "ALTER TABLE audit.audit_event DISABLE TRIGGER audit_event_append_only",
      );
      try {
        expect(await check()).toEqual(["APPEND_ONLY_TRIGGER_MISSING"]);
      } finally {
        await admin.query(
          "ALTER TABLE audit.audit_event ENABLE TRIGGER audit_event_append_only",
        );
      }
      expect(await check()).toEqual([]);
    } finally {
      await app.end();
    }
    // The same startup gate parses the key ring first: production-like
    // configuration without real keys refuses to start.
    expect(() => parseAuditKeyRing({ APP_ENV: "production" })).toThrow(
      "AUDIT_INTEGRITY_KEYS is required",
    );
  });
});

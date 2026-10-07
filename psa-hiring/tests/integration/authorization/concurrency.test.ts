import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { authorizeInTransaction } from "@/modules/identity-access/application/authorize";
import {
  approveRoleAssignment,
  proposeRoleAssignment,
  revokeRoleAssignment,
} from "@/modules/identity-access/application/role-assignments";
import type { AuthorizationRequest } from "@/modules/identity-access/domain/authorization-decision";
import { closeDatabasePool } from "@/shared/database";
import {
  activateStaff,
  assignmentDeps,
  authzDeps,
  bootstrap,
  createAuthorizationHarness,
  createBootstrapPair,
  grant,
  prepareAuthorizationDatabase,
  scopes,
  signIn,
  type AuthorizationHarness,
  type BootstrapPair,
} from "../support/authorization";
import { dropOwnedDatabase, type OwnedDatabase } from "../support/harness";

// Deterministic concurrency (packet M1.4 §15.3, §24.17–18, AC-M1.4-11).
// Barriers are explicit: a competitor is started only after the first
// transaction holds its lock, and the test polls pg_locks until the
// competitor is provably waiting, so outcomes never depend on timing.

const ctx = inject("postgres");
let db: OwnedDatabase;
let admin: Client;
let restoreEnv: () => void;
let h: AuthorizationHarness;
let pair: BootstrapPair;

async function waitForLockWait(minimum = 1): Promise<void> {
  for (let i = 0; i < 400; i += 1) {
    // pg_stat_activity is snapshotted per transaction; refresh each poll.
    await admin.query("SELECT pg_stat_clear_snapshot()");
    const { rows } = await admin.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()",
    );
    if (rows[0]!.n >= minimum) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  const { rows } = await admin.query(
    "SELECT state, wait_event_type, wait_event, left(query, 60) AS q FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid()",
  );
  throw new Error(`competitor never blocked: ${JSON.stringify(rows)}`);
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

async function staffAccount(label: string): Promise<string> {
  const email = `test.${label}.${Date.now()}.${Math.random().toString(36).slice(2)}@example.test`;
  const { rows } = await admin.query<{ id: string }>(
    `INSERT INTO auth."user" (name, email, email_display, email_verified, account_type, status)
     VALUES ('TEST staff', $1, $2, true, 'STAFF', 'ACTIVE') RETURNING id`,
    [email, email],
  );
  return rows[0]!.id;
}

const activeCount = async (subject: string) =>
  (
    await admin.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM auth.user_role_assignment WHERE user_account_id = $1 AND status = 'ACTIVE'",
      [subject],
    )
  ).rows[0]!.n;

beforeAll(async () => {
  ({ db, admin, restoreEnv } = await prepareAuthorizationDatabase(
    ctx,
    "authz_race",
  ));
  // Enough runtime connections that every competitor reaches PostgreSQL
  // (the barrier must be a database lock, never a pool queue).
  process.env.DATABASE_POOL_MAX = "6";
  h = createAuthorizationHarness();
  pair = await createBootstrapPair(admin);
});

afterAll(async () => {
  await closeDatabasePool();
  await admin?.end();
  if (db) await dropOwnedDatabase(ctx, db.name);
  restoreEnv?.();
});

describe("assignment and authorization races", () => {
  it("lets exactly one of two concurrent approvals activate an assignment", async () => {
    const subject = await staffAccount("dup-approve");
    const proposed = await proposeRoleAssignment(
      {
        subjectAccountId: subject,
        roleCode: "RECRUITER",
        scopeType: "BRANCH",
        scopeReferenceId: scopes.BRANCH,
        effectiveFrom: new Date(Date.now() - 1000),
        effectiveTo: null,
        reasonCode: "NEW_ACCESS",
      },
      bootstrap(pair.creator),
      assignmentDeps(h),
    );
    if (proposed.kind !== "PROPOSED") throw new Error("unreachable");
    // Barrier: hold the assignment row so both approvals queue behind it.
    await admin.query("BEGIN");
    await admin.query(
      "SELECT id FROM auth.user_role_assignment WHERE id = $1 FOR UPDATE",
      [proposed.assignmentId],
    );
    const approve = () =>
      approveRoleAssignment(
        { assignmentId: proposed.assignmentId, expectedVersion: 1 },
        bootstrap(pair.approver),
        assignmentDeps(h),
      );
    const racing = Promise.all([approve(), approve()]);
    try {
      await waitForLockWait(2);
    } finally {
      await admin.query("COMMIT");
    }
    const results = await racing;
    expect(results.map((r) => r.kind).sort()).toEqual(["APPROVED", "REFUSED"]);
    expect(results.find((r) => r.kind === "REFUSED")).toMatchObject({
      reason: expect.stringMatching(/^(INVALID_STATE|STALE_VERSION)$/),
    });
    expect(await activeCount(subject)).toBe(1);
  });

  it("lets at most one of two concurrent equivalent proposals exist", async () => {
    const subject = await staffAccount("dup-propose");
    await admin.query("BEGIN");
    await admin.query('SELECT id FROM auth."user" WHERE id = $1 FOR UPDATE', [
      subject,
    ]);
    const propose = () =>
      proposeRoleAssignment(
        {
          subjectAccountId: subject,
          roleCode: "HR_SPECIALIST",
          scopeType: "TEAM",
          scopeReferenceId: scopes.TEAM,
          effectiveFrom: new Date(Date.now() - 1000),
          effectiveTo: null,
          reasonCode: "NEW_ACCESS",
        },
        bootstrap(pair.creator),
        assignmentDeps(h),
      );
    const racing = Promise.all([propose(), propose()]);
    try {
      await waitForLockWait(2);
    } finally {
      await admin.query("COMMIT");
    }
    const results = await racing;
    expect(results.map((r) => r.kind).sort()).toEqual(["PROPOSED", "REFUSED"]);
    expect(results.find((r) => r.kind === "REFUSED")).toEqual({
      kind: "REFUSED",
      reason: "OVERLAPPING_ASSIGNMENT",
    });
    const { rows } = await admin.query(
      "SELECT count(*)::int AS n FROM auth.user_role_assignment WHERE user_account_id = $1",
      [subject],
    );
    expect(rows[0].n).toBe(1);
  });

  it("serializes revocation behind a protected command that authorized first", async () => {
    const staff = await activateStaff(h, "race-first");
    const id = await grant(
      h,
      pair,
      staff.accountId,
      "RECRUITER",
      "ORGANIZATION",
      scopes.ORG,
    );
    const session = await signIn(h, staff);
    const request: AuthorizationRequest = {
      principal: session.principal,
      permission: "candidate.read.assigned",
      operation: "READ",
      resource: {
        kind: "RECORD",
        id: scopes.RECORD,
        sensitivity: "CONFIDENTIAL_PERSONNEL",
      },
    };
    const authorized = deferred();
    const release = deferred();
    const order: string[] = [];
    const command = h.runtime.db.transaction(async (tx) => {
      const decision = await authorizeInTransaction(tx, request, authzDeps(h));
      authorized.resolve();
      await release.promise;
      order.push(`command-${decision.decision}`);
      return decision;
    });
    await authorized.promise;
    const revocation = revokeRoleAssignment(
      { assignmentId: id, expectedVersion: 2, reasonCode: "SECURITY_INCIDENT" },
      bootstrap(pair.approver),
      assignmentDeps(h),
    ).then((r) => {
      order.push(`revoke-${r.kind}`);
      return r;
    });
    // The revocation must wait for the command's subject-row share lock.
    try {
      await waitForLockWait(1);
    } finally {
      release.resolve();
    }
    expect((await command).decision).toBe("ALLOW");
    expect(await revocation).toMatchObject({ kind: "REVOKED" });
    // The command committed with authority valid at its boundary, before
    // the revocation; the next decision denies.
    expect(order).toEqual(["command-ALLOW", "revoke-REVOKED"]);
    const after = await h.runtime.db.transaction((tx) =>
      authorizeInTransaction(tx, request, authzDeps(h)),
    );
    expect(after.decision).toBe("DENY");
  });

  it("never commits on authority revoked before the protected boundary", async () => {
    const staff = await activateStaff(h, "race-second");
    const id = await grant(
      h,
      pair,
      staff.accountId,
      "RECRUITER",
      "ORGANIZATION",
      scopes.ORG,
    );
    const session = await signIn(h, staff);
    const request: AuthorizationRequest = {
      principal: session.principal,
      permission: "candidate.read.assigned",
      operation: "READ",
      resource: {
        kind: "RECORD",
        id: scopes.RECORD,
        sensitivity: "CONFIDENTIAL_PERSONNEL",
      },
    };
    // An in-flight revocation transaction holds the subject row (as the
    // revoke command does) and has already revoked, but not committed.
    await admin.query("BEGIN");
    await admin.query('SELECT id FROM auth."user" WHERE id = $1 FOR UPDATE', [
      staff.accountId,
    ]);
    await admin.query(
      `UPDATE auth.user_role_assignment SET status = 'REVOKED', revoked_at = now(), revoked_by_user_id = $2,
         revocation_reason_code = 'SECURITY_INCIDENT', version = version + 1 WHERE id = $1`,
      [id, pair.approver],
    );
    const command = h.runtime.db.transaction((tx) =>
      authorizeInTransaction(tx, request, authzDeps(h)),
    );
    try {
      await waitForLockWait(1);
    } finally {
      await admin.query("COMMIT");
    }
    expect(await command).toMatchObject({
      decision: "DENY",
      reasonCode: "ASSIGNMENT_INACTIVE",
    });
  });
});

import { randomUUID } from "node:crypto";
import { and, asc, gt, sql } from "drizzle-orm";
import { pgSchema, text, timestamp, uuid } from "drizzle-orm/pg-core";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import {
  authorize,
  authorizeQueryScope,
} from "@/modules/identity-access/application/authorize";
import { projectAuthorized } from "@/modules/identity-access/application/authorize-fields";
import {
  authorizeScopedList,
  type ListQuery,
  type ListQuerySpec,
  type ScopedListSource,
} from "@/modules/identity-access/application/authorize-query";
import { authorizeAccountSelfServiceInTransaction } from "@/modules/identity-access/application/authorize-self-service";
import { changeCandidatePassword } from "@/modules/identity-access/application/change-candidate-password";
import { resolveCurrentAccount } from "@/modules/identity-access/application/current-account";
import {
  queryCandidateSecurity,
  revokeCandidateSession,
  revokeOtherCandidateSessions,
  signOutCandidateEverywhere,
} from "@/modules/identity-access/application/manage-candidate-sessions";
import {
  changeStaffPassword,
  queryStaffSecurity,
  regenerateStaffBackupCodes,
  revokeOtherStaffSessions,
  revokeStaffSession,
  signOutStaffEverywhere,
} from "@/modules/identity-access/application/manage-staff-security";
import { navigationHint } from "@/modules/identity-access/application/navigation-guard";
import {
  authorizeDocumentAccess,
  type DocumentEnvelope,
} from "@/modules/identity-access/application/ports/authorized-document-access";
import {
  queryStaffReauthentication,
  reauthenticateStaff,
} from "@/modules/identity-access/application/reauthenticate-staff";
import { signInCandidate } from "@/modules/identity-access/application/sign-in-candidate";
import type { QueryConstraint } from "@/modules/identity-access/application/authorize";
import { handleAuthRequest } from "@/modules/identity-access/infrastructure/auth-http";
import { constraintPredicate } from "@/modules/identity-access/infrastructure/scope-predicates";
import { defineProjection } from "@/modules/identity-access/presentation/authorized-projector";
import { closeDatabasePool, getDatabase } from "@/shared/database";
import { z } from "zod";
import { createTestAccount, TEST_PASSWORD } from "../../fixtures/auth/accounts";
import { CookieJar } from "../../fixtures/auth/cookie-jar";
import { totpCode } from "../../fixtures/auth/totp";
import { findCanaryCategories } from "../../fixtures/canaries";
import {
  activateStaff,
  authzDeps,
  createAuthorizationHarness,
  createBootstrapPair,
  grant,
  headers,
  prepareAuthorizationDatabase,
  scopes,
  signIn,
  STAFF_PASSWORD,
  stepUp,
  syntheticId,
  type AuthorizationHarness,
  type BootstrapPair,
  type StaffMember,
} from "../support/authorization";
import { dropOwnedDatabase, type OwnedDatabase } from "../support/harness";

// M1.5 route, object, and field authorization against real PostgreSQL
// (packet M1.5 §25, §27; AC-M1.5-02..12, 14, 15). Real commands, real
// Better Auth sessions, real MFA, real assignments through the M1.4
// harness, and a disposable synthetic table (created in this test's own
// database only, never a migration) for the scoped-query SQL proof.

const ctx = inject("postgres");
let db: OwnedDatabase;
let admin: Client;
let restoreEnv: () => void;
let h: AuthorizationHarness;
let pair: BootstrapPair;

const synthetic = pgSchema("m15_synthetic");
const syntheticRecord = synthetic.table("record", {
  id: uuid("id").primaryKey(),
  organizationId: uuid("organization_id").notNull(),
  branchId: uuid("branch_id"),
  teamId: uuid("team_id"),
  assignmentSetId: uuid("assignment_set_id"),
  subjectAccountId: uuid("subject_account_id"),
  displayName: text("display_name").notNull(),
  // A restricted column the list source must never select.
  restrictedValue: text("restricted_value").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
});

async function candidateSession(label: string) {
  const account = await createTestAccount(h.runtime.auth, {
    accountType: "CANDIDATE",
    emailVerified: true,
  });
  const result = await signInCandidate(
    { email: account.email, password: TEST_PASSWORD, next: undefined },
    headers(),
    h.runtime,
  );
  if (result.kind !== "SIGNED_IN") throw new Error(`${label}: ${result.kind}`);
  const jar = new CookieJar().apply(result.setCookies);
  return { account, jar };
}

async function sessionRows(accountId: string) {
  const { rows } = await admin.query<{
    id: string;
    expires_at: Date;
    updated_at: Date;
  }>(
    "SELECT id, expires_at, updated_at FROM auth.session WHERE user_id = $1 ORDER BY created_at",
    [accountId],
  );
  return rows;
}

beforeAll(async () => {
  ({ db, admin, restoreEnv } = await prepareAuthorizationDatabase(ctx, "m15"));
  h = createAuthorizationHarness();
  pair = await createBootstrapPair(admin);
  // Disposable synthetic resources for the scoped-query proof.
  await admin.query(`CREATE SCHEMA m15_synthetic`);
  await admin.query(`CREATE TABLE m15_synthetic.record (
    id uuid PRIMARY KEY, organization_id uuid NOT NULL, branch_id uuid, team_id uuid,
    assignment_set_id uuid, subject_account_id uuid, display_name text NOT NULL,
    restricted_value text NOT NULL, created_at timestamptz NOT NULL)`);
  await admin.query(`GRANT USAGE ON SCHEMA m15_synthetic TO psa_app`);
  await admin.query(`GRANT SELECT ON m15_synthetic.record TO psa_app`);
});

afterAll(async () => {
  await h?.runtime.email.idle();
  await closeDatabasePool();
  await admin?.end();
  if (db) await dropOwnedDatabase(ctx, db.name);
  restoreEnv?.();
});

describe("account self-service authorization (current M1 surfaces)", () => {
  it("serves each audience its own exact projection and nothing else", async () => {
    const candidate = await candidateSession("own");
    const result = await queryCandidateSecurity(
      headers(candidate.jar),
      h.runtime,
    );
    expect(result.kind).toBe("OK");
    if (result.kind !== "OK") return;
    expect(Object.keys(result.view).sort()).toEqual([
      "emailVerified",
      "maskedEmail",
      "sessions",
    ]);
    const text = JSON.stringify(result);
    const [session] = await sessionRows(candidate.account.id);
    for (const hidden of [
      candidate.account.email,
      candidate.account.id,
      session.id,
    ]) {
      expect(text).not.toContain(hidden);
    }

    const staff = await activateStaff(h, "own-staff");
    const staffSession = await signIn(h, staff);
    const view = await queryStaffSecurity(headers(staffSession.jar), h.runtime);
    expect(view.kind === "OK" && Object.keys(view.view).sort()).toEqual([
      "maskedEmail",
      "mfaMethod",
      "recentAuthentication",
      "sessions",
      "signedInWith",
    ]);
  });

  it("keeps candidates out of every staff query and command (hidden, no state change)", async () => {
    const candidate = await candidateSession("cross");
    const before = await sessionRows(candidate.account.id);
    const hdr = headers(candidate.jar);
    expect(await queryStaffSecurity(hdr, h.runtime)).toEqual({
      kind: "NOT_PERMITTED",
    });
    expect(await queryStaffReauthentication(hdr, h.runtime)).toEqual({
      kind: "NOT_PERMITTED",
    });
    expect(await revokeOtherStaffSessions(hdr, h.runtime)).toEqual({
      kind: "NOT_PERMITTED",
    });
    expect(await revokeStaffSession(hdr, "A".repeat(32), h.runtime)).toEqual({
      kind: "NOT_PERMITTED",
    });
    expect(await signOutStaffEverywhere(hdr, h.runtime)).toEqual({
      kind: "NOT_PERMITTED",
    });
    expect(
      await changeStaffPassword(
        {
          currentPassword: TEST_PASSWORD,
          password: "TEST other passphrase 0009",
          passwordConfirmation: "TEST other passphrase 0009",
        },
        hdr,
        h.runtime,
      ),
    ).toEqual({ kind: "NOT_PERMITTED" });
    expect(
      await regenerateStaffBackupCodes(
        { password: TEST_PASSWORD, code: "000000" },
        hdr,
        h.runtime,
      ),
    ).toEqual({ kind: "NOT_PERMITTED" });
    expect(
      await reauthenticateStaff(
        { password: TEST_PASSWORD, code: "000000", purpose: "STAFF_SECURITY" },
        hdr,
        h.runtime,
      ),
    ).toEqual({ kind: "NOT_PERMITTED" });
    expect(await navigationHint(hdr, "STAFF", h.runtime)).toBe("HIDDEN");
    expect(await sessionRows(candidate.account.id)).toEqual(before);
  });

  it("keeps staff out of every candidate query and command (hidden, no state change)", async () => {
    const staff = await activateStaff(h, "staff-cross");
    const session = await signIn(h, staff);
    const before = await sessionRows(staff.accountId);
    const hdr = headers(session.jar);
    expect(await queryCandidateSecurity(hdr, h.runtime)).toEqual({
      kind: "NOT_PERMITTED",
    });
    expect(await revokeOtherCandidateSessions(hdr, h.runtime)).toEqual({
      kind: "NOT_PERMITTED",
    });
    expect(
      await revokeCandidateSession(hdr, "A".repeat(32), h.runtime),
    ).toEqual({ kind: "NOT_PERMITTED" });
    expect(await signOutCandidateEverywhere(hdr, h.runtime)).toEqual({
      kind: "NOT_PERMITTED",
    });
    expect(
      await changeCandidatePassword(
        {
          currentPassword: STAFF_PASSWORD,
          password: "TEST other passphrase 0009",
          passwordConfirmation: "TEST other passphrase 0009",
        },
        hdr,
        h.runtime,
      ),
    ).toEqual({ kind: "NOT_PERMITTED" });
    expect(await navigationHint(hdr, "CANDIDATE", h.runtime)).toBe("HIDDEN");
    expect(await sessionRows(staff.accountId)).toEqual(before);
  });

  it("rejects anonymous, restricted, and stale principals on the next call", async () => {
    expect(await queryCandidateSecurity(headers(), h.runtime)).toEqual({
      kind: "UNAUTHENTICATED",
    });
    expect(await navigationHint(headers(), "CANDIDATE", h.runtime)).toBe(
      "SIGN_IN",
    );
    for (const status of ["LOCKED", "DISABLED", "CLOSED", "INVITED"] as const) {
      const candidate = await candidateSession(`restricted-${status}`);
      expect(
        (await queryCandidateSecurity(headers(candidate.jar), h.runtime)).kind,
      ).toBe("OK");
      // The cookie and session row remain; the account state alone changes.
      const reason = {
        LOCKED: "SECURITY_LOCK",
        DISABLED: "ADMINISTRATIVE_DISABLE",
        CLOSED: "ACCOUNT_CLOSED",
        INVITED: null,
      }[status];
      await admin.query(
        `UPDATE auth."user" SET status = $2, disabled_at = CASE WHEN $3::text IS NULL THEN NULL ELSE now() END, disabled_reason_code = $3 WHERE id = $1`,
        [candidate.account.id, status, reason],
      );
      expect(
        await queryCandidateSecurity(headers(candidate.jar), h.runtime),
        status,
      ).toEqual({
        kind: "UNAUTHENTICATED",
      });
      expect(
        await revokeOtherCandidateSessions(headers(candidate.jar), h.runtime),
      ).toEqual({
        kind: "UNAUTHENTICATED",
      });
    }
  });

  it("denies a staff session immediately after a role change, despite the old cookie", async () => {
    const staff = await activateStaff(h, "role-change");
    const session = await signIn(h, staff);
    expect(
      (await queryStaffSecurity(headers(session.jar), h.runtime)).kind,
    ).toBe("OK");
    await grant(h, pair, staff.accountId, "RECRUITER", "BRANCH", scopes.BRANCH);
    expect(await queryStaffSecurity(headers(session.jar), h.runtime)).toEqual({
      kind: "UNAUTHENTICATED",
    });
    expect(await navigationHint(headers(session.jar), "STAFF", h.runtime)).toBe(
      "SIGN_IN",
    );
  });

  it("re-runs the whole decision after reauthentication (no cached allow)", async () => {
    const staff = await activateStaff(h, "reauth-then-change");
    const session = await signIn(h, staff);
    const reauth = await reauthenticateStaff(
      {
        password: STAFF_PASSWORD,
        code: await totpCode(staff.secret, -1),
        purpose: "CHANGE_PASSWORD",
      },
      headers(session.jar),
      h.runtime,
    );
    expect(reauth).toEqual({
      kind: "REAUTHENTICATED",
      destination: "/staff/security#password",
    });
    // A security change after the step-up (e.g. MFA reset, role change).
    await admin.query(
      'UPDATE auth."user" SET version = version + 1 WHERE id = $1',
      [staff.accountId],
    );
    expect(
      await changeStaffPassword(
        {
          currentPassword: STAFF_PASSWORD,
          password: "TEST staff new passphrase 0003",
          passwordConfirmation: "TEST staff new passphrase 0003",
        },
        headers(session.jar),
        h.runtime,
      ),
    ).toEqual({ kind: "UNAUTHENTICATED" });
  });

  it("rechecks at the command transaction boundary", async () => {
    const candidate = await candidateSession("tx");
    const principal = await resolveCurrentAccount(
      headers(candidate.jar),
      h.runtime,
    );
    const outcome = await getDatabase().transaction(async (tx) => {
      const before = await authorizeAccountSelfServiceInTransaction(
        tx,
        principal,
        "CANDIDATE_SESSIONS_REVOKE_OTHERS",
        h.runtime,
      );
      // A restriction applied inside the same boundary is seen at once.
      await tx.execute(
        sql`UPDATE auth."user" SET status = 'LOCKED', disabled_at = now(), disabled_reason_code = 'SECURITY_LOCK' WHERE id = ${candidate.account.id}`,
      );
      const after = await authorizeAccountSelfServiceInTransaction(
        tx,
        principal,
        "CANDIDATE_SESSIONS_REVOKE_OTHERS",
        h.runtime,
      );
      return { before: before.decision, after: after.reasonCode };
    });
    expect(outcome).toEqual({ before: "ALLOW", after: "ACCOUNT_INACTIVE" });
  });
});

describe("object authorization on current resources (opaque session references)", () => {
  it("Candidate A cannot revoke or detect Candidate B's sessions", async () => {
    const a = await candidateSession("owner-a");
    const second = await signInCandidate(
      { email: a.account.email, password: TEST_PASSWORD, next: undefined },
      headers(),
      h.runtime,
    );
    expect(second.kind).toBe("SIGNED_IN");
    const view = await queryCandidateSecurity(headers(a.jar), h.runtime);
    const otherRef =
      view.kind === "OK" ? view.view.sessions.find((s) => !s.current)!.ref : "";
    const b = await candidateSession("owner-b");
    const before = await sessionRows(a.account.id);
    const foreign = await revokeCandidateSession(
      headers(b.jar),
      otherRef,
      h.runtime,
    );
    const unknown = await revokeCandidateSession(
      headers(b.jar),
      "B".repeat(32),
      h.runtime,
    );
    const malformed = await revokeCandidateSession(
      headers(b.jar),
      "../../x",
      h.runtime,
    );
    expect(foreign).toEqual({ kind: "NOT_FOUND" });
    expect(unknown).toEqual(foreign);
    expect(malformed).toEqual(foreign);
    expect(await sessionRows(a.account.id)).toEqual(before);
    // Staff with the same reference: hidden, not "not found".
    const staff = await activateStaff(h, "ref-staff");
    const staffSession = await signIn(h, staff);
    expect(
      await revokeStaffSession(headers(staffSession.jar), otherRef, h.runtime),
    ).toEqual({
      kind: "NOT_FOUND",
    });
    expect(await sessionRows(a.account.id)).toEqual(before);
  });
});

describe("Better Auth HTTP surface", () => {
  it("closes get-session: no auth-library objects, no state change on GET, protected headers", async () => {
    const candidate = await candidateSession("http");
    const before = await sessionRows(candidate.account.id);
    const response = await handleAuthRequest(
      new Request("http://127.0.0.1:3100/api/auth/get-session", {
        headers: {
          cookie: candidate.jar.header()!,
          origin: "http://127.0.0.1:3100",
        },
      }),
      randomUUID(),
    );
    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe(
      "private, no-store, max-age=0",
    );
    const body = await response.text();
    expect(body).not.toMatch(/"(user|session|email|token|id)"/);
    expect(body).not.toContain(candidate.account.email);
    expect(await sessionRows(candidate.account.id)).toEqual(before);
  });

  it("refuses generic user/session mutation endpoints for every method", async () => {
    const candidate = await candidateSession("http-mutate");
    for (const path of [
      "/update-user",
      "/update-session",
      "/revoke-sessions",
      "/change-email",
      "/list-sessions",
    ]) {
      const response = await handleAuthRequest(
        new Request(`http://127.0.0.1:3100/api/auth${path}`, {
          method: "POST",
          headers: {
            cookie: candidate.jar.header()!,
            "content-type": "application/json",
            origin: "http://127.0.0.1:3100",
          },
          body: JSON.stringify({
            accountType: "STAFF",
            status: "ACTIVE",
            role: "SYSTEM_ADMINISTRATOR",
          }),
        }),
        randomUUID(),
      );
      expect(response.status, path).toBe(404);
    }
    const { rows } = await admin.query(
      'SELECT account_type, status FROM auth."user" WHERE id = $1',
      [candidate.account.id],
    );
    expect(rows[0]).toEqual({ account_type: "CANDIDATE", status: "ACTIVE" });
  });
});

describe("scoped list contract applies scope in SQL before materialization", () => {
  const spec: ListQuerySpec = {
    maxPageSize: 25,
    defaultPageSize: 10,
    sorts: ["created_asc"],
    defaultSort: "created_asc",
    filters: {},
    maxSearchLength: 40,
  };
  const ownFile = syntheticId(34);
  let staff: StaffMember;
  let session: Awaited<ReturnType<typeof signIn>>;
  const executed: string[] = [];

  const source: ScopedListSource<{
    id: string;
    sensitivity: "CONFIDENTIAL_PERSONNEL";
    displayName: string;
  }> = {
    async list(constraint: QueryConstraint, query: ListQuery) {
      const where = constraintPredicate(constraint, {
        organizationId: syntheticRecord.organizationId,
        branchId: syntheticRecord.branchId,
        teamId: syntheticRecord.teamId,
        assignmentSetId: syntheticRecord.assignmentSetId,
        subjectAccountId: syntheticRecord.subjectAccountId,
      });
      const statement = getDatabase()
        // Only list-safe columns are ever selected.
        .select({
          id: syntheticRecord.id,
          displayName: syntheticRecord.displayName,
          createdAt: syntheticRecord.createdAt,
        })
        .from(syntheticRecord)
        .where(
          query.cursor
            ? and(
                where,
                gt(syntheticRecord.createdAt, new Date(Number(query.cursor))),
              )
            : where,
        )
        .orderBy(asc(syntheticRecord.createdAt))
        .limit(query.pageSize + 1);
      executed.push(statement.toSQL().sql);
      const rows = await statement;
      const page = rows.slice(0, query.pageSize);
      return {
        rows: page.map((r) => ({
          id: r.id,
          sensitivity: "CONFIDENTIAL_PERSONNEL" as const,
          displayName: r.displayName,
        })),
        nextCursor:
          rows.length > query.pageSize
            ? String(page.at(-1)!.createdAt.getTime())
            : null,
      };
    },
  };

  beforeAll(async () => {
    h.resolver.addRecord(ownFile, {
      organizationId: scopes.ORG,
      branchId: scopes.BRANCH,
      teamId: scopes.TEAM,
    });
    const rows = [
      [scopes.RECORD_ORG2, scopes.ORG2, null, null, "TEST other org"],
      [
        scopes.RECORD_BRANCH2,
        scopes.ORG,
        scopes.BRANCH2,
        null,
        "TEST other branch",
      ],
      [scopes.RECORD, scopes.ORG, scopes.BRANCH, scopes.TEAM, "TEST in scope"],
      [ownFile, scopes.ORG, scopes.BRANCH, scopes.TEAM, "TEST own file"],
    ];
    staff = await activateStaff(h, "list");
    for (const [i, [rid, org, branch, team, name]] of rows.entries()) {
      await admin.query(
        `INSERT INTO m15_synthetic.record VALUES ($1,$2,$3,$4,NULL,$5,$6,'TESTCANARY-restricted',$7)`,
        [
          rid,
          org,
          branch,
          team,
          rid === ownFile ? staff.accountId : null,
          name,
          new Date(Date.UTC(2026, 0, 1 + i)),
        ],
      );
    }
    await grant(h, pair, staff.accountId, "RECRUITER", "BRANCH", scopes.BRANCH);
    // One MFA sign-in for this block (TOTP codes are single-use).
    session = await signIn(h, staff);
  });

  it("returns only in-scope rows, excludes the actor's own file, and never selects restricted columns", async () => {
    const result = await authorizeScopedList(
      {
        principal: session.principal,
        permission: "candidate.read.assigned",
        sensitivity: "CONFIDENTIAL_PERSONNEL",
        input: { pageSize: 1 },
      },
      source,
      spec,
      authzDeps(h),
    );
    // Page size 1: the first row is the in-scope one, because out-of-scope
    // rows (created earlier) never reach ORDER BY/LIMIT.
    expect(result).toEqual({
      kind: "LISTED",
      rows: [
        {
          id: scopes.RECORD,
          sensitivity: "CONFIDENTIAL_PERSONNEL",
          displayName: "TEST in scope",
        },
      ],
      nextCursor: null,
      refused: 0,
    });
    const sql = executed.at(-1)!;
    expect(sql).toMatch(
      /where .*"organization_id" = \$\d.*"branch_id" = \$\d.*order by .*limit/i,
    );
    expect(sql).not.toContain("restricted_value");
    expect(JSON.stringify(result)).not.toContain("TESTCANARY");
  });

  it("drops and counts an out-of-scope row a defective repository returns (M1.7 §22)", async () => {
    // A repository that ignores the constraint must not widen the list:
    // every row is rechecked against the subject's authority.
    const leaky: typeof source = {
      async list(constraint, query) {
        const page = await source.list(constraint, query);
        return {
          ...page,
          rows: [
            ...page.rows,
            {
              id: scopes.RECORD_ORG2,
              sensitivity: "CONFIDENTIAL_PERSONNEL" as const,
              displayName: "TEST other org",
            },
          ],
        };
      },
    };
    const deps = authzDeps(h);
    const warned: string[] = [];
    const logger = Object.create(deps.logger) as typeof deps.logger;
    logger.warn = (event, context) => {
      warned.push(event);
      deps.logger.warn(event, context);
    };
    const result = await authorizeScopedList(
      {
        principal: session.principal,
        permission: "candidate.read.assigned",
        sensitivity: "CONFIDENTIAL_PERSONNEL",
        input: {},
      },
      leaky,
      spec,
      { ...deps, logger },
    );
    expect(result).toMatchObject({ kind: "LISTED", refused: 1 });
    if (result.kind !== "LISTED") return;
    expect(result.rows.map((r) => r.id)).toEqual([scopes.RECORD]);
    expect(warned).toEqual(["authz.list_rows_refused"]);
  });

  it("rejects client-widened scope, unknown filters, and selector expansion", async () => {
    const base = {
      principal: session.principal,
      permission: "candidate.read.assigned",
      sensitivity: "CONFIDENTIAL_PERSONNEL",
    } as const;
    expect(
      await authorizeScopedList(
        { ...base, input: { scope: "ORGANIZATION" } },
        source,
        spec,
        authzDeps(h),
      ),
    ).toEqual({ kind: "INVALID_INPUT", reason: "UNKNOWN_KEY" });
    expect(
      await authorizeScopedList(
        { ...base, input: { select: ["restrictedValue"] } },
        source,
        spec,
        authzDeps(h),
      ),
    ).toEqual({ kind: "INVALID_INPUT", reason: "UNKNOWN_KEY" });
    const before = executed.length;
    expect(
      await authorizeScopedList(
        {
          ...base,
          input: {},
          selection: { type: "ORGANIZATION", id: scopes.ORG },
        },
        source,
        spec,
        authzDeps(h),
      ),
    ).toEqual({ kind: "DENIED", decision: null });
    // Nothing was queried for a denied or invalid request.
    expect(executed.length).toBe(before);
  });

  it("gives the administrator and an unassigned staff member no list at all", async () => {
    const adminStaff = await activateStaff(h, "list-admin");
    await grant(
      h,
      pair,
      adminStaff.accountId,
      "SYSTEM_ADMINISTRATOR",
      "ORGANIZATION",
      scopes.ORG,
    );
    const plain = await activateStaff(h, "list-plain");
    for (const member of [adminStaff, plain]) {
      const session = await signIn(h, member);
      const before = executed.length;
      const result = await authorizeScopedList(
        {
          principal: session.principal,
          permission: "candidate.read.assigned",
          sensitivity: "CONFIDENTIAL_PERSONNEL",
          input: {},
        },
        source,
        spec,
        authzDeps(h),
      );
      expect(result.kind).toBe("DENIED");
      expect(executed.length).toBe(before);
    }
  });

  it("denies the list on the next call after revocation (stale session)", async () => {
    const member = await activateStaff(h, "list-revoked");
    await grant(
      h,
      pair,
      member.accountId,
      "RECRUITER",
      "BRANCH",
      scopes.BRANCH,
    );
    const session = await signIn(h, member);
    const scope = await authorizeQueryScope(
      {
        principal: session.principal,
        permission: "candidate.read.assigned",
        operation: "READ",
        sensitivity: "CONFIDENTIAL_PERSONNEL",
      },
      authzDeps(h),
    );
    expect(scope.decision).toBe("ALLOW");
    await admin.query(
      `UPDATE auth."user" SET status = 'DISABLED', disabled_at = now(), disabled_reason_code = 'ADMINISTRATIVE_DISABLE' WHERE id = $1`,
      [member.accountId],
    );
    expect(
      (
        await authorizeQueryScope(
          {
            principal: session.principal,
            permission: "candidate.read.assigned",
            operation: "READ",
            sensitivity: "CONFIDENTIAL_PERSONNEL",
          },
          authzDeps(h),
        )
      ).decision,
    ).toBe("DENY");
  });
});

describe("field and document authorization with real decisions", () => {
  const contract = defineProjection<
    { displayName: string; screeningResult: string; screeningStatus: string },
    { displayName: string; screening?: string }
  >({
    name: "test.review.v1",
    audience: "STAFF",
    purpose: "REVIEW",
    fields: {
      displayName: {
        rule: { sensitivity: "CONFIDENTIAL_PERSONNEL", otherwise: "INCLUDE" },
        value: (s) => s.displayName,
      },
      screening: {
        rule: {
          sensitivity: "RESTRICTED_SCREENING_MEDICAL",
          includeWith: "screening.result.read_restricted",
          statusWith: "screening.status.read",
          otherwise: "OMIT",
        },
        value: (s) => s.screeningResult,
        status: (s) => s.screeningStatus,
      },
    },
    schema: z.strictObject({
      displayName: z.string(),
      screening: z.string().optional(),
    }),
  });
  const source = {
    displayName: "TEST Person",
    screeningResult: "TESTCANARY-report",
    screeningStatus: "CLEAR",
  };

  it("filters restricted fields per role, scope, and step-up", async () => {
    const recruiter = await activateStaff(h, "field-recruiter");
    await grant(
      h,
      pair,
      recruiter.accountId,
      "RECRUITER",
      "BRANCH",
      scopes.BRANCH,
    );
    const rs = await signIn(h, recruiter);
    const decide = (r: Parameters<typeof authorize>[0]) =>
      authorize(r, authzDeps(h));
    const request = (principal: typeof rs.principal) => ({
      principal,
      audience: "STAFF" as const,
      resource: {
        id: scopes.RECORD,
        sensitivity: "CONFIDENTIAL_PERSONNEL" as const,
      },
      purposeCode: "COMPLIANCE_REVIEW",
    });
    expect(
      await projectAuthorized(contract, source, request(rs.principal), decide),
    ).toEqual({
      kind: "PROJECTED",
      value: { displayName: "TEST Person", screening: "CLEAR" },
    });

    const reviewer = await activateStaff(h, "field-reviewer");
    await grant(
      h,
      pair,
      reviewer.accountId,
      "COMPLIANCE_REVIEWER",
      "BRANCH",
      scopes.BRANCH,
    );
    const vs = await signIn(h, reviewer);
    expect(
      await projectAuthorized(contract, source, request(vs.principal), decide),
    ).toEqual({
      kind: "PROJECTED",
      value: { displayName: "TEST Person" },
    });
    await stepUp(h, reviewer, vs, "RESTRICTED_DATA_ACCESS");
    expect(
      await projectAuthorized(contract, source, request(vs.principal), decide),
    ).toEqual({
      kind: "PROJECTED",
      value: { displayName: "TEST Person", screening: "TESTCANARY-report" },
    });
  });

  it("gates a synthetic restricted document by category, action, scope, scan state, and step-up", async () => {
    const reviewer = await activateStaff(h, "doc-reviewer");
    await grant(
      h,
      pair,
      reviewer.accountId,
      "COMPLIANCE_REVIEWER",
      "BRANCH",
      scopes.BRANCH,
    );
    const session = await signIn(h, reviewer);
    const envelope: DocumentEnvelope = {
      id: syntheticId(600),
      category: "TEST_MEDICAL",
      parentRecordId: scopes.RECORD,
      sensitivity: "RESTRICTED_SCREENING_MEDICAL",
      audience: "RESTRICTED_REVIEW",
      scanState: "CLEAN",
      hidden: false,
    };
    const deps = {
      source: {
        loadDocumentEnvelope: async (id: string) =>
          id === envelope.id ? envelope : null,
      },
      registry: {
        TEST_MEDICAL: {
          PREVIEW: {
            permission: "medical_document.read_restricted",
            operation: "READ" as const,
          },
          DOWNLOAD: {
            permission: "medical_document.download",
            operation: "DOWNLOAD" as const,
          },
        },
      },
      authorize: (r: Parameters<typeof authorize>[0]) =>
        authorize(r, authzDeps(h)),
      events: h.runtime.events,
      clock: () => new Date(),
    };
    const access = (action: "PREVIEW" | "DOWNLOAD" | "EXPORT") =>
      authorizeDocumentAccess(
        {
          principal: session.principal,
          documentId: envelope.id,
          action,
          purposeCode: "COMPLIANCE_REVIEW",
        },
        deps,
      );
    expect(await access("DOWNLOAD")).toEqual({
      kind: "REAUTHENTICATION_REQUIRED",
    });
    await stepUp(h, reviewer, session, "RESTRICTED_DATA_ACCESS");
    expect((await access("DOWNLOAD")).kind).toBe("AUTHORIZED");
    expect(await access("EXPORT")).toEqual({ kind: "NOT_FOUND" });
  });
});

describe("events and privacy", () => {
  it("records one bounded denial per refused high-risk self-service command, with no values", async () => {
    const candidate = await candidateSession("event");
    const staffHeaders = headers(candidate.jar);
    staffHeaders.set(
      "x-correlation-id",
      "0b9a7a3e-6a55-4c8e-9a3b-2f1d0c4e5a6b",
    );
    const before = h.events.length;
    expect(await navigationHint(staffHeaders, "STAFF", h.runtime)).toBe(
      "HIDDEN",
    );
    expect(await revokeOtherStaffSessions(staffHeaders, h.runtime)).toEqual({
      kind: "NOT_PERMITTED",
    });
    const emitted = h.events
      .slice(before)
      .filter((e) => e.code === "authz.self_service_denied");
    // The guard emitted nothing; the command emitted exactly one.
    expect(emitted).toEqual([
      {
        code: "authz.self_service_denied",
        category: "denied",
        accountRef: candidate.account.id,
        permissionCode: "self_service.staff_sessions_revoke_others",
        reasonCode: "PERMISSION_MISSING",
        policyVersion: "self-p1",
        correlationId: "0b9a7a3e-6a55-4c8e-9a3b-2f1d0c4e5a6b",
      },
    ]);
  });

  it("propagates safe allow context on successful security changes", async () => {
    const candidate = await candidateSession("allow-event");
    const before = h.events.length;
    expect(
      (await revokeOtherCandidateSessions(headers(candidate.jar), h.runtime))
        .kind,
    ).toBe("REVOKED");
    expect(h.events.slice(before)).toContainEqual(
      expect.objectContaining({
        code: "auth.sessions_revoked",
        accountRef: candidate.account.id,
        permissionCode: "self_service.candidate_sessions_revoke_others",
        policyVersion: "self-p1",
      }),
    );
  });

  it("writes no emails, secrets, session data, or policy facts to logs", async () => {
    await h.runtime.email.idle();
    const raw = h.logs.raw();
    expect(findCanaryCategories(raw)).toEqual([]);
    expect(raw).not.toMatch(/@example\.test/);
    expect(raw).not.toMatch(/psa\.session_token|TESTCANARY|restricted_value/);
    expect(raw).not.toMatch(
      /"(?:condition|scopeReferenceId|effectiveAssignmentId)"/,
    );
  });
});

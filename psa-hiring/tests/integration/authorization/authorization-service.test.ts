import type { Client } from "pg";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  inject,
  it,
  vi,
} from "vitest";
import {
  authorize,
  authorizeInTransaction,
} from "@/modules/identity-access/application/authorize";
import { resolveCurrentAccount } from "@/modules/identity-access/application/current-account";
import { resolveCurrentStaff } from "@/modules/identity-access/application/reauthenticate-staff";
import { lockAccount } from "@/modules/identity-access/application/restrict-account";
import { revokeRoleAssignment } from "@/modules/identity-access/application/role-assignments";
import { signInCandidate } from "@/modules/identity-access/application/sign-in-candidate";
import type { AuthorizationRequest } from "@/modules/identity-access/domain/authorization-decision";
import { AUTHORIZATION_POLICY_VERSION } from "@/modules/identity-access/policy/authorization-catalog";
import type { WorkflowPolicy } from "@/modules/identity-access/policy/workflow-policies";
import { closeDatabasePool } from "@/shared/database";
import { createTestAccount, TEST_PASSWORD } from "../../fixtures/auth/accounts";
import { CookieJar } from "../../fixtures/auth/cookie-jar";
import { findCanaryCategories } from "../../fixtures/canaries";
import {
  activateStaff,
  assignmentDeps,
  authzDeps,
  bootstrap,
  createAuthorizationHarness,
  createBootstrapPair,
  grant,
  headers,
  prepareAuthorizationDatabase,
  scopes,
  signIn,
  stepUp,
  syntheticId,
  type AuthorizationHarness,
  type BootstrapPair,
} from "../support/authorization";
import { dropOwnedDatabase, type OwnedDatabase } from "../support/harness";

// Central authorization against real PostgreSQL, real M1.3 staff sessions,
// and current-state loading (packet M1.4 §11, §14, §15, §22, §24;
// AC-M1.4-05, -07, -09, -10, -14).

const ctx = inject("postgres");
let db: OwnedDatabase;
let admin: Client;
let restoreEnv: () => void;
let h: AuthorizationHarness;
let pair: BootstrapPair;

const readinessPolicy: WorkflowPolicy = {
  code: "CANDIDACY_WORKFLOW",
  states: ["FINAL_COMPLIANCE_REVIEW", "WITHDRAWN"],
  permits: (_code, state) => state === "FINAL_COMPLIANCE_REVIEW",
};

const readRecord = (
  principal: AuthorizationRequest["principal"],
  record: string = scopes.RECORD,
): AuthorizationRequest => ({
  principal,
  permission: "candidate.read.assigned",
  operation: "READ",
  resource: {
    kind: "RECORD",
    id: record,
    sensitivity: "CONFIDENTIAL_PERSONNEL",
  },
});

beforeAll(async () => {
  ({ db, admin, restoreEnv } = await prepareAuthorizationDatabase(
    ctx,
    "authz_service",
  ));
  h = createAuthorizationHarness({
    workflow: new Map([["CANDIDACY_WORKFLOW", readinessPolicy]]),
  });
  pair = await createBootstrapPair(admin);
});

afterEach(() => {
  vi.useRealTimers();
});

afterAll(async () => {
  await closeDatabasePool();
  await admin?.end();
  if (db) await dropOwnedDatabase(ctx, db.name);
  restoreEnv?.();
});

describe("authorization service on current server-owned state", () => {
  it("allows only within scope, using the effective assignment", async () => {
    const recruiter = await activateStaff(h, "recruiter");
    const id = await grant(
      h,
      pair,
      recruiter.accountId,
      "RECRUITER",
      "BRANCH",
      scopes.BRANCH,
    );
    const session = await signIn(h, recruiter);
    expect(
      await authorize(readRecord(session.principal), authzDeps(h)),
    ).toEqual({
      decision: "ALLOW",
      permissionCode: "candidate.read.assigned",
      effectiveRoleCode: "RECRUITER",
      effectiveAssignmentId: id,
      effectiveScopeType: "BRANCH",
      effectiveScopeReferenceId: scopes.BRANCH,
      policyVersion: AUTHORIZATION_POLICY_VERSION,
      reasonCode: "ALLOWED",
    });
    for (const [record, reason] of [
      [scopes.RECORD_BRANCH2, "SCOPE_MISMATCH"],
      [scopes.RECORD_ORG2, "SCOPE_MISMATCH"],
      [syntheticId(999), "SCOPE_MISMATCH"],
    ] as const) {
      expect(
        (await authorize(readRecord(session.principal, record), authzDeps(h)))
          .reasonCode,
      ).toBe(reason);
    }
    // Wrong permission for the role, and restricted data, deny.
    expect(
      (
        await authorize(
          {
            ...readRecord(session.principal),
            permission: "screening.result.read_restricted",
            reasonCode: "REVIEW",
            resource: {
              kind: "RECORD",
              id: scopes.RECORD,
              sensitivity: "RESTRICTED_SCREENING_MEDICAL",
            },
          },
          authzDeps(h),
        )
      ).reasonCode,
    ).toBe("PERMISSION_MISSING");
    expect(
      (
        await authorize(
          {
            ...readRecord(session.principal),
            resource: {
              kind: "RECORD",
              id: scopes.RECORD,
              sensitivity: "RESTRICTED_IDENTITY_FINANCIAL",
            },
          },
          authzDeps(h),
        )
      ).reasonCode,
    ).toBe("SENSITIVITY_DENIED");
  });

  it("ignores request-supplied roles, scopes, and claims", async () => {
    const staff = await activateStaff(h, "claims");
    const session = await signIn(h, staff);
    for (const forged of [
      { roles: ["PSA_MANAGER"] },
      { scope: { type: "ORGANIZATION", id: scopes.ORG } },
      { isAdmin: true },
      { decision: "ALLOW" },
    ]) {
      expect(
        await authorize(
          {
            ...readRecord(session.principal),
            ...forged,
          } as AuthorizationRequest,
          authzDeps(h),
        ),
      ).toMatchObject({ decision: "DENY", reasonCode: "INVALID_CONTEXT" });
    }
    // A staff member with no assignment has no authority at all.
    expect(
      (await authorize(readRecord(session.principal), authzDeps(h))).reasonCode,
    ).toBe("PERMISSION_MISSING");
    // A forged principal for another account is not resolved to a session.
    expect(
      (
        await authorize(
          readRecord({ ...session.principal, accountId: pair.approver }),
          authzDeps(h),
        )
      ).reasonCode,
    ).toBe("UNAUTHENTICATED");
  });

  it("stops granting on the next decision after revocation, despite a stale browser session", async () => {
    const staff = await activateStaff(h, "revoked");
    const id = await grant(
      h,
      pair,
      staff.accountId,
      "HR_SPECIALIST",
      "ORGANIZATION",
      scopes.ORG,
    );
    const session = await signIn(h, staff);
    expect(
      (await authorize(readRecord(session.principal), authzDeps(h))).decision,
    ).toBe("ALLOW");
    expect(
      await revokeRoleAssignment(
        {
          assignmentId: id,
          expectedVersion: 2,
          reasonCode: "SECURITY_INCIDENT",
        },
        bootstrap(pair.approver),
        assignmentDeps(h),
      ),
    ).toMatchObject({ kind: "REVOKED" });
    // The browser still holds its cookie and the old principal object.
    expect(
      await authorize(readRecord(session.principal), authzDeps(h)),
    ).toMatchObject({
      decision: "DENY",
      reasonCode: "UNAUTHENTICATED",
    });
    expect(
      await resolveCurrentStaff(headers(session.jar), h.runtime),
    ).toBeNull();
    // A fresh session no longer holds the revoked privilege either.
    const fresh = await signIn(h, staff);
    expect(
      (await authorize(readRecord(fresh.principal), authzDeps(h))).reasonCode,
    ).toBe("ASSIGNMENT_INACTIVE");
  });

  it("expires exactly at the exclusive effective_to boundary on the server clock", async () => {
    const start = Date.now();
    vi.useFakeTimers({ toFake: ["Date"], now: start });
    const staff = await activateStaff(h, "expiring");
    const end = new Date(start + 10 * 60_000);
    await grant(h, pair, staff.accountId, "RECRUITER", "TEAM", scopes.TEAM, {
      effectiveFrom: new Date(start - 60_000),
      effectiveTo: end,
    });
    const session = await signIn(h, staff);
    vi.setSystemTime(end.getTime() - 1);
    expect(
      (await authorize(readRecord(session.principal), authzDeps(h))).decision,
    ).toBe("ALLOW");
    vi.setSystemTime(end.getTime());
    expect(
      (await authorize(readRecord(session.principal), authzDeps(h))).reasonCode,
    ).toBe("ASSIGNMENT_INACTIVE");
  });

  it("denies immediately when the account is restricted", async () => {
    const staff = await activateStaff(h, "locked");
    await grant(
      h,
      pair,
      staff.accountId,
      "RECRUITER",
      "ORGANIZATION",
      scopes.ORG,
    );
    const session = await signIn(h, staff);
    expect(
      (await authorize(readRecord(session.principal), authzDeps(h))).decision,
    ).toBe("ALLOW");
    await lockAccount(staff.accountId, undefined, {
      db: h.runtime.db,
      logger: h.runtime.logger,
    });
    expect(
      (await authorize(readRecord(session.principal), authzDeps(h))).reasonCode,
    ).toBe("ACCOUNT_INACTIVE");
  });

  it("requires purpose-bound strong recent authentication for high-risk approvals", async () => {
    const reviewer = await activateStaff(h, "compliance");
    await grant(
      h,
      pair,
      reviewer.accountId,
      "COMPLIANCE_REVIEWER",
      "BRANCH",
      scopes.BRANCH,
    );
    const session = await signIn(h, reviewer);
    const approve: AuthorizationRequest = {
      principal: session.principal,
      permission: "readiness.final_approval",
      operation: "APPROVE",
      reasonCode: "ALL_REQUIREMENTS_MET",
      resource: {
        kind: "RECORD",
        id: scopes.RECORD,
        sensitivity: "CONFIDENTIAL_PERSONNEL",
      },
      workflow: {
        policy: "CANDIDACY_WORKFLOW",
        state: "FINAL_COMPLIANCE_REVIEW",
      },
      separation: { priorApproverAccountIds: [pair.approver] },
    };
    expect(await authorize(approve, authzDeps(h))).toMatchObject({
      reasonCode: "RECENT_AUTH_REQUIRED",
      challenge: "REAUTHENTICATION_REQUIRED",
    });
    expect(
      h.events.filter((e) => e.code === "authz.high_risk_denied").at(-1),
    ).toMatchObject({
      permissionCode: "readiness.final_approval",
      reasonCode: "RECENT_AUTH_REQUIRED",
    });
    // Step-up for a different purpose does not count.
    await stepUp(h, reviewer, session, "RESTRICTED_DATA_ACCESS");
    expect((await authorize(approve, authzDeps(h))).reasonCode).toBe(
      "RECENT_AUTH_REQUIRED",
    );

    const second = await activateStaff(h, "compliance2");
    await grant(
      h,
      pair,
      second.accountId,
      "COMPLIANCE_REVIEWER",
      "BRANCH",
      scopes.BRANCH,
    );
    const s2 = await signIn(h, second);
    await stepUp(h, second, s2, "HIGH_RISK_APPROVAL");
    const ok = { ...approve, principal: s2.principal };
    expect((await authorize(ok, authzDeps(h))).decision).toBe("ALLOW");
    // Same actor as a prior approver, missing facts, or disallowed state deny.
    expect(
      (
        await authorize(
          {
            ...ok,
            separation: { priorApproverAccountIds: [second.accountId] },
          },
          authzDeps(h),
        )
      ).reasonCode,
    ).toBe("SEPARATION_CONFLICT");
    expect(
      (await authorize({ ...ok, separation: undefined }, authzDeps(h)))
        .reasonCode,
    ).toBe("SEPARATION_FACTS_MISSING");
    expect(
      (
        await authorize(
          {
            ...ok,
            workflow: { policy: "CANDIDACY_WORKFLOW", state: "WITHDRAWN" },
          },
          authzDeps(h),
        )
      ).reasonCode,
    ).toBe("WORKFLOW_STATE_DENIED");
    // The recent-auth window ends strictly at its configured age.
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 301_000 });
    expect((await authorize(ok, authzDeps(h))).reasonCode).toBe(
      "RECENT_AUTH_REQUIRED",
    );
  });

  it("denies candidate business access until an ownership adapter exists", async () => {
    const candidate = await createTestAccount(h.runtime.auth, {
      accountType: "CANDIDATE",
      status: "ACTIVE",
      emailVerified: true,
    });
    const signedIn = await signInCandidate(
      { email: candidate.email, password: TEST_PASSWORD },
      headers(),
      h.runtime,
    );
    if (signedIn.kind !== "SIGNED_IN") throw new Error(signedIn.kind);
    const principal = await resolveCurrentAccount(
      headers(new CookieJar().apply(signedIn.setCookies)),
      h.runtime,
    );
    expect(principal?.accountType).toBe("CANDIDATE");
    const own: AuthorizationRequest = {
      principal,
      permission: "candidate.own_profile.read",
      operation: "READ",
      resource: {
        kind: "RECORD",
        id: scopes.RECORD,
        sensitivity: "CONFIDENTIAL_PERSONNEL",
      },
    };
    const production = {
      ...authzDeps(h),
      ownership: { owns: async () => "UNAVAILABLE" as const },
    };
    expect((await authorize(own, production)).reasonCode).toBe(
      "OWNERSHIP_UNAVAILABLE",
    );
    expect(
      (await authorize(readRecord(principal), authzDeps(h))).reasonCode,
    ).toBe("PERMISSION_MISSING");
    // Even with a synthetic test ownership relationship, only that record.
    h.ownership.addOwnership(principal!.accountId, scopes.RECORD);
    expect((await authorize(own, authzDeps(h))).decision).toBe("ALLOW");
    expect(
      (
        await authorize(
          { ...own, resource: { ...own.resource, id: scopes.RECORD_BRANCH2 } },
          authzDeps(h),
        )
      ).reasonCode,
    ).toBe("SCOPE_MISMATCH");
  });

  it("fails closed when the stored catalog or grants are tampered with", async () => {
    const staff = await activateStaff(h, "tamper");
    await grant(
      h,
      pair,
      staff.accountId,
      "RECRUITER",
      "ORGANIZATION",
      scopes.ORG,
    );
    const session = await signIn(h, staff);
    expect(
      (await authorize(readRecord(session.principal), authzDeps(h))).decision,
    ).toBe("ALLOW");
    await admin.query(
      `UPDATE auth.role_permission SET condition = '{"v":1,"kind":"DESIGNATION","designation":"READINESS_APPROVER"}'
       WHERE role_id = (SELECT id FROM auth.role WHERE code = 'RECRUITER')
         AND permission_id = (SELECT id FROM auth.permission WHERE code = 'candidate.read.assigned')`,
    );
    try {
      expect(
        (await authorize(readRecord(session.principal), authzDeps(h)))
          .reasonCode,
      ).toBe("POLICY_UNAVAILABLE");
    } finally {
      await admin.query(
        `UPDATE auth.role_permission SET condition = NULL
         WHERE role_id = (SELECT id FROM auth.role WHERE code = 'RECRUITER')
           AND permission_id = (SELECT id FROM auth.permission WHERE code = 'candidate.read.assigned')`,
      );
    }
    await admin.query(
      "UPDATE auth.permission SET max_sensitivity = 'RESTRICTED_SCREENING_MEDICAL', restricted_data = true WHERE code = 'candidate.read.assigned'",
    );
    try {
      expect(
        (await authorize(readRecord(session.principal), authzDeps(h)))
          .reasonCode,
      ).toBe("POLICY_UNAVAILABLE");
    } finally {
      await admin.query(
        "UPDATE auth.permission SET max_sensitivity = 'CONFIDENTIAL_PERSONNEL', restricted_data = false WHERE code = 'candidate.read.assigned'",
      );
    }
    expect(
      (await authorize(readRecord(session.principal), authzDeps(h))).decision,
    ).toBe("ALLOW");
  });

  it("authorizes inside a command transaction with the same result", async () => {
    const staff = await activateStaff(h, "tx");
    await grant(
      h,
      pair,
      staff.accountId,
      "RECRUITER",
      "ORGANIZATION",
      scopes.ORG,
    );
    const session = await signIn(h, staff);
    const decision = await h.runtime.db.transaction((tx) =>
      authorizeInTransaction(tx, readRecord(session.principal), authzDeps(h)),
    );
    expect(decision.decision).toBe("ALLOW");
  });

  it("keeps logs and events free of sensitive values", () => {
    const output = h.logs.raw() + JSON.stringify(h.events);
    expect(findCanaryCategories(output)).toEqual([]);
    for (const forbidden of [
      "@example.test",
      scopes.RECORD,
      scopes.BRANCH,
      "TEST-TICKET",
      "Mozilla",
      "198.51.100",
      "psa.session",
      "SELECT",
    ]) {
      expect(output.includes(forbidden), forbidden).toBe(false);
    }
  });
});

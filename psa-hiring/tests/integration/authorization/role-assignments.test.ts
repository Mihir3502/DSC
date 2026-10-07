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
import { resolveCurrentStaff } from "@/modules/identity-access/application/reauthenticate-staff";
import {
  approveRoleAssignment,
  listRoleAssignments,
  proposeRoleAssignment,
  rejectRoleAssignment,
  replaceRoleAssignment,
  revokeRoleAssignment,
  type ProposeAssignmentInput,
} from "@/modules/identity-access/application/role-assignments";
import { RefusingAssignmentHarness } from "@/modules/identity-access/infrastructure/assignment-harness";
import { UnavailableScopeResolver } from "@/modules/identity-access/infrastructure/scope-resolvers";
import { closeDatabasePool } from "@/shared/database";
import { findCanaryCategories } from "../../fixtures/canaries";
import {
  activateStaff,
  assignmentDeps,
  bootstrap,
  createAuthorizationHarness,
  createBootstrapPair,
  grant,
  headers,
  prepareAuthorizationDatabase,
  scopes,
  signIn,
  stepUp,
  type AuthorizationHarness,
  type BootstrapPair,
} from "../support/authorization";
import { dropOwnedDatabase, type OwnedDatabase } from "../support/harness";

// M1.4 role-assignment lifecycle on real PostgreSQL (packet M1.4 §9, §13.3,
// §15, AC-M1.4-04, AC-M1.4-10, AC-M1.4-12, AC-M1.4-13).

const ctx = inject("postgres");
let db: OwnedDatabase;
let admin: Client;
let restoreEnv: () => void;
let h: AuthorizationHarness;
let pair: BootstrapPair;

async function staffAccount(label: string): Promise<string> {
  const email = `test.${label}.${Date.now()}.${Math.random().toString(36).slice(2)}@example.test`;
  const { rows } = await admin.query<{ id: string }>(
    `INSERT INTO auth."user" (name, email, email_display, email_verified, account_type, status)
     VALUES ('TEST staff', $1, $2, true, 'STAFF', 'ACTIVE') RETURNING id`,
    [email, email],
  );
  return rows[0]!.id;
}

async function assignment(id: string) {
  const { rows } = await admin.query(
    "SELECT status, version, approved_by_user_id, revoked_by_user_id, revocation_reason_code, superseded_by_assignment_id, replaces_assignment_id FROM auth.user_role_assignment WHERE id = $1",
    [id],
  );
  return rows[0];
}

const input = (
  subjectAccountId: string,
  overrides: Partial<ProposeAssignmentInput> = {},
): ProposeAssignmentInput => ({
  subjectAccountId,
  roleCode: "RECRUITER",
  scopeType: "BRANCH",
  scopeReferenceId: scopes.BRANCH,
  effectiveFrom: new Date(Date.now() - 60_000),
  effectiveTo: null,
  reasonCode: "NEW_ACCESS",
  reasonReference: "TEST-TICKET-2",
  ...overrides,
});

beforeAll(async () => {
  ({ db, admin, restoreEnv } = await prepareAuthorizationDatabase(
    ctx,
    "authz_assign",
  ));
  h = createAuthorizationHarness();
  pair = await createBootstrapPair(admin);
});

afterEach(() => {
  h.events.length = 0;
});

afterAll(async () => {
  await closeDatabasePool();
  await admin?.end();
  if (db) await dropOwnedDatabase(ctx, db.name);
  restoreEnv?.();
});

describe("database constraints", () => {
  it("makes a CANDIDATE-role staff assignment impossible", async () => {
    const subject = await staffAccount("fk");
    const error = await admin
      .query(
        `INSERT INTO auth.user_role_assignment (user_account_id, role_id, scope_type, scope_reference_id, effective_from, status, reason_code, created_by_user_id)
         SELECT $1, id, 'ORGANIZATION', $2, now(), 'PROPOSED', 'NEW_ACCESS', $3 FROM auth.role WHERE code = 'CANDIDATE'`,
        [subject, scopes.ORG, pair.creator],
      )
      .catch((e: { code?: string }) => e);
    expect((error as { code?: string }).code).toBe("23503");
  });

  it("enforces dates, approval evidence, separation, and revocation evidence", async () => {
    const subject = await staffAccount("checks");
    const insert = (columns: string, values: string) =>
      admin
        .query(
          `INSERT INTO auth.user_role_assignment (user_account_id, role_id, scope_type, scope_reference_id, reason_code, created_by_user_id, ${columns})
           SELECT $1, id, 'ORGANIZATION', $2, 'NEW_ACCESS', $3, ${values} FROM auth.role WHERE code = 'RECRUITER'`,
          [subject, scopes.ORG, pair.creator],
        )
        .catch((e: { code?: string }) => e);
    const cases = [
      // effective_to must be strictly after effective_from
      ["effective_from, effective_to, status", "now(), now(), 'PROPOSED'"],
      // ACTIVE requires approval evidence
      ["effective_from, status", "now(), 'ACTIVE'"],
      // approver can be neither the subject nor the requester
      [
        "effective_from, status, approved_by_user_id, approved_at",
        "now(), 'ACTIVE', $1, now()",
      ],
      [
        "effective_from, status, approved_by_user_id, approved_at",
        "now(), 'ACTIVE', $3, now()",
      ],
      // REVOKED requires revocation evidence
      [
        "effective_from, status, approved_by_user_id, approved_at",
        `now(), 'REVOKED', '${pair.approver}', now()`,
      ],
      // free-text reason references are rejected
      [
        "effective_from, status, reason_reference",
        "now(), 'PROPOSED', 'free text reason'",
      ],
    ] as const;
    for (const [columns, values] of cases) {
      expect(
        ((await insert(columns, values)) as { code?: string }).code,
        values,
      ).toBe("23514");
    }
    // Self-created assignment.
    const self = await admin
      .query(
        `INSERT INTO auth.user_role_assignment (user_account_id, role_id, scope_type, scope_reference_id, reason_code, created_by_user_id, effective_from, status)
         SELECT $1, id, 'ORGANIZATION', $2, 'NEW_ACCESS', $1, now(), 'PROPOSED' FROM auth.role WHERE code = 'RECRUITER'`,
        [subject, scopes.ORG],
      )
      .catch((e: { code?: string }) => e);
    expect((self as { code?: string }).code).toBe("23514");
  });
});

describe("assignment lifecycle (test harness actor)", () => {
  it("proposes, approves with a distinct approver, and applies session/version effects", async () => {
    const staff = await activateStaff(h, "lifecycle");
    const before = await admin.query(
      'SELECT version FROM auth."user" WHERE id = $1',
      [staff.accountId],
    );
    const session = await signIn(h, staff);

    const proposed = await proposeRoleAssignment(
      input(staff.accountId),
      bootstrap(pair.creator),
      assignmentDeps(h),
    );
    expect(proposed).toMatchObject({ kind: "PROPOSED", version: 1 });
    if (proposed.kind !== "PROPOSED") return;
    // A proposal grants nothing and does not touch sessions.
    expect(
      await resolveCurrentStaff(headers(session.jar), h.runtime),
    ).not.toBeNull();

    expect(
      await approveRoleAssignment(
        { assignmentId: proposed.assignmentId, expectedVersion: 1 },
        bootstrap(pair.creator),
        assignmentDeps(h),
      ),
    ).toEqual({ kind: "REFUSED", reason: "APPROVER_CONFLICT" });
    expect(
      await approveRoleAssignment(
        { assignmentId: proposed.assignmentId, expectedVersion: 1 },
        bootstrap(pair.approver),
        assignmentDeps(h),
      ),
    ).toEqual({
      kind: "APPROVED",
      assignmentId: proposed.assignmentId,
      version: 2,
    });

    expect(await assignment(proposed.assignmentId)).toMatchObject({
      status: "ACTIVE",
      version: 2,
      approved_by_user_id: pair.approver,
    });
    const { rows: subject } = await admin.query(
      "SELECT authorization_version FROM auth.authorization_subject WHERE user_account_id = $1",
      [staff.accountId],
    );
    expect(subject[0].authorization_version).toBe(1);
    const after = await admin.query(
      'SELECT version FROM auth."user" WHERE id = $1',
      [staff.accountId],
    );
    expect(after.rows[0].version).toBe(before.rows[0].version + 1);
    // Privilege expansion ends existing sessions: a fresh MFA session is required.
    expect(
      await resolveCurrentStaff(headers(session.jar), h.runtime),
    ).toBeNull();
    const { rows: sessions } = await admin.query(
      "SELECT count(*)::int AS n FROM auth.session WHERE user_id = $1",
      [staff.accountId],
    );
    expect(sessions[0].n).toBe(0);

    expect(
      h.events.map((e) => e.code).filter((c) => c.startsWith("authz.")),
    ).toEqual([
      "authz.assignment_proposed",
      "authz.assignment_refused",
      "authz.assignment_approved",
      "authz.subject_version_changed",
    ]);
  });

  it("refuses self-grant, self-approval, non-staff subjects, and the candidate role", async () => {
    const subject = await staffAccount("self");
    expect(
      await proposeRoleAssignment(
        input(subject),
        bootstrap(subject),
        assignmentDeps(h),
      ),
    ).toEqual({ kind: "REFUSED", reason: "SELF_ADMINISTRATION" });

    const proposed = await proposeRoleAssignment(
      input(subject),
      bootstrap(pair.creator),
      assignmentDeps(h),
    );
    if (proposed.kind !== "PROPOSED") throw new Error("unreachable");
    expect(
      await approveRoleAssignment(
        { assignmentId: proposed.assignmentId, expectedVersion: 1 },
        bootstrap(subject),
        assignmentDeps(h),
      ),
    ).toEqual({ kind: "REFUSED", reason: "SELF_ADMINISTRATION" });

    const { rows } = await admin.query<{ id: string }>(
      `INSERT INTO auth."user" (name, email, email_display, email_verified, account_type, status)
       VALUES ('TEST candidate', 'test.candidate.subject@example.test', 'test.candidate.subject@example.test', true, 'CANDIDATE', 'ACTIVE') RETURNING id`,
    );
    expect(
      await proposeRoleAssignment(
        input(rows[0]!.id),
        bootstrap(pair.creator),
        assignmentDeps(h),
      ),
    ).toEqual({ kind: "REFUSED", reason: "SUBJECT_NOT_STAFF" });
    expect(
      await proposeRoleAssignment(
        input(subject, {
          roleCode: "CANDIDATE",
          scopeType: "ORGANIZATION",
          scopeReferenceId: scopes.ORG,
        }),
        bootstrap(pair.creator),
        assignmentDeps(h),
      ),
    ).toEqual({ kind: "REFUSED", reason: "ROLE_UNAVAILABLE" });
    expect(
      await proposeRoleAssignment(
        input(subject, { roleCode: "SUPERUSER" }),
        bootstrap(pair.creator),
        assignmentDeps(h),
      ),
    ).toEqual({ kind: "REFUSED", reason: "ROLE_UNAVAILABLE" });
  });

  it("refuses invalid dates, reasons, scope types, overlaps, and retired roles", async () => {
    const subject = await staffAccount("invalid");
    const propose = (overrides: Partial<ProposeAssignmentInput>) =>
      proposeRoleAssignment(
        input(subject, overrides),
        bootstrap(pair.creator),
        assignmentDeps(h),
      );
    const now = new Date();
    expect(await propose({ effectiveFrom: now, effectiveTo: now })).toEqual({
      kind: "REFUSED",
      reason: "INVALID_DATES",
    });
    expect(await propose({ reasonCode: "BECAUSE" })).toEqual({
      kind: "REFUSED",
      reason: "INVALID_REASON",
    });
    expect(await propose({ roleCode: "SYSTEM_ADMINISTRATOR" })).toEqual({
      kind: "REFUSED",
      reason: "SCOPE_NOT_ALLOWED_FOR_ROLE",
    });
    expect(
      await propose({
        scopeReferenceId: "00000000-0000-4000-8000-0000000003e7",
      }),
    ).toEqual({
      kind: "REFUSED",
      reason: "SCOPE_UNRESOLVED",
    });
    expect((await propose({})).kind).toBe("PROPOSED");
    expect(
      await propose({ effectiveFrom: new Date(Date.now() + 86_400_000) }),
    ).toEqual({
      kind: "REFUSED",
      reason: "OVERLAPPING_ASSIGNMENT",
    });
    // A different scope is not equivalent.
    expect((await propose({ scopeReferenceId: scopes.BRANCH2 })).kind).toBe(
      "PROPOSED",
    );

    await admin.query(
      "UPDATE auth.role SET status = 'RETIRED' WHERE code = 'TRAINER_EVALUATOR'",
    );
    try {
      expect(await propose({ roleCode: "TRAINER_EVALUATOR" })).toEqual({
        kind: "REFUSED",
        reason: "ROLE_UNAVAILABLE",
      });
    } finally {
      await admin.query(
        "UPDATE auth.role SET status = 'ACTIVE' WHERE code = 'TRAINER_EVALUATOR'",
      );
    }
  });

  it("never persists an assignment whose scope cannot be resolved by an approved adapter", async () => {
    const subject = await staffAccount("unresolved");
    const deps = {
      ...assignmentDeps(h),
      resolver: new UnavailableScopeResolver(),
    };
    expect(
      await proposeRoleAssignment(
        input(subject),
        bootstrap(pair.creator),
        deps,
      ),
    ).toEqual({ kind: "REFUSED", reason: "SCOPE_UNRESOLVED" });
    const { rows } = await admin.query(
      "SELECT count(*)::int AS n FROM auth.user_role_assignment WHERE user_account_id = $1",
      [subject],
    );
    expect(rows[0].n).toBe(0);
  });

  it("revokes without reactivation; restoration creates a new assignment", async () => {
    const subject = await staffAccount("revoke");
    const id = await grant(h, pair, subject, "RECRUITER", "TEAM", scopes.TEAM);
    expect(
      await revokeRoleAssignment(
        { assignmentId: id, expectedVersion: 2, reasonCode: "ACCESS_REVIEW" },
        bootstrap(subject),
        assignmentDeps(h),
      ),
    ).toEqual({ kind: "REFUSED", reason: "SELF_ADMINISTRATION" });
    expect(
      await revokeRoleAssignment(
        { assignmentId: id, expectedVersion: 1, reasonCode: "ACCESS_REVIEW" },
        bootstrap(pair.approver),
        assignmentDeps(h),
      ),
    ).toEqual({ kind: "REFUSED", reason: "STALE_VERSION" });
    expect(
      await revokeRoleAssignment(
        { assignmentId: id, expectedVersion: 2, reasonCode: "ACCESS_REVIEW" },
        bootstrap(pair.approver),
        assignmentDeps(h),
      ),
    ).toEqual({ kind: "REVOKED", assignmentId: id, version: 3 });
    expect(await assignment(id)).toMatchObject({
      status: "REVOKED",
      revoked_by_user_id: pair.approver,
      revocation_reason_code: "ACCESS_REVIEW",
    });
    for (const attempt of [
      approveRoleAssignment(
        { assignmentId: id, expectedVersion: 3 },
        bootstrap(pair.approver),
        assignmentDeps(h),
      ),
      revokeRoleAssignment(
        { assignmentId: id, expectedVersion: 3, reasonCode: "ACCESS_REVIEW" },
        bootstrap(pair.approver),
        assignmentDeps(h),
      ),
    ]) {
      expect(await attempt).toEqual({
        kind: "REFUSED",
        reason: "INVALID_STATE",
      });
    }
    // Restoration is a new row.
    const restored = await grant(
      h,
      pair,
      subject,
      "RECRUITER",
      "TEAM",
      scopes.TEAM,
    );
    expect(restored).not.toBe(id);
  });

  it("rejects a proposal without granting anything", async () => {
    const subject = await staffAccount("reject");
    const proposed = await proposeRoleAssignment(
      input(subject),
      bootstrap(pair.creator),
      assignmentDeps(h),
    );
    if (proposed.kind !== "PROPOSED") throw new Error("unreachable");
    expect(
      await rejectRoleAssignment(
        {
          assignmentId: proposed.assignmentId,
          expectedVersion: 1,
          reasonCode: "PROPOSAL_REJECTED",
        },
        bootstrap(pair.approver),
        assignmentDeps(h),
      ),
    ).toMatchObject({ kind: "REJECTED" });
    expect(await assignment(proposed.assignmentId)).toMatchObject({
      status: "REJECTED",
    });
  });

  it("changes scope by revoke-and-create (supersession), never by rewriting", async () => {
    const subject = await staffAccount("replace");
    const original = await grant(
      h,
      pair,
      subject,
      "HR_SPECIALIST",
      "BRANCH",
      scopes.BRANCH,
    );
    const successor = await replaceRoleAssignment(
      original,
      input(subject, {
        roleCode: "HR_SPECIALIST",
        scopeType: "TEAM",
        scopeReferenceId: scopes.TEAM,
        reasonCode: "SCOPE_CHANGE",
      }),
      bootstrap(pair.creator),
      assignmentDeps(h),
    );
    if (successor.kind !== "PROPOSED")
      throw new Error(JSON.stringify(successor));
    // Still active until the successor is approved.
    expect(await assignment(original)).toMatchObject({ status: "ACTIVE" });
    expect(
      await approveRoleAssignment(
        { assignmentId: successor.assignmentId, expectedVersion: 1 },
        bootstrap(pair.approver),
        assignmentDeps(h),
      ),
    ).toMatchObject({ kind: "APPROVED" });
    expect(await assignment(original)).toMatchObject({
      status: "SUPERSEDED",
      superseded_by_assignment_id: successor.assignmentId,
      revocation_reason_code: "SUPERSEDED",
    });
    expect(await assignment(successor.assignmentId)).toMatchObject({
      status: "ACTIVE",
      replaces_assignment_id: original,
    });
  });

  it("refuses the bootstrap actor in the application's own runtime", async () => {
    const subject = await staffAccount("refusing");
    const deps = {
      ...assignmentDeps(h),
      harness: new RefusingAssignmentHarness(),
    };
    expect(
      await proposeRoleAssignment(
        input(subject),
        bootstrap(pair.creator),
        deps,
      ),
    ).toEqual({ kind: "REFUSED", reason: "NOT_AUTHORIZED" });
  });
});

describe("assignment administration by authorized staff", () => {
  it("requires the right permission, administrative scope, and recent strong MFA", async () => {
    const adminStaff = await activateStaff(h, "sysadmin");
    const manager = await activateStaff(h, "manager");
    const branchManager = await activateStaff(h, "branch-manager");
    const subject = await staffAccount("target");
    await grant(
      h,
      pair,
      adminStaff.accountId,
      "SYSTEM_ADMINISTRATOR",
      "ORGANIZATION",
      scopes.ORG,
    );
    await grant(
      h,
      pair,
      manager.accountId,
      "PSA_MANAGER",
      "ORGANIZATION",
      scopes.ORG,
    );
    await grant(
      h,
      pair,
      branchManager.accountId,
      "PSA_MANAGER",
      "BRANCH",
      scopes.BRANCH,
    );

    const adminSession = await signIn(h, adminStaff);
    const actor = {
      kind: "ACCOUNT",
      principal: adminSession.principal,
    } as const;
    // MFA session but no purpose-bound recent step-up yet.
    expect(
      await proposeRoleAssignment(input(subject), actor, assignmentDeps(h)),
    ).toEqual({ kind: "REFUSED", reason: "NOT_AUTHORIZED" });
    await stepUp(h, adminStaff, adminSession, "PRIVILEGED_ACCESS_CHANGE");
    const proposed = await proposeRoleAssignment(
      input(subject),
      actor,
      assignmentDeps(h),
    );
    if (proposed.kind !== "PROPOSED") throw new Error(JSON.stringify(proposed));
    // The administrator implements; it never approves.
    expect(
      await approveRoleAssignment(
        { assignmentId: proposed.assignmentId, expectedVersion: 1 },
        actor,
        assignmentDeps(h),
      ),
    ).toEqual({ kind: "REFUSED", reason: "NOT_AUTHORIZED" });

    // A branch-scoped manager cannot approve an organization-level grant
    // of a different branch... (scope containment on the target).
    const orgLevel = await proposeRoleAssignment(
      input(subject, {
        roleCode: "HR_SPECIALIST",
        scopeType: "ORGANIZATION",
        scopeReferenceId: scopes.ORG,
      }),
      actor,
      assignmentDeps(h),
    );
    if (orgLevel.kind !== "PROPOSED") throw new Error(JSON.stringify(orgLevel));
    const branchSession = await signIn(h, branchManager);
    await stepUp(h, branchManager, branchSession, "PRIVILEGED_ACCESS_CHANGE");
    expect(
      await approveRoleAssignment(
        { assignmentId: orgLevel.assignmentId, expectedVersion: 1 },
        { kind: "ACCOUNT", principal: branchSession.principal },
        assignmentDeps(h),
      ),
    ).toEqual({ kind: "REFUSED", reason: "NOT_AUTHORIZED" });

    const managerSession = await signIn(h, manager);
    await stepUp(h, manager, managerSession, "PRIVILEGED_ACCESS_CHANGE");
    const managerActor = {
      kind: "ACCOUNT",
      principal: managerSession.principal,
    } as const;
    expect(
      await approveRoleAssignment(
        { assignmentId: proposed.assignmentId, expectedVersion: 1 },
        managerActor,
        assignmentDeps(h),
      ),
    ).toMatchObject({ kind: "APPROVED" });
    // The manager may not grant to themselves.
    expect(
      await proposeRoleAssignment(
        input(manager.accountId),
        managerActor,
        assignmentDeps(h),
      ),
    ).toEqual({ kind: "REFUSED", reason: "SELF_ADMINISTRATION" });

    const listed = await listRoleAssignments(
      subject,
      managerActor,
      assignmentDeps(h),
    );
    expect(listed.map((a) => a.roleCode).sort()).toEqual([
      "HR_SPECIALIST",
      "RECRUITER",
    ]);
    expect(JSON.stringify(listed)).not.toContain("TEST-TICKET");
  });

  it("emits only safe, future-audit-ready events", async () => {
    const subject = await staffAccount("events");
    await grant(h, pair, subject, "TRAINER_EVALUATOR", "TEAM", scopes.TEAM);
    await proposeRoleAssignment(
      input(subject, { reasonCode: "NOT A CODE" }),
      bootstrap(pair.creator),
      assignmentDeps(h),
    );
    const output = JSON.stringify(h.events) + h.logs.raw();
    expect(findCanaryCategories(output)).toEqual([]);
    for (const forbidden of [
      "TEST-TICKET",
      "@example.test",
      scopes.TEAM,
      "NOT A CODE",
      "SELECT",
      "violates",
    ]) {
      expect(output.includes(forbidden), forbidden).toBe(false);
    }
    for (const event of h.events) {
      expect(
        Object.keys(event).every((k) =>
          [
            "code",
            "accountRef",
            "recordRef",
            "category",
            "permissionCode",
            "roleCode",
            "scopeType",
            "reasonCode",
            "policyVersion",
          ].includes(k),
        ),
      ).toBe(true);
    }
  });
});

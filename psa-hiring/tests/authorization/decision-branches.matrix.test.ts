import { describe, expect, it } from "vitest";
import type { QueryScopeRequest } from "@/modules/identity-access/application/authorize";
import { narrowConstraint } from "@/modules/identity-access/application/authorize-query";
import { findPermission } from "@/modules/identity-access/policy/permission-catalog";
import { grantCatalog } from "@/modules/identity-access/policy/role-permission-catalog";
import {
  account,
  expectAllow,
  expectDeny,
  matrixWorld,
  principalOf,
  satisfyingRequest,
  sessionOf,
  staffSession,
} from "../fixtures/authorization/matrix-harness";
import { at, record, scope } from "../fixtures/scopes";

// M1.7 §22: every decision branch of the central engine is proven, not only
// the ones the role/scope/field matrices reach naturally. Each case drives
// one deny branch through evaluateAuthorization/evaluateQueryScope with the
// shared synthetic world and asserts the exact closed reason code.

const def = (code: string) => findPermission(code)!;

describe("candidate decision branches (§12, §22)", () => {
  const candidate = principalOf(account.CANDIDATE_A, "CANDIDATE");

  it("denies a candidate permission against a scope resource as invalid context", async () => {
    const w = matrixWorld();
    expectDeny(
      await w.decide({
        principal: candidate,
        permission: "candidate.own_profile.read",
        operation: "READ",
        resource: {
          kind: "SCOPE",
          scopeType: "ORGANIZATION",
          id: scope.ORG,
          sensitivity: "INTERNAL",
        },
      }),
      "INVALID_CONTEXT",
    );
  });

  it("denies an owned record above the candidate permission's sensitivity ceiling", async () => {
    const w = matrixWorld();
    expectDeny(
      await w.decide({
        principal: candidate,
        permission: "interview.own_schedule.read",
        operation: "READ",
        resource: {
          kind: "RECORD",
          id: record.IN_TEAM,
          sensitivity: "CONFIDENTIAL_PERSONNEL",
        },
      }),
      "SENSITIVITY_DENIED",
    );
  });

  it("denies an owned candidate command in a disallowed workflow state", async () => {
    const w = matrixWorld();
    expectDeny(
      await w.decide({
        principal: candidate,
        permission: "candidacy.own.withdraw",
        operation: "EDIT",
        resource: {
          kind: "RECORD",
          id: record.IN_TEAM,
          sensitivity: "INTERNAL",
        },
        workflow: { policy: "CANDIDACY_WORKFLOW", state: "ON_HOLD" },
      }),
      "WORKFLOW_STATE_DENIED",
    );
  });
});

describe("staff decision branches (§11, §22)", () => {
  const READ = def("candidate.read.assigned");

  it("denies a scope resource when the scope resolver is unavailable", async () => {
    const w = matrixWorld();
    w.assign(account.ACTOR, "RECRUITER", "ORGANIZATION", scope.ORG);
    w.resolver.unavailable = true;
    expectDeny(
      await w.decide({
        principal: principalOf(account.ACTOR),
        permission: READ.code,
        operation: "READ",
        resource: {
          kind: "SCOPE",
          scopeType: "BRANCH",
          id: scope.BRANCH,
          sensitivity: "INTERNAL",
        },
      }),
      "SCOPE_UNAVAILABLE",
    );
  });

  it("denies when the resource resolves but every assignment scope is unavailable", async () => {
    const w = matrixWorld();
    w.assign(account.ACTOR, "RECRUITER", "ORGANIZATION", scope.ORG);
    w.resolver.resolveScope = async () => ({ status: "UNAVAILABLE" });
    expectDeny(
      await w.decide({
        principal: principalOf(account.ACTOR),
        permission: READ.code,
        operation: "READ",
        resource: {
          kind: "RECORD",
          id: record.IN_TEAM,
          sensitivity: "INTERNAL",
        },
      }),
      "SCOPE_UNAVAILABLE",
    );
  });

  // Future-dated (clock-skewed) evidence is refused by the session check in
  // preflight, before any recent-auth requirement is evaluated; the
  // non-challenge branch in the recent-auth step is defense in depth.
  it("denies recent authentication recorded in the future (clock skew) at the session check", async () => {
    const grant = grantCatalog.find(
      (g) =>
        g.status === "ACTIVE" &&
        g.condition === null &&
        g.roleCode !== "CANDIDATE" &&
        findPermission(g.permissionCode)?.recentAuth,
    )!;
    const w = matrixWorld();
    const request = satisfyingRequest(
      w,
      grant.roleCode,
      def(grant.permissionCode),
    );
    expectAllow(await w.decide(request), grant.roleCode);
    const actor = request.principal!.accountId;
    w.facts.evidence.set(
      sessionOf(actor),
      staffSession(actor, {
        reauthentication: {
          at: at(3_600),
          method: "PASSWORD_TOTP",
          purpose:
            def(grant.permissionCode).recentAuth!.purpose ?? "STAFF_SECURITY",
        },
      }),
    );
    expectDeny(await w.decide(request), "UNAUTHENTICATED");
  });

  it("ignores a stored grant row that the reviewed manifest does not contain", async () => {
    const w = matrixWorld();
    w.assign(account.ACTOR, "RECRUITER", "ORGANIZATION", scope.ORG);
    // Tampering: storage claims RECRUITER holds a permission it was never
    // granted. The row is not in the manifest, so the engine fails closed.
    const code = "identity_document.read_restricted";
    expect(w.facts.grant("RECRUITER", code)).toBeUndefined();
    w.facts.loadStaffGrants = async () => [
      {
        assignmentId: w.facts.assignments[0]!.assignmentId,
        roleCode: "RECRUITER",
        scopeType: "ORGANIZATION",
        scopeReferenceId: scope.ORG,
        effectiveFrom: at(-86_400),
        condition: null,
      },
    ];
    const decision = await w.decide({
      principal: principalOf(account.ACTOR),
      permission: code,
      operation: "READ",
      resource: {
        kind: "RECORD",
        id: record.IN_TEAM,
        sensitivity: "RESTRICTED_IDENTITY_FINANCIAL",
      },
      ...(def(code).requiresReason ? { reasonCode: "MATRIX_TEST" } : {}),
    });
    expectDeny(decision, "POLICY_UNAVAILABLE");
  });
});

describe("query-scope decision branches (§11, §19, §22)", () => {
  const base = {
    principal: principalOf(account.ACTOR),
    permission: "candidate.read.assigned",
    operation: "READ",
    sensitivity: "INTERNAL",
  } as const;
  const malformed: ReadonlyArray<readonly [string, unknown]> = [
    [
      "a non-plain object",
      Object.assign(Object.create({ inherited: 1 }), base),
    ],
    ["an unknown key", { ...base, scope: scope.ORG }],
    ["a non-string permission", { ...base, permission: 7 }],
    ["a mutating operation", { ...base, operation: "EDIT" }],
    ["an unknown sensitivity", { ...base, sensitivity: "SECRET" }],
    ["a non-string reason code", { ...base, reasonCode: 1 }],
    ["a malformed reason code", { ...base, reasonCode: "not a code!" }],
    ["a non-string correlation ID", { ...base, correlationId: 1 }],
    [
      "a principal with a malformed account ID",
      { ...base, principal: { ...base.principal, accountId: "x" } },
    ],
    [
      "a principal with a non-string account type",
      { ...base, principal: { ...base.principal, accountType: 1 } },
    ],
    ["a non-object principal", { ...base, principal: "staff" }],
  ];

  it.each(malformed)(
    "denies a query request with %s as invalid context",
    async (_l, request) => {
      const w = matrixWorld();
      w.assign(account.ACTOR, "RECRUITER", "ORGANIZATION", scope.ORG);
      expectDeny(
        await w.query(request as QueryScopeRequest),
        "INVALID_CONTEXT",
      );
    },
  );

  it("denies a query with no principal as unauthenticated", async () => {
    const w = matrixWorld();
    expectDeny(await w.query({ ...base, principal: null }), "UNAUTHENTICATED");
  });

  it("fails closed when a facts source throws during a query", async () => {
    const w = matrixWorld();
    w.facts.loadAccount = async () => {
      throw new Error("synthetic facts outage");
    };
    expectDeny(await w.query(base), "POLICY_UNAVAILABLE");
  });

  it("keeps candidates out of staff list permissions and ungranted candidate lists", async () => {
    const w = matrixWorld();
    const candidate = principalOf(account.CANDIDATE_A, "CANDIDATE");
    expectDeny(
      await w.query({ ...base, principal: candidate }),
      "PERMISSION_MISSING",
    );
    w.facts.removedGrants.add("CANDIDATE|offer.own.read");
    expectDeny(
      await w.query({
        principal: candidate,
        permission: "offer.own.read",
        operation: "READ",
        sensitivity: "INTERNAL",
      }),
      "PERMISSION_MISSING",
    );
  });

  it("keeps staff out of candidate-self list permissions", async () => {
    const w = matrixWorld();
    w.assign(account.ACTOR, "RECRUITER", "ORGANIZATION", scope.ORG);
    expectDeny(
      await w.query({ ...base, permission: "offer.own.read" }),
      "PERMISSION_MISSING",
    );
  });

  it("denies a list when every assignment scope is unavailable or inactive", async () => {
    const unavailable = matrixWorld();
    unavailable.assign(account.ACTOR, "RECRUITER", "ORGANIZATION", scope.ORG);
    unavailable.resolver.unavailable = true;
    expectDeny(await unavailable.query(base), "SCOPE_UNAVAILABLE");

    const inactive = matrixWorld();
    inactive.assign(
      account.ACTOR,
      "RECRUITER",
      "BRANCH",
      scope.INACTIVE_BRANCH,
    );
    expectDeny(await inactive.query(base), "SCOPE_MISMATCH");
  });

  it("never widens a list through a participant condition, even with the relationship", async () => {
    const w = matrixWorld();
    const code = "interview.schedule.read";
    const grant = w.facts.grant("TRAINER_EVALUATOR", code)!;
    expect(grant.condition?.kind).toBe("PARTICIPANT");
    w.assign(account.ACTOR, "TRAINER_EVALUATOR", "ORGANIZATION", scope.ORG);
    if (grant.condition?.kind === "PARTICIPANT") {
      w.resolver.addRelationship(
        account.ACTOR,
        record.IN_TEAM,
        grant.condition.relationship,
      );
    }
    expectDeny(
      await w.query({
        ...base,
        permission: code,
        sensitivity: def(code).maxSensitivity,
      }),
      "CONDITION_UNMET",
    );
  });

  it("denies a designation-conditioned list until the designation exists", async () => {
    const w = matrixWorld();
    const code = "identity_document.read_masked";
    w.assign(account.ACTOR, "HR_SPECIALIST", "ORGANIZATION", scope.ORG);
    const request = {
      ...base,
      permission: code,
      sensitivity: "RESTRICTED_IDENTITY_FINANCIAL",
    } as const;
    expectDeny(await w.query(request), "CONDITION_UNMET");
    w.resolver.addDesignation(
      account.ACTOR,
      "RESTRICTED_IDENTITY_REVIEWER",
      scope.ORG,
    );
    expect((await w.query(request)).decision).toBe("ALLOW");
  });

  it("denies a list export whose separation policy needs per-record facts", async () => {
    const w = matrixWorld();
    const code = "record.export.standard";
    expect(def(code).separationPolicy).not.toBeNull();
    w.assign(account.ACTOR, "RECRUITER", "ORGANIZATION", scope.ORG);
    const decision = await w.query({
      ...base,
      permission: code,
      operation: "EXPORT",
      ...(def(code).requiresReason ? { reasonCode: "MATRIX_TEST" } : {}),
    });
    expectDeny(decision, "SEPARATION_FACTS_MISSING");
  });
});

describe("list constraint narrowing per scope type (§11, §22)", () => {
  it("narrows to exactly the selected organization, branch, team, or assignment set and never to an audit assignment", async () => {
    const w = matrixWorld();
    w.assign(account.ACTOR, "RECRUITER", "ORGANIZATION", scope.ORG);
    w.assign(account.ACTOR, "RECRUITER", "BRANCH", scope.BRANCH2);
    w.assign(account.ACTOR, "RECRUITER", "TEAM", scope.TEAM);
    w.assign(account.ACTOR, "RECRUITER", "ASSIGNED_RECORDS", scope.SET);
    const decision = await w.query({
      principal: principalOf(account.ACTOR),
      permission: "candidate.read.assigned",
      operation: "READ",
      sensitivity: "INTERNAL",
    });
    expect(decision.decision).toBe("ALLOW");
    if (decision.decision !== "ALLOW") return;
    expect(decision.constraint).toMatchObject({ kind: "SCOPES" });
    const cases = [
      [
        { type: "ORGANIZATION", id: scope.ORG },
        { type: "ORGANIZATION", organizationId: scope.ORG },
      ],
      [
        { type: "BRANCH", id: scope.BRANCH2 },
        { type: "BRANCH", branchId: scope.BRANCH2 },
      ],
      [
        { type: "TEAM", id: scope.TEAM },
        { type: "TEAM", teamId: scope.TEAM },
      ],
      [
        { type: "ASSIGNED_RECORDS", id: scope.SET },
        { type: "ASSIGNED_RECORDS", assignmentSetId: scope.SET },
      ],
    ] as const;
    for (const [selection, expected] of cases) {
      expect(narrowConstraint(decision.constraint, selection)).toMatchObject({
        scopes: [expected],
      });
    }
    for (const selection of [
      { type: "BRANCH", id: scope.BRANCH },
      { type: "TEAM", id: scope.TEAM2 },
      { type: "ASSIGNED_RECORDS", id: scope.SET_ORG2 },
      { type: "AUDIT_ASSIGNMENT", id: scope.AUDIT },
    ] as const) {
      expect(narrowConstraint(decision.constraint, selection)).toBeNull();
    }
  });

  it("never narrows an auditor's list or a candidate's owner list through a selection", async () => {
    const w = matrixWorld();
    w.assign(
      account.AUDITOR,
      "AUDITOR_READ_ONLY",
      "AUDIT_ASSIGNMENT",
      scope.AUDIT,
    );
    const audit = await w.query({
      principal: principalOf(account.AUDITOR),
      permission: "candidate.read.assigned",
      operation: "READ",
      sensitivity: "INTERNAL",
    });
    expect(audit).toMatchObject({
      decision: "ALLOW",
      constraint: { kind: "SCOPES" },
    });
    if (audit.decision !== "ALLOW") return;
    expect(
      narrowConstraint(audit.constraint, {
        type: "AUDIT_ASSIGNMENT",
        id: scope.AUDIT,
      }),
    ).toBeNull();
    const owner = await w.query({
      principal: principalOf(account.CANDIDATE_A, "CANDIDATE"),
      permission: "candidacy.own_status.read",
      operation: "READ",
      sensitivity: "INTERNAL",
    });
    expect(owner).toMatchObject({
      decision: "ALLOW",
      constraint: { kind: "OWNER" },
    });
    if (owner.decision !== "ALLOW") return;
    expect(
      narrowConstraint(owner.constraint, {
        type: "ORGANIZATION",
        id: scope.ORG,
      }),
    ).toBeNull();
    expect(narrowConstraint(owner.constraint, null)).toBe(owner.constraint);
  });
});

import { describe, expect, it } from "vitest";
import type { AppLogger, LogContext } from "@/shared/logging";
import type { AssuranceEvidence } from "../domain/authentication-assurance";
import type { AuthorizationRequest } from "../domain/authorization-decision";
import {
  MandatorySeparationOfDutiesPolicy,
  restrictiveDualControl,
} from "../domain/separation-of-duties-policy";
import type { RoleCode, ScopeType } from "../domain/authorization-vocabulary";
import {
  AUTHORIZATION_POLICY_VERSION,
  permissionRow,
} from "../policy/authorization-catalog";
import { findPermission } from "../policy/permission-catalog";
import { grantCatalog } from "../policy/role-permission-catalog";
import type {
  WorkflowPolicy,
  WorkflowPolicyRegistry,
} from "../policy/workflow-policies";
import {
  SyntheticCandidateOwnership,
  SyntheticScopeResolver,
  UnavailableCandidateOwnership,
  UnavailableScopeResolver,
} from "../infrastructure/scope-resolvers";
import type { SecurityEvent } from "../infrastructure/security-events";
import { evaluateAuthorization, type AuthorizationPorts } from "./authorize";
import type {
  AccountFact,
  AuthorizationFactsSource,
  GrantFact,
  PermissionFact,
  SubjectEpoch,
} from "./ports/authorization-facts";

// Service-level authorization matrix (packet M1.4 §22, §24) over an
// in-memory facts source and the deterministic synthetic resolvers. The
// same matrix runs against real PostgreSQL in
// tests/integration/authorization/authorization-service.test.ts.

const id = (n: number) =>
  `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const ORG = id(1);
const ORG2 = id(2);
const BRANCH = id(3);
const BRANCH2 = id(4);
const TEAM = id(5);
const SET = id(6);
const AUDIT = id(7);
const GROUP = id(8);
const ORG2_BRANCH = id(9);
const RECORD = id(30);
const RECORD_BRANCH2 = id(31);
const RECORD_ORG2 = id(32);
const RECORD_UNASSIGNED = id(33);
const STAFF = id(40);
const SESSION = id(41);
const OTHER_STAFF = id(42);
const CANDIDATE = id(43);
const CANDIDATE_SESSION = id(44);
const NOW = new Date("2026-10-06T12:00:00.000Z");
const ago = (s: number) => new Date(NOW.getTime() - s * 1000);
const later = (s: number) => new Date(NOW.getTime() + s * 1000);

type Assignment = {
  assignmentId: string;
  roleCode: RoleCode;
  scopeType: ScopeType;
  scopeReferenceId: string;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  status: "ACTIVE" | "REVOKED" | "SUPERSEDED" | "PROPOSED";
};

class MemoryFacts implements AuthorizationFactsSource {
  accounts = new Map<string, AccountFact>();
  evidence = new Map<string, AssuranceEvidence>();
  assignments: Assignment[] = [];
  epoch: SubjectEpoch | null = null;
  retiredRoles = new Set<string>();
  permissionOverride: Partial<PermissionFact> | null = null;
  conditionOverride: unknown = undefined;
  failing = false;

  async loadAccount(accountId: string) {
    if (this.failing) throw new Error("connection reset: SELECT secret");
    return this.accounts.get(accountId) ?? null;
  }
  async loadAssurance(accountId: string, sessionId: string) {
    const e = this.evidence.get(sessionId);
    return e && e.accountId === accountId ? e : null;
  }
  async loadSubjectEpoch() {
    return this.epoch;
  }
  async loadPermission(code: string): Promise<PermissionFact | null> {
    const definition = findPermission(code);
    if (!definition) return null;
    return {
      ...permissionRow(definition),
      catalogVersion: 1,
      ...this.permissionOverride,
    };
  }
  private grantFor(roleCode: string, code: string) {
    return grantCatalog.find(
      (g) => g.roleCode === roleCode && g.permissionCode === code,
    );
  }
  async loadStaffGrants(
    accountId: string,
    code: string,
    at: Date,
  ): Promise<GrantFact[]> {
    return this.assignments
      .filter(
        (a) =>
          a.status === "ACTIVE" &&
          !this.retiredRoles.has(a.roleCode) &&
          a.effectiveFrom.getTime() <= at.getTime() &&
          (a.effectiveTo === null || at.getTime() < a.effectiveTo.getTime()) &&
          this.grantFor(a.roleCode, code),
      )
      .filter(() => accountId === STAFF)
      .map((a) => ({
        assignmentId: a.assignmentId,
        roleCode: a.roleCode,
        scopeType: a.scopeType,
        scopeReferenceId: a.scopeReferenceId,
        effectiveFrom: a.effectiveFrom,
        condition:
          this.conditionOverride !== undefined
            ? this.conditionOverride
            : (this.grantFor(a.roleCode, code)!.condition ?? null),
      }));
  }
  async hasIneffectiveAssignment(accountId: string, code: string) {
    return (
      accountId === STAFF &&
      this.assignments.some((a) => this.grantFor(a.roleCode, code))
    );
  }
  async loadCandidateGrants(code: string): Promise<GrantFact[]> {
    const grant = this.grantFor("CANDIDATE", code);
    return grant
      ? [
          {
            assignmentId: null,
            roleCode: "CANDIDATE",
            scopeType: null,
            scopeReferenceId: null,
            effectiveFrom: null,
            condition: grant.condition,
          },
        ]
      : [];
  }
}

function staffEvidence(
  overrides: Partial<AssuranceEvidence> = {},
): AssuranceEvidence {
  return {
    accountId: STAFF,
    sessionId: SESSION,
    sessionPurpose: "STAFF",
    method: "PASSWORD_TOTP",
    primaryAuthenticatedAt: ago(3600),
    mfaAuthenticatedAt: ago(3600),
    sessionAccountVersion: 3,
    currentAccountVersion: 3,
    reauthentication: null,
    ...overrides,
  };
}

function captureLogger() {
  const lines: { event: string; context?: LogContext }[] = [];
  const logger: AppLogger = {
    debug: (event, context) => lines.push({ event, context }),
    info: (event, context) => lines.push({ event, context }),
    warn: (event, context) => lines.push({ event, context }),
    error: (event, context) => lines.push({ event, context }),
    child: () => logger,
  };
  return { logger, lines };
}

const permittingPolicy: WorkflowPolicy = {
  code: "CANDIDACY_WORKFLOW",
  states: ["ONBOARDING", "FINAL_COMPLIANCE_REVIEW", "WITHDRAWN"],
  permits: (_code, state) => state !== "WITHDRAWN",
};

function setup(
  options: {
    ports?: Partial<AuthorizationPorts>;
    workflow?: WorkflowPolicyRegistry;
  } = {},
) {
  const facts = new MemoryFacts();
  facts.accounts.set(STAFF, {
    id: STAFF,
    accountType: "STAFF",
    status: "ACTIVE",
  });
  facts.accounts.set(OTHER_STAFF, {
    id: OTHER_STAFF,
    accountType: "STAFF",
    status: "ACTIVE",
  });
  facts.accounts.set(CANDIDATE, {
    id: CANDIDATE,
    accountType: "CANDIDATE",
    status: "ACTIVE",
  });
  facts.evidence.set(SESSION, staffEvidence());
  facts.evidence.set(CANDIDATE_SESSION, {
    ...staffEvidence({ accountId: CANDIDATE, sessionId: CANDIDATE_SESSION }),
    sessionPurpose: "STANDARD",
    method: "PASSWORD",
  });

  const resolver = new SyntheticScopeResolver("test")
    .addOrganization(ORG)
    .addOrganization(ORG2)
    .addBranch(BRANCH, ORG)
    .addBranch(BRANCH2, ORG)
    .addBranch(ORG2_BRANCH, ORG2)
    .addTeam(TEAM, BRANCH)
    .addAssignmentSet(SET, ORG)
    .addAuditAssignment(AUDIT, {
      organizationId: ORG,
      auditorAccountId: STAFF,
      categories: ["CONFIDENTIAL_PERSONNEL"],
      recordGroupIds: [GROUP],
      recordsFrom: new Date("2026-01-01T00:00:00Z"),
      recordsTo: new Date("2026-07-01T00:00:00Z"),
      startsAt: ago(86_400),
      endsAt: later(86_400),
    })
    .addRecord(RECORD, {
      organizationId: ORG,
      branchId: BRANCH,
      teamId: TEAM,
      assignmentSetIds: [SET],
      recordGroupIds: [GROUP],
      recordedAt: new Date("2026-03-01T00:00:00Z"),
      subjectAccountIds: [CANDIDATE],
    })
    .addRecord(RECORD_BRANCH2, {
      organizationId: ORG,
      branchId: BRANCH2,
      subjectAccountIds: [CANDIDATE],
    })
    .addRecord(RECORD_ORG2, {
      organizationId: ORG2,
      branchId: ORG2_BRANCH,
      subjectAccountIds: [CANDIDATE],
    })
    .addRecord(RECORD_UNASSIGNED, {
      organizationId: ORG,
      branchId: BRANCH,
      teamId: TEAM,
      subjectAccountIds: [],
    });
  const ownership = new SyntheticCandidateOwnership("test").addOwnership(
    CANDIDATE,
    RECORD,
  );
  const events: SecurityEvent[] = [];
  const { logger, lines } = captureLogger();
  const deps = {
    resolver,
    ownership,
    workflow:
      options.workflow ?? new Map([["CANDIDACY_WORKFLOW", permittingPolicy]]),
    separation: new MandatorySeparationOfDutiesPolicy(),
    dualControl: restrictiveDualControl,
    clock: () => NOW,
    events: {
      record: async (e: SecurityEvent) => (events.push(e), true),
      recordInTransaction: async (_tx: unknown, e: SecurityEvent) => {
        events.push(e);
      },
    },
    logger,
    recentWindowSeconds: 300,
    ...options.ports,
  };
  const assign = (
    roleCode: RoleCode,
    scopeType: ScopeType,
    scopeReferenceId: string,
    overrides: Partial<Assignment> = {},
  ) => {
    const assignmentId = id(1000 + facts.assignments.length);
    facts.assignments.push({
      assignmentId,
      roleCode,
      scopeType,
      scopeReferenceId,
      effectiveFrom: ago(86_400),
      effectiveTo: null,
      status: "ACTIVE",
      ...overrides,
    });
    return assignmentId;
  };
  const run = (request: AuthorizationRequest) =>
    evaluateAuthorization(request, facts, deps);
  return { facts, resolver, ownership, deps, events, lines, assign, run };
}

const staff = { accountId: STAFF, accountType: "STAFF", sessionId: SESSION };
const read = (
  resource = RECORD,
  sensitivity: AuthorizationRequest["resource"]["sensitivity"] = "CONFIDENTIAL_PERSONNEL",
): AuthorizationRequest => ({
  principal: staff,
  permission: "candidate.read.assigned",
  operation: "READ",
  resource: { kind: "RECORD", id: resource, sensitivity },
});

describe("authorization service: identity and account", () => {
  it("denies an unauthenticated request", async () => {
    const { run } = setup();
    expect(await run({ ...read(), principal: null })).toMatchObject({
      decision: "DENY",
      reasonCode: "UNAUTHENTICATED",
    });
  });

  it("denies inactive, locked, disabled, closed, and invited accounts", async () => {
    for (const status of ["INVITED", "LOCKED", "DISABLED", "CLOSED"]) {
      const { run, facts, assign } = setup();
      assign("RECRUITER", "ORGANIZATION", ORG);
      facts.accounts.set(STAFF, { id: STAFF, accountType: "STAFF", status });
      expect((await run(read())).reasonCode, status).toBe("ACCOUNT_INACTIVE");
    }
  });

  it("denies a stale browser claim of a different account type", async () => {
    const { run, assign } = setup();
    assign("RECRUITER", "ORGANIZATION", ORG);
    expect(
      (
        await run({
          ...read(),
          principal: { ...staff, accountType: "CANDIDATE" },
        })
      ).reasonCode,
    ).toBe("ACCOUNT_INACTIVE");
  });

  it("denies when the session no longer exists or is not MFA-complete", async () => {
    const { run, facts, assign } = setup();
    assign("RECRUITER", "ORGANIZATION", ORG);
    facts.evidence.delete(SESSION);
    expect((await run(read())).reasonCode).toBe("UNAUTHENTICATED");
    facts.evidence.set(SESSION, staffEvidence({ sessionAccountVersion: 2 }));
    expect((await run(read())).reasonCode).toBe("UNAUTHENTICATED");
    facts.evidence.set(
      SESSION,
      staffEvidence({ sessionPurpose: "STAFF_FIRST_FACTOR" }),
    );
    expect((await run(read())).reasonCode).toBe("UNAUTHENTICATED");
  });

  it("denies malformed or contract-violating requests without throwing", async () => {
    const { run, assign } = setup();
    assign("PSA_MANAGER", "ORGANIZATION", ORG);
    expect(
      await run({
        ...read(),
        roles: ["PSA_MANAGER"],
      } as unknown as AuthorizationRequest),
    ).toMatchObject({
      decision: "DENY",
      reasonCode: "INVALID_CONTEXT",
      permissionCode: "unknown",
    });
    expect((await run({ ...read(), operation: "APPROVE" })).reasonCode).toBe(
      "INVALID_CONTEXT",
    );
    expect(
      (await run({ ...read(), permission: "candidate.*" })).reasonCode,
    ).toBe("PERMISSION_UNKNOWN");
    expect((await run({ ...read(), permission: "admin" })).reasonCode).toBe(
      "PERMISSION_UNKNOWN",
    );
  });
});

describe("authorization service: roles, assignments, and time", () => {
  it("denies a candidate requesting a staff permission", async () => {
    const { run } = setup();
    expect(
      (
        await run({
          ...read(),
          principal: {
            accountId: CANDIDATE,
            accountType: "CANDIDATE",
            sessionId: CANDIDATE_SESSION,
          },
        })
      ).reasonCode,
    ).toBe("PERMISSION_MISSING");
  });

  it("denies staff with no assignment and a role without the permission", async () => {
    const { run, assign } = setup();
    expect((await run(read())).reasonCode).toBe("PERMISSION_MISSING");
    assign("TRAINER_EVALUATOR", "ORGANIZATION", ORG);
    expect((await run(read())).reasonCode).toBe("PERMISSION_MISSING");
  });

  it("denies a future assignment and one at its exclusive end", async () => {
    const future = setup();
    future.assign("RECRUITER", "ORGANIZATION", ORG, {
      effectiveFrom: later(1),
    });
    expect((await future.run(read())).reasonCode).toBe("ASSIGNMENT_INACTIVE");

    const ending = setup();
    ending.assign("RECRUITER", "ORGANIZATION", ORG, { effectiveTo: NOW });
    expect((await ending.run(read())).reasonCode).toBe("ASSIGNMENT_INACTIVE");

    const justBefore = setup();
    justBefore.assign("RECRUITER", "ORGANIZATION", ORG, {
      effectiveTo: new Date(NOW.getTime() + 1),
    });
    expect((await justBefore.run(read())).decision).toBe("ALLOW");

    const starting = setup();
    starting.assign("RECRUITER", "ORGANIZATION", ORG, { effectiveFrom: NOW });
    expect((await starting.run(read())).decision).toBe("ALLOW");
  });

  it("denies revoked and superseded assignments and retired roles", async () => {
    for (const status of ["REVOKED", "SUPERSEDED", "PROPOSED"] as const) {
      const { run, assign } = setup();
      assign("RECRUITER", "ORGANIZATION", ORG, { status });
      expect((await run(read())).decision, status).toBe("DENY");
    }
    const retired = setup();
    retired.assign("RECRUITER", "ORGANIZATION", ORG);
    retired.facts.retiredRoles.add("RECRUITER");
    expect((await retired.run(read())).decision).toBe("DENY");
  });

  it("denies when the stored permission is retired or drifted from the manifest", async () => {
    const retired = setup();
    retired.assign("RECRUITER", "ORGANIZATION", ORG);
    retired.facts.permissionOverride = { status: "RETIRED" };
    expect((await retired.run(read())).reasonCode).toBe("POLICY_UNAVAILABLE");

    const widened = setup();
    widened.assign("RECRUITER", "ORGANIZATION", ORG);
    widened.facts.permissionOverride = {
      maxSensitivity: "RESTRICTED_SCREENING_MEDICAL",
    };
    expect((await widened.run(read())).reasonCode).toBe("POLICY_UNAVAILABLE");
    expect(widened.events.map((e) => e.code)).toContain(
      "authz.policy_unavailable",
    );

    const future = setup();
    future.assign("RECRUITER", "ORGANIZATION", ORG);
    future.facts.permissionOverride = { catalogVersion: 99 };
    expect((await future.run(read())).reasonCode).toBe("POLICY_UNAVAILABLE");
  });

  it("ignores a tampered grant condition and fails closed", async () => {
    const { run, facts, assign, events } = setup();
    assign("RECRUITER", "ORGANIZATION", ORG);
    facts.conditionOverride = { v: 1, kind: "EXPRESSION", expr: "true" };
    expect((await run(read())).reasonCode).toBe("POLICY_UNAVAILABLE");
    expect(events.map((e) => e.code)).toContain("authz.policy_unavailable");
  });

  it("allows with the effective role, assignment, scope, and policy version", async () => {
    const { run, assign } = setup();
    const assignmentId = assign("RECRUITER", "BRANCH", BRANCH);
    expect(await run(read())).toEqual({
      decision: "ALLOW",
      permissionCode: "candidate.read.assigned",
      effectiveRoleCode: "RECRUITER",
      effectiveAssignmentId: assignmentId,
      effectiveScopeType: "BRANCH",
      effectiveScopeReferenceId: BRANCH,
      policyVersion: AUTHORIZATION_POLICY_VERSION,
      reasonCode: "ALLOWED",
    });
  });

  it("selects the least-privileged sufficient assignment deterministically", async () => {
    const { run, assign } = setup();
    assign("PSA_MANAGER", "ORGANIZATION", ORG);
    const team = assign("RECRUITER", "TEAM", TEAM);
    assign("HR_SPECIALIST", "BRANCH", BRANCH);
    const decision = await run(read());
    expect(decision).toMatchObject({
      effectiveAssignmentId: team,
      effectiveScopeType: "TEAM",
    });
  });
});

describe("authorization service: scope", () => {
  it("denies the wrong branch and a cross-organization record", async () => {
    const { run, assign } = setup();
    assign("RECRUITER", "BRANCH", BRANCH);
    expect((await run(read(RECORD_BRANCH2))).reasonCode).toBe("SCOPE_MISMATCH");
    assign("RECRUITER", "ORGANIZATION", ORG);
    expect((await run(read(RECORD_ORG2))).reasonCode).toBe("SCOPE_MISMATCH");
  });

  it("denies when the record or scope cannot be resolved", async () => {
    const missing = setup();
    missing.assign("RECRUITER", "ORGANIZATION", ORG);
    expect((await missing.run(read(id(999)))).reasonCode).toBe(
      "SCOPE_MISMATCH",
    );

    const down = setup();
    down.assign("RECRUITER", "ORGANIZATION", ORG);
    down.resolver.unavailable = true;
    expect((await down.run(read())).reasonCode).toBe("SCOPE_UNAVAILABLE");

    const production = setup({
      ports: { resolver: new UnavailableScopeResolver() },
    });
    production.assign("RECRUITER", "ORGANIZATION", ORG);
    expect((await production.run(read())).reasonCode).toBe("SCOPE_UNAVAILABLE");

    const inactive = setup();
    inactive.assign("RECRUITER", "BRANCH", BRANCH);
    inactive.resolver.deactivate(BRANCH);
    expect((await inactive.run(read())).reasonCode).toBe("SCOPE_MISMATCH");

    const parentInactive = setup();
    parentInactive.assign("RECRUITER", "TEAM", TEAM);
    parentInactive.resolver.deactivate(ORG);
    expect((await parentInactive.run(read())).reasonCode).toBe(
      "SCOPE_MISMATCH",
    );
  });

  it("denies assigned-record scope without a current relationship", async () => {
    const { run, assign } = setup();
    assign("RECRUITER", "ASSIGNED_RECORDS", SET);
    expect((await run(read())).decision).toBe("ALLOW");
    expect((await run(read(RECORD_UNASSIGNED))).reasonCode).toBe(
      "SCOPE_MISMATCH",
    );
  });

  it("bounds the auditor by audit category and assignment period", async () => {
    const { run, assign, resolver } = setup();
    assign("AUDITOR_READ_ONLY", "AUDIT_ASSIGNMENT", AUDIT);
    expect((await run(read())).decision).toBe("ALLOW");
    expect(
      (
        await run({
          ...read(),
          permission: "screening.result.read_restricted",
          reasonCode: "AUDIT_SAMPLE",
          resource: {
            kind: "RECORD",
            id: RECORD,
            sensitivity: "RESTRICTED_SCREENING_MEDICAL",
          },
        })
      ).reasonCode,
    ).toBe("SCOPE_MISMATCH");
    resolver.deactivate(AUDIT);
    expect((await run(read())).reasonCode).toBe("SCOPE_MISMATCH");
  });

  it("does not let organization-wide administrator scope reach business records", async () => {
    const { run, assign } = setup();
    assign("SYSTEM_ADMINISTRATOR", "ORGANIZATION", ORG);
    expect((await run(read())).reasonCode).toBe("PERMISSION_MISSING");
    expect(
      (
        await run({
          ...read(),
          permission: "readiness.final_approval",
          operation: "APPROVE",
          reasonCode: "READY",
          workflow: {
            policy: "CANDIDACY_WORKFLOW",
            state: "FINAL_COMPLIANCE_REVIEW",
          },
          separation: { priorApproverAccountIds: [] },
        })
      ).reasonCode,
    ).toBe("PERMISSION_MISSING");
  });

  it("never broadens a narrow specialist permission through a wider general role", async () => {
    const { run, assign, facts } = setup();
    // Organization-wide recruiter + team-scoped compliance reviewer.
    assign("RECRUITER", "ORGANIZATION", ORG);
    assign("COMPLIANCE_REVIEWER", "TEAM", TEAM);
    facts.evidence.set(
      SESSION,
      staffEvidence({
        reauthentication: {
          at: ago(10),
          method: "PASSWORD_TOTP",
          purpose: "RESTRICTED_DATA_ACCESS",
        },
      }),
    );
    const restricted = (resource: string): AuthorizationRequest => ({
      principal: staff,
      permission: "screening.result.read_restricted",
      operation: "READ",
      reasonCode: "COMPLIANCE_REVIEW",
      resource: {
        kind: "RECORD",
        id: resource,
        sensitivity: "RESTRICTED_SCREENING_MEDICAL",
      },
    });
    expect((await run(restricted(RECORD))).decision).toBe("ALLOW");
    expect((await run(restricted(RECORD_BRANCH2))).reasonCode).toBe(
      "SCOPE_MISMATCH",
    );
  });

  it("evaluates designation, participant, and hold-category conditions", async () => {
    const { run, assign, resolver } = setup();
    assign("RECRUITER", "ORGANIZATION", ORG);
    const scorecard: AuthorizationRequest = {
      principal: staff,
      permission: "interview.scorecard.submit",
      operation: "CREATE",
      resource: {
        kind: "RECORD",
        id: RECORD,
        sensitivity: "CONFIDENTIAL_PERSONNEL",
      },
      workflow: { policy: "CANDIDACY_WORKFLOW", state: "ONBOARDING" },
    };
    expect((await run(scorecard)).reasonCode).toBe("CONDITION_UNMET");
    resolver.addRelationship(STAFF, RECORD, "INTERVIEWER");
    expect((await run(scorecard)).decision).toBe("ALLOW");

    const hr = setup();
    hr.assign("HR_SPECIALIST", "ORGANIZATION", ORG);
    const hold = (
      holdCategory?: "DOCUMENT" | "CLASSIFICATION",
    ): AuthorizationRequest => ({
      principal: staff,
      permission: "compliance_hold.place",
      operation: "CREATE",
      reasonCode: "MISSING_DOCUMENT",
      resource: {
        kind: "RECORD",
        id: RECORD,
        sensitivity: "CONFIDENTIAL_PERSONNEL",
      },
      workflow: { policy: "CANDIDACY_WORKFLOW", state: "ONBOARDING" },
      ...(holdCategory ? { holdCategory } : {}),
    });
    expect((await hr.run(hold("DOCUMENT"))).decision).toBe("ALLOW");
    expect((await hr.run(hold("CLASSIFICATION"))).reasonCode).toBe(
      "CONDITION_UNMET",
    );
    expect((await hr.run(hold())).reasonCode).toBe("CONDITION_UNMET");
  });
});

describe("authorization service: sensitivity, workflow, separation, assurance", () => {
  it("denies data more sensitive than the permission allows", async () => {
    const { run, assign } = setup();
    assign("RECRUITER", "ORGANIZATION", ORG);
    expect(
      (await run(read(RECORD, "RESTRICTED_SCREENING_MEDICAL"))).reasonCode,
    ).toBe("SENSITIVITY_DENIED");
  });

  const approveReadiness = (
    overrides: Partial<AuthorizationRequest> = {},
  ): AuthorizationRequest => ({
    principal: staff,
    permission: "readiness.final_approval",
    operation: "APPROVE",
    reasonCode: "ALL_REQUIREMENTS_MET",
    resource: {
      kind: "RECORD",
      id: RECORD,
      sensitivity: "CONFIDENTIAL_PERSONNEL",
    },
    workflow: {
      policy: "CANDIDACY_WORKFLOW",
      state: "FINAL_COMPLIANCE_REVIEW",
    },
    separation: { priorApproverAccountIds: [OTHER_STAFF] },
    ...overrides,
  });
  const strongNow = (purpose = "HIGH_RISK_APPROVAL", at = ago(10)) =>
    staffEvidence({
      reauthentication: { at, method: "PASSWORD_TOTP", purpose },
    });

  it("allows a fully satisfied high-risk approval", async () => {
    const { run, assign, facts } = setup();
    assign("COMPLIANCE_REVIEWER", "BRANCH", BRANCH);
    facts.evidence.set(SESSION, strongNow());
    expect(await run(approveReadiness())).toMatchObject({
      decision: "ALLOW",
      effectiveRoleCode: "COMPLIANCE_REVIEWER",
    });
  });

  it("denies unknown, missing, or disallowed workflow state", async () => {
    const { run, assign, facts } = setup();
    assign("COMPLIANCE_REVIEWER", "BRANCH", BRANCH);
    facts.evidence.set(SESSION, strongNow());
    expect(
      (await run(approveReadiness({ workflow: undefined }))).reasonCode,
    ).toBe("WORKFLOW_STATE_DENIED");
    expect(
      (
        await run(
          approveReadiness({
            workflow: { policy: "CANDIDACY_WORKFLOW", state: "MADE_UP" },
          }),
        )
      ).reasonCode,
    ).toBe("WORKFLOW_STATE_DENIED");
    expect(
      (
        await run(
          approveReadiness({
            workflow: { policy: "CANDIDACY_WORKFLOW", state: "WITHDRAWN" },
          }),
        )
      ).reasonCode,
    ).toBe("WORKFLOW_STATE_DENIED");
    const production = setup({ workflow: new Map() });
    production.assign("COMPLIANCE_REVIEWER", "BRANCH", BRANCH);
    production.facts.evidence.set(SESSION, strongNow());
    expect((await production.run(approveReadiness())).reasonCode).toBe(
      "POLICY_UNAVAILABLE",
    );
    // Workflow facts on a permission without a workflow policy are invalid.
    expect(
      (
        await run({
          ...read(),
          workflow: { policy: "CANDIDACY_WORKFLOW", state: "ONBOARDING" },
        })
      ).reasonCode,
    ).toBe("INVALID_CONTEXT");
  });

  it("denies missing separation facts, same-actor dual approval, and own records", async () => {
    const { run, assign, facts, resolver } = setup();
    assign("COMPLIANCE_REVIEWER", "BRANCH", BRANCH);
    facts.evidence.set(SESSION, strongNow());
    expect(
      (await run(approveReadiness({ separation: undefined }))).reasonCode,
    ).toBe("SEPARATION_FACTS_MISSING");
    expect(
      (
        await run(
          approveReadiness({
            separation: { priorApproverAccountIds: [STAFF] },
          }),
        )
      ).reasonCode,
    ).toBe("SEPARATION_CONFLICT");
    const own = id(50);
    resolver.addRecord(own, {
      organizationId: ORG,
      branchId: BRANCH,
      subjectAccountIds: [STAFF],
    });
    expect(
      (
        await run(
          approveReadiness({
            resource: {
              kind: "RECORD",
              id: own,
              sensitivity: "CONFIDENTIAL_PERSONNEL",
            },
          }),
        )
      ).reasonCode,
    ).toBe("SEPARATION_CONFLICT");
    expect((await run(read(own))).decision).toBe("DENY");
  });

  it("denies break-glass elevation for ordinary approvals", async () => {
    const { run, assign, facts } = setup();
    assign("COMPLIANCE_REVIEWER", "BRANCH", BRANCH);
    facts.evidence.set(SESSION, strongNow());
    expect(
      (await run(approveReadiness({ elevation: "BREAK_GLASS" }))).reasonCode,
    ).toBe("SEPARATION_CONFLICT");
  });

  it("requires bound, strong, purpose-specific recent authentication", async () => {
    const { run, assign, facts } = setup();
    assign("COMPLIANCE_REVIEWER", "BRANCH", BRANCH);
    // Old sign-in only.
    expect(await run(approveReadiness())).toMatchObject({
      reasonCode: "RECENT_AUTH_REQUIRED",
      challenge: "REAUTHENTICATION_REQUIRED",
    });
    // Wrong purpose.
    facts.evidence.set(SESSION, strongNow("CHANGE_PASSWORD"));
    expect((await run(approveReadiness())).reasonCode).toBe(
      "RECENT_AUTH_REQUIRED",
    );
    // Expired.
    facts.evidence.set(SESSION, strongNow("HIGH_RISK_APPROVAL", ago(300)));
    expect((await run(approveReadiness())).reasonCode).toBe(
      "RECENT_AUTH_REQUIRED",
    );
    // A fresh backup-code sign-in never satisfies a purpose-bound strong
    // policy: only password + TOTP step-up made for the purpose counts.
    facts.evidence.set(
      SESSION,
      staffEvidence({
        method: "PASSWORD_BACKUP_CODE",
        primaryAuthenticatedAt: ago(5),
        mfaAuthenticatedAt: ago(5),
      }),
    );
    expect(await run(approveReadiness())).toMatchObject({
      reasonCode: "RECENT_AUTH_REQUIRED",
      challenge: "REAUTHENTICATION_REQUIRED",
    });
    // Evidence belonging to another session/account does not count.
    facts.evidence.set(SESSION, { ...strongNow(), accountId: OTHER_STAFF });
    expect((await run(approveReadiness())).reasonCode).toBe("UNAUTHENTICATED");
  });

  it("never reuses step-up made before a privilege expansion", async () => {
    const { run, assign, facts } = setup();
    assign("COMPLIANCE_REVIEWER", "BRANCH", BRANCH, { effectiveFrom: ago(5) });
    facts.evidence.set(SESSION, strongNow("HIGH_RISK_APPROVAL", ago(30)));
    expect((await run(approveReadiness())).reasonCode).toBe(
      "RECENT_AUTH_REQUIRED",
    );
    facts.evidence.set(SESSION, strongNow("HIGH_RISK_APPROVAL", ago(2)));
    expect((await run(approveReadiness())).decision).toBe("ALLOW");
    facts.epoch = { authorizationVersion: 2, versionChangedAt: ago(1) };
    expect((await run(approveReadiness())).reasonCode).toBe(
      "RECENT_AUTH_REQUIRED",
    );
  });

  it("denies the recruiter role at readiness even with otherwise valid facts", async () => {
    const { run, assign, facts } = setup();
    assign("RECRUITER", "ORGANIZATION", ORG);
    facts.evidence.set(SESSION, strongNow());
    expect((await run(approveReadiness())).reasonCode).toBe(
      "PERMISSION_MISSING",
    );
  });

  it("requires the manager's designation for designated approvals", async () => {
    const { run, assign, facts, resolver } = setup();
    assign("PSA_MANAGER", "ORGANIZATION", ORG);
    facts.evidence.set(SESSION, strongNow());
    expect((await run(approveReadiness())).reasonCode).toBe("CONDITION_UNMET");
    resolver.addDesignation(STAFF, "READINESS_APPROVER", ORG);
    expect((await run(approveReadiness())).decision).toBe("ALLOW");
  });
});

describe("authorization service: candidates", () => {
  const candidate = {
    accountId: CANDIDATE,
    accountType: "CANDIDATE",
    sessionId: CANDIDATE_SESSION,
  };
  const own = (resource = RECORD): AuthorizationRequest => ({
    principal: candidate,
    permission: "candidate.own_profile.read",
    operation: "READ",
    resource: {
      kind: "RECORD",
      id: resource,
      sensitivity: "CONFIDENTIAL_PERSONNEL",
    },
  });

  it("denies all candidate business access until an ownership adapter exists", async () => {
    const { run } = setup({
      ports: { ownership: new UnavailableCandidateOwnership() },
    });
    expect((await run(own())).reasonCode).toBe("OWNERSHIP_UNAVAILABLE");
  });

  it("allows only the candidate's own record through the relationship", async () => {
    const { run } = setup();
    expect(await run(own())).toMatchObject({
      decision: "ALLOW",
      effectiveRoleCode: "CANDIDATE",
      effectiveAssignmentId: null,
    });
    expect((await run(own(RECORD_BRANCH2))).reasonCode).toBe("SCOPE_MISMATCH");
  });

  it("never lets staff use candidate-self permissions", async () => {
    const { run, assign } = setup();
    assign("PSA_MANAGER", "ORGANIZATION", ORG);
    expect((await run({ ...own(), principal: staff })).reasonCode).toBe(
      "PERMISSION_MISSING",
    );
  });
});

describe("authorization service: failure and telemetry", () => {
  it("turns unexpected failures into POLICY_UNAVAILABLE without leaking", async () => {
    const { run, facts, lines } = setup();
    facts.failing = true;
    expect(await run(read())).toEqual({
      decision: "DENY",
      permissionCode: "candidate.read.assigned",
      policyVersion: AUTHORIZATION_POLICY_VERSION,
      reasonCode: "POLICY_UNAVAILABLE",
    });
    expect(JSON.stringify(lines)).not.toMatch(/SELECT|secret|connection/);
  });

  it("logs safe denial codes and emits high-risk denial events without resource IDs", async () => {
    const { run, assign, events, lines } = setup();
    assign("COMPLIANCE_REVIEWER", "BRANCH", BRANCH);
    await run({
      principal: staff,
      permission: "readiness.final_approval",
      operation: "APPROVE",
      reasonCode: "ALL_REQUIREMENTS_MET",
      resource: {
        kind: "RECORD",
        id: RECORD,
        sensitivity: "CONFIDENTIAL_PERSONNEL",
      },
      workflow: {
        policy: "CANDIDACY_WORKFLOW",
        state: "FINAL_COMPLIANCE_REVIEW",
      },
      separation: { priorApproverAccountIds: [OTHER_STAFF] },
    });
    expect(events).toEqual([
      {
        code: "authz.high_risk_denied",
        actorRef: STAFF,
        permissionCode: "readiness.final_approval",
        reasonCode: "RECENT_AUTH_REQUIRED",
        policyVersion: AUTHORIZATION_POLICY_VERSION,
        correlationId: undefined,
      },
    ]);
    const output = JSON.stringify({ events, lines });
    for (const hidden of [RECORD, BRANCH, ORG, OTHER_STAFF, SESSION]) {
      expect(output).not.toContain(hidden);
    }
    expect(lines.at(-1)).toMatchObject({
      event: "authz.denied",
      context: {
        action: "readiness.final_approval",
        reasonCode: "RECENT_AUTH_REQUIRED",
      },
    });
  });
});

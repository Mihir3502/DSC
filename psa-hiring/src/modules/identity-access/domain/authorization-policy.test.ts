import { describe, expect, it } from "vitest";
import { isWellFormedRequest } from "./authorization-decision";
import { parseGrantCondition, canonicalCondition } from "./grant-condition";
import {
  compareLeastPrivilege,
  decideApproval,
  decideRejection,
  decideRevocation,
  findOverlap,
  intervalsOverlap,
  isEffectiveAt,
  validateProposal,
  type AssignmentSnapshot,
  type ProposalInput,
} from "./role-assignment";
import {
  isValidDescriptor,
  placementOfScope,
  scopeContains,
  sensitivityPermits,
  type ResourcePlacement,
  type ScopeDescriptor,
} from "./scope-policy";
import {
  administratorBusinessRule,
  auditSelfModificationRule,
  breakGlassRule,
  candidateSelfVerificationRule,
  classificationSelfApprovalRule,
  dualControlRule,
  exportApprovalRule,
  MandatorySeparationOfDutiesPolicy,
  offerSelfApprovalRule,
  ownRecordRule,
  readinessApprovalRule,
  restrictedResultEntrantRule,
  restrictiveDualControl,
  signedEvaluationRule,
  type SeparationInput,
} from "./separation-of-duties-policy";

// Pure authorization domain rules (packet M1.4 §9–§13). Synthetic UUIDs
// only; no database, framework, or real data.

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
const ACTOR = id(20);
const OTHER = id(21);
const THIRD = id(22);
const SUBJECT = id(23);
const t = (iso: string) => new Date(iso);

describe("grant conditions", () => {
  it("accepts only the closed v1 condition kinds", () => {
    expect(parseGrantCondition(null)).toBeNull();
    expect(parseGrantCondition({ v: 1, kind: "CANDIDATE_OWNERSHIP" })).toEqual({
      v: 1,
      kind: "CANDIDATE_OWNERSHIP",
    });
    expect(
      parseGrantCondition({
        v: 1,
        kind: "DESIGNATION",
        designation: "READINESS_APPROVER",
      }),
    ).toMatchObject({ kind: "DESIGNATION" });
    expect(
      parseGrantCondition({
        v: 1,
        kind: "HOLD_CATEGORY",
        categories: ["DOCUMENT"],
      }),
    ).toMatchObject({ kind: "HOLD_CATEGORY" });
  });

  it("rejects unknown kinds, keys, versions, and executable-looking data", () => {
    for (const bad of [
      { v: 2, kind: "CANDIDATE_OWNERSHIP" },
      { v: 1, kind: "ALLOW_ALL" },
      { v: 1, kind: "DESIGNATION", designation: "ANYONE" },
      {
        v: 1,
        kind: "DESIGNATION",
        designation: "READINESS_APPROVER",
        extra: true,
      },
      { v: 1, kind: "PARTICIPANT", relationship: "OWNER" },
      { v: 1, kind: "HOLD_CATEGORY", categories: [] },
      { v: 1, kind: "HOLD_CATEGORY", categories: ["DOCUMENT", "DOCUMENT"] },
      { v: 1, kind: "EXPRESSION", expr: "user.isAdmin || true" },
      "function () { return true }",
      ["CANDIDATE_OWNERSHIP"],
      42,
    ]) {
      expect(parseGrantCondition(bad)).toBe("INVALID");
    }
  });

  it("canonicalizes conditions deterministically", () => {
    expect(
      canonicalCondition({
        v: 1,
        kind: "HOLD_CATEGORY",
        categories: ["TRAINING_COMPETENCY", "DOCUMENT"],
      }),
    ).toBe(
      '{"v":1,"kind":"HOLD_CATEGORY","categories":["DOCUMENT","TRAINING_COMPETENCY"]}',
    );
    expect(canonicalCondition(null)).toBe("null");
  });
});

describe("assignment effective time", () => {
  const assignment = {
    status: "ACTIVE" as const,
    effectiveFrom: t("2026-10-06T12:00:00Z"),
    effectiveTo: t("2026-10-07T12:00:00Z"),
  };

  it("starts inclusively and ends exclusively", () => {
    expect(isEffectiveAt(assignment, t("2026-10-06T11:59:59.999Z"))).toBe(
      false,
    );
    expect(isEffectiveAt(assignment, t("2026-10-06T12:00:00Z"))).toBe(true);
    expect(isEffectiveAt(assignment, t("2026-10-07T11:59:59.999Z"))).toBe(true);
    expect(isEffectiveAt(assignment, t("2026-10-07T12:00:00Z"))).toBe(false);
  });

  it("never grants from a non-ACTIVE row", () => {
    for (const status of [
      "PROPOSED",
      "REJECTED",
      "REVOKED",
      "SUPERSEDED",
    ] as const) {
      expect(
        isEffectiveAt({ ...assignment, status }, t("2026-10-06T13:00:00Z")),
      ).toBe(false);
    }
  });

  it("detects half-open interval overlap, including open-ended ranges", () => {
    const a = {
      effectiveFrom: t("2026-01-01T00:00:00Z"),
      effectiveTo: t("2026-02-01T00:00:00Z"),
    };
    expect(
      intervalsOverlap(a, {
        effectiveFrom: t("2026-02-01T00:00:00Z"),
        effectiveTo: null,
      }),
    ).toBe(false);
    expect(
      intervalsOverlap(a, {
        effectiveFrom: t("2026-01-31T00:00:00Z"),
        effectiveTo: null,
      }),
    ).toBe(true);
    expect(
      intervalsOverlap(
        { ...a, effectiveTo: null },
        { effectiveFrom: t("2030-01-01T00:00:00Z"), effectiveTo: null },
      ),
    ).toBe(true);
  });
});

const snapshot = (
  overrides: Partial<AssignmentSnapshot> = {},
): AssignmentSnapshot => ({
  id: id(100),
  userAccountId: SUBJECT,
  roleCode: "RECRUITER",
  scopeType: "BRANCH",
  scopeReferenceId: BRANCH,
  effectiveFrom: t("2026-10-06T00:00:00Z"),
  effectiveTo: null,
  status: "PROPOSED",
  createdByUserId: OTHER,
  approvedByUserId: null,
  version: 1,
  ...overrides,
});

describe("assignment invariants", () => {
  const proposal = (overrides: Partial<ProposalInput> = {}): ProposalInput => ({
    actorAccountId: ACTOR,
    subject: { id: SUBJECT, accountType: "STAFF", status: "ACTIVE" },
    role: { code: "RECRUITER", principalType: "STAFF", status: "ACTIVE" },
    scopeType: "BRANCH",
    scopeReferenceId: BRANCH,
    effectiveFrom: t("2026-10-06T00:00:00Z"),
    effectiveTo: null,
    reasonCode: "NEW_ACCESS",
    reasonReference: "TICKET-1",
    ...overrides,
  });

  it("accepts a valid staff proposal", () => {
    expect(validateProposal(proposal())).toBeNull();
  });

  it("rejects candidates, restricted accounts, and missing subjects", () => {
    expect(
      validateProposal(
        proposal({
          subject: { id: SUBJECT, accountType: "CANDIDATE", status: "ACTIVE" },
        }),
      ),
    ).toBe("SUBJECT_NOT_STAFF");
    expect(
      validateProposal(
        proposal({
          subject: { id: SUBJECT, accountType: "STAFF", status: "DISABLED" },
        }),
      ),
    ).toBe("SUBJECT_NOT_STAFF");
    expect(validateProposal(proposal({ subject: null }))).toBe(
      "SUBJECT_NOT_STAFF",
    );
  });

  it("rejects self-grant", () => {
    expect(validateProposal(proposal({ actorAccountId: SUBJECT }))).toBe(
      "SELF_ADMINISTRATION",
    );
  });

  it("rejects the CANDIDATE role, retired roles, and missing roles", () => {
    expect(
      validateProposal(
        proposal({
          role: {
            code: "CANDIDATE",
            principalType: "CANDIDATE",
            status: "ACTIVE",
          },
        }),
      ),
    ).toBe("ROLE_UNAVAILABLE");
    expect(
      validateProposal(
        proposal({
          role: {
            code: "RECRUITER",
            principalType: "STAFF",
            status: "RETIRED",
          },
        }),
      ),
    ).toBe("ROLE_UNAVAILABLE");
    expect(validateProposal(proposal({ role: null }))).toBe("ROLE_UNAVAILABLE");
  });

  it("rejects scope types outside the role's allowed set", () => {
    expect(
      validateProposal(
        proposal({
          role: {
            code: "SYSTEM_ADMINISTRATOR",
            principalType: "STAFF",
            status: "ACTIVE",
          },
        }),
      ),
    ).toBe("SCOPE_NOT_ALLOWED_FOR_ROLE");
    expect(
      validateProposal(
        proposal({
          role: {
            code: "AUDITOR_READ_ONLY",
            principalType: "STAFF",
            status: "ACTIVE",
          },
          scopeType: "ORGANIZATION",
        }),
      ),
    ).toBe("SCOPE_NOT_ALLOWED_FOR_ROLE");
    expect(validateProposal(proposal({ scopeType: "AUDIT_ASSIGNMENT" }))).toBe(
      "SCOPE_NOT_ALLOWED_FOR_ROLE",
    );
  });

  it("requires a scope reference, valid dates, and coded reasons", () => {
    expect(validateProposal(proposal({ scopeReferenceId: "branch-1" }))).toBe(
      "SCOPE_UNRESOLVED",
    );
    expect(
      validateProposal(proposal({ effectiveTo: t("2026-10-06T00:00:00Z") })),
    ).toBe("INVALID_DATES");
    expect(
      validateProposal(proposal({ effectiveTo: t("2026-10-05T00:00:00Z") })),
    ).toBe("INVALID_DATES");
    expect(
      validateProposal(proposal({ effectiveFrom: new Date(Number.NaN) })),
    ).toBe("INVALID_DATES");
    expect(
      validateProposal(proposal({ reasonCode: "because I said so" })),
    ).toBe("INVALID_REASON");
    expect(
      validateProposal(proposal({ reasonReference: "Free text with spaces" })),
    ).toBe("INVALID_REASON");
  });

  it("rejects overlapping equivalent pending/active assignments", () => {
    const existing = [snapshot({ status: "ACTIVE" })];
    const candidate = { ...snapshot(), id: id(101) };
    expect(findOverlap(candidate, existing)?.id).toBe(id(100));
    expect(findOverlap(candidate, existing, [id(100)])).toBeNull();
    expect(
      findOverlap(candidate, [snapshot({ status: "REVOKED" })]),
    ).toBeNull();
    expect(
      findOverlap({ ...candidate, scopeReferenceId: BRANCH2 }, existing),
    ).toBeNull();
  });

  it("approves only by a distinct, non-requesting approver at the current version", () => {
    const now = t("2026-10-06T12:00:00Z");
    expect(decideApproval(snapshot(), ACTOR, 1, now)).toBeNull();
    expect(decideApproval(snapshot(), SUBJECT, 1, now)).toBe(
      "SELF_ADMINISTRATION",
    );
    expect(decideApproval(snapshot(), OTHER, 1, now)).toBe("APPROVER_CONFLICT");
    expect(decideApproval(snapshot(), ACTOR, 2, now)).toBe("STALE_VERSION");
    expect(decideApproval(snapshot({ status: "ACTIVE" }), ACTOR, 1, now)).toBe(
      "INVALID_STATE",
    );
    expect(
      decideApproval(
        snapshot({ effectiveTo: t("2026-10-06T12:00:00Z") }),
        ACTOR,
        1,
        now,
      ),
    ).toBe("ALREADY_ENDED");
  });

  it("revokes only ACTIVE rows, never by the subject, never reactivates", () => {
    const active = snapshot({
      status: "ACTIVE",
      approvedByUserId: ACTOR,
      version: 2,
    });
    expect(decideRevocation(active, THIRD, 2, "ACCESS_REVIEW")).toBeNull();
    expect(decideRevocation(active, SUBJECT, 2, "ACCESS_REVIEW")).toBe(
      "SELF_ADMINISTRATION",
    );
    expect(decideRevocation(active, THIRD, 2, "SUPERSEDED")).toBe(
      "INVALID_REASON",
    );
    expect(decideRevocation(active, THIRD, 2, "free text")).toBe(
      "INVALID_REASON",
    );
    expect(decideRevocation(active, THIRD, 1, "ACCESS_REVIEW")).toBe(
      "STALE_VERSION",
    );
    for (const status of [
      "REVOKED",
      "SUPERSEDED",
      "REJECTED",
      "PROPOSED",
    ] as const) {
      expect(
        decideRevocation({ ...active, status }, THIRD, 2, "ACCESS_REVIEW"),
      ).toBe("INVALID_STATE");
    }
    expect(decideRejection(snapshot(), SUBJECT, 1, "PROPOSAL_REJECTED")).toBe(
      "SELF_ADMINISTRATION",
    );
    expect(
      decideRejection(snapshot(), ACTOR, 1, "PROPOSAL_REJECTED"),
    ).toBeNull();
  });

  it("orders candidate assignments by least privilege deterministically", () => {
    const rows = [
      {
        id: id(3),
        scopeType: "ORGANIZATION" as const,
        roleCode: "PSA_MANAGER" as const,
      },
      { id: id(2), scopeType: "TEAM" as const, roleCode: "RECRUITER" as const },
      {
        id: id(1),
        scopeType: "TEAM" as const,
        roleCode: "HR_SPECIALIST" as const,
      },
      {
        id: id(4),
        scopeType: "ASSIGNED_RECORDS" as const,
        roleCode: "RECRUITER" as const,
      },
    ];
    expect([...rows].sort(compareLeastPrivilege).map((r) => r.id)).toEqual([
      id(4),
      id(1),
      id(2),
      id(3),
    ]);
  });
});

describe("scope containment", () => {
  const record = (
    overrides: Partial<ResourcePlacement> = {},
  ): ResourcePlacement => ({
    organizationId: ORG,
    branchId: BRANCH,
    teamId: TEAM,
    assignmentSetIds: [SET],
    recordGroupIds: [GROUP],
    recordedAt: t("2026-03-01T00:00:00Z"),
    subjectAccountIds: [SUBJECT],
    ...overrides,
  });
  const ctx = {
    actorAccountId: ACTOR,
    category: "CONFIDENTIAL_PERSONNEL" as const,
  };
  const org: ScopeDescriptor = {
    type: "ORGANIZATION",
    id: ORG,
    organizationId: ORG,
  };
  const branch: ScopeDescriptor = {
    type: "BRANCH",
    id: BRANCH,
    organizationId: ORG,
  };
  const team: ScopeDescriptor = {
    type: "TEAM",
    id: TEAM,
    organizationId: ORG,
    branchId: BRANCH,
  };
  const set: ScopeDescriptor = {
    type: "ASSIGNED_RECORDS",
    id: SET,
    organizationId: ORG,
  };
  const audit: ScopeDescriptor = {
    type: "AUDIT_ASSIGNMENT",
    id: AUDIT,
    organizationId: ORG,
    auditorAccountId: ACTOR,
    categories: ["CONFIDENTIAL_PERSONNEL"],
    recordGroupIds: [GROUP],
    recordsFrom: t("2026-01-01T00:00:00Z"),
    recordsTo: t("2026-07-01T00:00:00Z"),
  };

  it("contains records along the proven hierarchy", () => {
    for (const scope of [org, branch, team, set, audit]) {
      expect(scopeContains(scope, record(), ctx), scope.type).toBe(true);
    }
  });

  it("never crosses organizations, whatever the other IDs say", () => {
    for (const scope of [org, branch, team, set, audit]) {
      expect(scopeContains(scope, record({ organizationId: ORG2 }), ctx)).toBe(
        false,
      );
    }
  });

  it("denies wrong branch/team and absent assigned-record membership", () => {
    expect(
      scopeContains(branch, record({ branchId: BRANCH2, teamId: null }), ctx),
    ).toBe(false);
    expect(scopeContains(team, record({ teamId: null }), ctx)).toBe(false);
    expect(scopeContains(team, record({ branchId: BRANCH2 }), ctx)).toBe(false);
    expect(scopeContains(set, record({ assignmentSetIds: [] }), ctx)).toBe(
      false,
    );
  });

  it("bounds audit scope by auditor, category, record group, and dates", () => {
    expect(
      scopeContains(audit, record(), { ...ctx, actorAccountId: OTHER }),
    ).toBe(false);
    expect(
      scopeContains(audit, record(), {
        ...ctx,
        category: "RESTRICTED_SCREENING_MEDICAL",
      }),
    ).toBe(false);
    expect(
      scopeContains(audit, record({ recordGroupIds: [id(99)] }), ctx),
    ).toBe(false);
    expect(scopeContains(audit, record({ recordedAt: null }), ctx)).toBe(false);
    expect(
      scopeContains(
        audit,
        record({ recordedAt: t("2026-01-01T00:00:00Z") }),
        ctx,
      ),
    ).toBe(true);
    expect(
      scopeContains(
        audit,
        record({ recordedAt: t("2026-07-01T00:00:00Z") }),
        ctx,
      ),
    ).toBe(false);
  });

  it("fails closed on malformed placements and descriptors", () => {
    expect(scopeContains(org, record({ organizationId: "org-1" }), ctx)).toBe(
      false,
    );
    expect(scopeContains(team, record({ branchId: null }), ctx)).toBe(false);
    expect(isValidDescriptor(branch, "TEAM", BRANCH)).toBe(false);
    expect(isValidDescriptor(branch, "BRANCH", id(77))).toBe(false);
    expect(
      isValidDescriptor(
        { type: "ORGANIZATION", id: ORG, organizationId: ORG2 },
        "ORGANIZATION",
        ORG,
      ),
    ).toBe(false);
    expect(
      isValidDescriptor(
        { ...audit, categories: [] } as ScopeDescriptor,
        "AUDIT_ASSIGNMENT",
        AUDIT,
      ),
    ).toBe(false);
  });

  it("places administrative scope targets so admins cannot grant beyond their scope", () => {
    const branchTarget = placementOfScope(branch);
    expect(scopeContains(org, branchTarget, ctx)).toBe(true);
    expect(scopeContains(branch, branchTarget, ctx)).toBe(true);
    expect(scopeContains(team, branchTarget, ctx)).toBe(false);
    expect(scopeContains(branch, placementOfScope(org), ctx)).toBe(false);
  });

  it("treats maximum sensitivity as an upper bound with exact restricted matching", () => {
    expect(sensitivityPermits("CONFIDENTIAL_PERSONNEL", "INTERNAL")).toBe(true);
    expect(sensitivityPermits("INTERNAL", "CONFIDENTIAL_PERSONNEL")).toBe(
      false,
    );
    expect(
      sensitivityPermits(
        "RESTRICTED_SCREENING_MEDICAL",
        "RESTRICTED_IDENTITY_FINANCIAL",
      ),
    ).toBe(false);
    expect(
      sensitivityPermits(
        "RESTRICTED_SCREENING_MEDICAL",
        "RESTRICTED_SCREENING_MEDICAL",
      ),
    ).toBe(true);
    expect(sensitivityPermits("RESTRICTED_SCREENING_MEDICAL", "INTERNAL")).toBe(
      false,
    );
    expect(sensitivityPermits("CONFIDENTIAL_PERSONNEL", "TOP_SECRET")).toBe(
      false,
    );
  });
});

describe("separation of duties", () => {
  const input = (
    overrides: Partial<SeparationInput> = {},
  ): SeparationInput => ({
    actorAccountId: ACTOR,
    actorPrincipalType: "STAFF",
    effectiveRoleCode: "COMPLIANCE_REVIEWER",
    operation: "APPROVE",
    permissionDomain: "BUSINESS",
    policy: null,
    dualControlHook: null,
    subjectAccountIds: [SUBJECT],
    facts: {},
    elevation: "NONE",
    dualControl: restrictiveDualControl,
    ...overrides,
  });
  const policy = new MandatorySeparationOfDutiesPolicy();

  it("rule 1: no self-approval of a classification proposal", () => {
    expect(
      classificationSelfApprovalRule(
        input({ facts: { proposerAccountId: ACTOR } }),
      ),
    ).toMatchObject({
      kind: "DENY",
      reason: "SEPARATION_CONFLICT",
    });
    expect(classificationSelfApprovalRule(input())).toMatchObject({
      reason: "SEPARATION_FACTS_MISSING",
    });
    expect(
      classificationSelfApprovalRule(
        input({ facts: { proposerAccountId: OTHER } }),
      ),
    ).toEqual({
      kind: "PASS",
    });
  });

  it("rule 2: a candidate never verifies their own result", () => {
    expect(
      candidateSelfVerificationRule(input({ actorPrincipalType: "CANDIDATE" }))
        .kind,
    ).toBe("DENY");
    expect(
      candidateSelfVerificationRule(input({ subjectAccountIds: [ACTOR] })).kind,
    ).toBe("DENY");
    expect(
      candidateSelfVerificationRule(input({ subjectAccountIds: null })),
    ).toMatchObject({
      reason: "SEPARATION_FACTS_MISSING",
    });
  });

  it("rule 3: the restricted-result entrant does not decide disposition under dual review", () => {
    expect(
      restrictedResultEntrantRule(
        input({ facts: { resultEnteredByAccountId: ACTOR } }),
      ).kind,
    ).toBe("DENY");
    expect(restrictedResultEntrantRule(input()).kind).toBe("DENY");
    expect(
      restrictedResultEntrantRule(
        input({
          facts: { resultEnteredByAccountId: ACTOR },
          dualControl: {
            ...restrictiveDualControl,
            HIGH_RISK_SCREENING_DISPOSITION: { required: false },
          },
        }),
      ).kind,
    ).toBe("PASS");
  });

  it("rule 4: a signed evaluation is never edited in place", () => {
    expect(
      signedEvaluationRule(
        input({ operation: "EDIT", facts: { evaluationSigned: true } }),
      ).kind,
    ).toBe("DENY");
    expect(
      signedEvaluationRule(
        input({ operation: "EDIT", facts: { evaluationSigned: false } }),
      ).kind,
    ).toBe("PASS");
    expect(signedEvaluationRule(input({ operation: "EDIT" }))).toMatchObject({
      reason: "SEPARATION_FACTS_MISSING",
    });
  });

  it("rule 5: an administrator never makes business decisions", () => {
    expect(
      administratorBusinessRule(
        input({ effectiveRoleCode: "SYSTEM_ADMINISTRATOR" }),
      ).kind,
    ).toBe("DENY");
    expect(
      administratorBusinessRule(
        input({
          effectiveRoleCode: "SYSTEM_ADMINISTRATOR",
          permissionDomain: "TECHNICAL",
          operation: "ADMINISTER",
        }),
      ).kind,
    ).toBe("PASS");
  });

  it("rule 6: no self-approval of a compensation/offer change", () => {
    expect(
      offerSelfApprovalRule(input({ facts: { changedByAccountIds: [ACTOR] } }))
        .kind,
    ).toBe("DENY");
    expect(
      offerSelfApprovalRule(input({ facts: { changedByAccountIds: [] } })),
    ).toMatchObject({
      reason: "SEPARATION_FACTS_MISSING",
    });
    expect(
      offerSelfApprovalRule(input({ facts: { changedByAccountIds: [OTHER] } }))
        .kind,
    ).toBe("PASS");
  });

  it("rule 7: readiness is never approved by a candidate or a recruiter role", () => {
    expect(
      readinessApprovalRule(input({ effectiveRoleCode: "RECRUITER" })).kind,
    ).toBe("DENY");
    expect(
      readinessApprovalRule(input({ actorPrincipalType: "CANDIDATE" })).kind,
    ).toBe("DENY");
    expect(readinessApprovalRule(input()).kind).toBe("PASS");
  });

  it("rule 8: staff never act on their own candidacy/worker file", () => {
    expect(ownRecordRule(input({ subjectAccountIds: [ACTOR] })).kind).toBe(
      "DENY",
    );
    expect(
      ownRecordRule(input({ subjectAccountIds: ["not-a-uuid"] })),
    ).toMatchObject({
      reason: "SEPARATION_FACTS_MISSING",
    });
    expect(ownRecordRule(input({ subjectAccountIds: null })).kind).toBe("PASS");
  });

  it("rule 9: nobody modifies audit records documenting themselves", () => {
    expect(
      auditSelfModificationRule(
        input({ facts: { documentedActorAccountIds: [ACTOR] } }),
      ).kind,
    ).toBe("DENY");
    expect(auditSelfModificationRule(input())).toMatchObject({
      reason: "SEPARATION_FACTS_MISSING",
    });
  });

  it("rule 10: break-glass never performs ordinary workflow actions", () => {
    expect(breakGlassRule(input({ elevation: "BREAK_GLASS" })).kind).toBe(
      "DENY",
    );
    expect(
      breakGlassRule(input({ elevation: "BREAK_GLASS", operation: "READ" }))
        .kind,
    ).toBe("DENY");
    expect(breakGlassRule(input()).kind).toBe("PASS");
  });

  it("dual control compares immutable IDs and needs explicit prior approvers", () => {
    const base = input({ dualControlHook: "FINAL_READINESS" });
    expect(dualControlRule(base)).toMatchObject({
      reason: "SEPARATION_FACTS_MISSING",
    });
    expect(
      dualControlRule({ ...base, facts: { priorApproverAccountIds: [] } }).kind,
    ).toBe("PASS");
    expect(
      dualControlRule({ ...base, facts: { priorApproverAccountIds: [ACTOR] } }),
    ).toMatchObject({
      reason: "SEPARATION_CONFLICT",
    });
    expect(
      dualControlRule({
        ...base,
        facts: { priorApproverAccountIds: [OTHER], proposerAccountId: ACTOR },
      }).kind,
    ).toBe("DENY");
    expect(
      dualControlRule({
        ...base,
        facts: {},
        dualControl: {
          ...restrictiveDualControl,
          FINAL_READINESS: { required: false },
        },
      }).kind,
    ).toBe("PASS");
  });

  it("export requires a recorded approval by someone else", () => {
    expect(exportApprovalRule(input())).toMatchObject({
      reason: "SEPARATION_FACTS_MISSING",
    });
    expect(
      exportApprovalRule(input({ facts: { priorApproverAccountIds: [ACTOR] } }))
        .kind,
    ).toBe("DENY");
    expect(
      exportApprovalRule(input({ facts: { priorApproverAccountIds: [OTHER] } }))
        .kind,
    ).toBe("PASS");
  });

  it("the mandatory policy composes generic, named, and dual-control rules", () => {
    expect(policy.evaluate(input()).kind).toBe("PASS");
    expect(
      policy.evaluate(input({ subjectAccountIds: [ACTOR] })),
    ).toMatchObject({
      rule: "OWN_RECORD",
    });
    expect(
      policy.evaluate(
        input({ policy: "READINESS_APPROVAL", effectiveRoleCode: "RECRUITER" }),
      ),
    ).toMatchObject({ rule: "READINESS_APPROVAL" });
    expect(
      policy.evaluate(
        input({
          dualControlHook: "CLASSIFICATION_DECISION",
          facts: { priorApproverAccountIds: [ACTOR] },
        }),
      ),
    ).toMatchObject({ rule: "DUAL_CONTROL" });
  });
});

describe("authorization request contract", () => {
  const valid = {
    principal: { accountId: ACTOR, accountType: "STAFF", sessionId: OTHER },
    permission: "candidate.read.assigned",
    operation: "READ",
    resource: {
      kind: "RECORD",
      id: SUBJECT,
      sensitivity: "CONFIDENTIAL_PERSONNEL",
    },
  };

  it("accepts the typed contract", () => {
    expect(isWellFormedRequest(valid)).toBe(true);
    expect(
      isWellFormedRequest({
        ...valid,
        workflow: { policy: "CANDIDACY_WORKFLOW", state: "ONBOARDING" },
        separation: { priorApproverAccountIds: [OTHER] },
        holdCategory: "DOCUMENT",
        elevation: "NONE",
        reasonCode: "ROUTINE_REVIEW",
      }),
    ).toBe(true);
  });

  it("rejects request-supplied roles, scopes, approvers, assurance, or decisions", () => {
    for (const extra of [
      { roles: ["PSA_MANAGER"] },
      { scopes: [{ type: "ORGANIZATION", id: ORG }] },
      { isAdmin: true },
      { assurance: { method: "PASSWORD_TOTP", at: new Date() } },
      { decision: "ALLOW" },
      { policyVersion: "authz-p9-c9" },
      { accountStatus: "ACTIVE" },
      { organizationId: ORG },
    ]) {
      expect(
        isWellFormedRequest({ ...valid, ...extra }),
        Object.keys(extra)[0],
      ).toBe(false);
    }
    expect(
      isWellFormedRequest({
        ...valid,
        resource: { ...valid.resource, organizationId: ORG },
      }),
    ).toBe(false);
  });

  it("rejects malformed resources, workflow facts, and separation facts", () => {
    expect(
      isWellFormedRequest({
        ...valid,
        resource: { kind: "RECORD", id: "1", sensitivity: "INTERNAL" },
      }),
    ).toBe(false);
    expect(
      isWellFormedRequest({
        ...valid,
        resource: { ...valid.resource, sensitivity: "SECRET" },
      }),
    ).toBe(false);
    expect(isWellFormedRequest({ ...valid, operation: "DELETE" })).toBe(false);
    expect(
      isWellFormedRequest({
        ...valid,
        workflow: { policy: "ANY", state: "X" },
      }),
    ).toBe(false);
    expect(
      isWellFormedRequest({
        ...valid,
        workflow: { policy: "CANDIDACY_WORKFLOW", state: "drop table" },
      }),
    ).toBe(false);
    expect(
      isWellFormedRequest({
        ...valid,
        separation: { proposerAccountId: "me" },
      }),
    ).toBe(false);
    expect(
      isWellFormedRequest({ ...valid, separation: { approvedBy: [OTHER] } }),
    ).toBe(false);
    expect(
      isWellFormedRequest({ ...valid, reasonCode: "free text reason" }),
    ).toBe(false);
    expect(
      isWellFormedRequest({
        ...valid,
        principal: { accountId: "x", accountType: "STAFF", sessionId: OTHER },
      }),
    ).toBe(false);
    expect(isWellFormedRequest(null)).toBe(false);
  });
});

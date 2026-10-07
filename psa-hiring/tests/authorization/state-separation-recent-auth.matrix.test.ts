import { describe, expect, it } from "vitest";
import type { AuthorizationRequest } from "@/modules/identity-access/domain/authorization-decision";
import type { RoleCode } from "@/modules/identity-access/domain/authorization-vocabulary";
import {
  administratorBusinessRule,
  auditSelfModificationRule,
  readinessApprovalRule,
  restrictiveDualControl,
  separationRules,
  type SeparationFacts,
  type SeparationInput,
} from "@/modules/identity-access/domain/separation-of-duties-policy";
import {
  findPermission,
  permissionCatalog,
} from "@/modules/identity-access/policy/permission-catalog";
import {
  account,
  expectAllow,
  expectDeny,
  matrixWorld,
  satisfyingRequest,
  sessionOf,
  staffSession,
  validSeparation,
  workflowStates,
  type MatrixWorld,
} from "../fixtures/authorization/matrix-harness";
import { at, record, scope } from "../fixtures/scopes";

// M1.7 §9.4, §14, §15: workflow states, every separation-of-duties rule,
// and recent-authentication strength/freshness/binding, through the real
// decision pipeline with a controlled clock (the injected deps.clock and
// fixed evidence times; no sleeps). Future workflows are synthetic policy
// fixtures only (§14: no hiring aggregates).

const decide = async (
  role: RoleCode,
  code: string,
  mutate: (r: AuthorizationRequest, w: MatrixWorld) => AuthorizationRequest = (
    r,
  ) => r,
  world: MatrixWorld = matrixWorld(),
) => {
  const request = satisfyingRequest(world, role, findPermission(code)!);
  return world.decide(mutate(request, world));
};

// ------------------------------------------------------------ §14 workflow

describe("workflow state (§14)", () => {
  const WORKFLOW = "selection.decide";

  it.each([
    ...workflowStates.allowed.map((s) => [s, "ALLOW"] as const),
    ...workflowStates.disallowed.map(
      (s) => [s, "WORKFLOW_STATE_DENIED"] as const,
    ),
    ...workflowStates.terminal.map(
      (s) => [s, "WORKFLOW_STATE_DENIED"] as const,
    ),
    ...workflowStates.superseded.map(
      (s) => [s, "WORKFLOW_STATE_DENIED"] as const,
    ),
    ["NOT_A_STATE", "WORKFLOW_STATE_DENIED"] as const,
  ])("workflow state %s → %s", async (state, outcome) => {
    const decision = await decide("RECRUITER", WORKFLOW, (r) => ({
      ...r,
      workflow: { policy: "CANDIDACY_WORKFLOW", state },
    }));
    if (outcome === "ALLOW") expectAllow(decision, "RECRUITER");
    else expectDeny(decision, outcome);
  });

  it("workflow state facts: missing, malformed, or client-shaped facts deny", async () => {
    expectDeny(
      await decide("RECRUITER", WORKFLOW, (r) => {
        const copy = { ...r };
        delete (copy as { workflow?: unknown }).workflow;
        return copy;
      }),
      "WORKFLOW_STATE_DENIED",
    );
    for (const workflow of [
      { policy: "CANDIDACY_WORKFLOW", state: "OPEN", permitted: true },
      { policy: "OTHER_WORKFLOW", state: "OPEN" },
      { policy: "CANDIDACY_WORKFLOW", state: "open; DROP" },
    ]) {
      expectDeny(
        await decide(
          "RECRUITER",
          WORKFLOW,
          (r) => ({ ...r, workflow }) as never,
        ),
      );
    }
    // Workflow facts on a permission with no workflow policy are a contract error.
    expectDeny(
      await decide("RECRUITER", "candidate.read.assigned", (r) => ({
        ...r,
        workflow: { policy: "CANDIDACY_WORKFLOW", state: "OPEN" },
      })),
      "INVALID_CONTEXT",
    );
  });

  it("workflow state with no registered policy (production M1) fails closed", async () => {
    const world = matrixWorld({ workflow: new Map() });
    expectDeny(
      await decide("RECRUITER", WORKFLOW, undefined, world),
      "POLICY_UNAVAILABLE",
    );
  });
});

// ----------------------------------------------------------- §15 separation

type RuleCase = Readonly<{
  rule: string;
  role: RoleCode;
  permission: string;
  same: (actor: string) => Partial<SeparationFacts> | { record: string };
  /** Control variant where the conflicting fact points elsewhere. */
  swapped?: Partial<SeparationFacts>;
  missing:
    Partial<Record<keyof SeparationFacts, undefined>> | { record: string };
}>;

const ruleCases: readonly RuleCase[] = [
  {
    rule: "CLASSIFICATION_SELF_APPROVAL",
    role: "CLASSIFICATION_REVIEWER",
    permission: "classification.review.decide",
    same: (actor) => ({ proposerAccountId: actor }),
    missing: { proposerAccountId: undefined },
  },
  {
    rule: "CANDIDATE_SELF_VERIFICATION",
    role: "TRAINER_EVALUATOR",
    permission: "training.result.record",
    same: () => ({ record: record.OWN_FILE }),
    missing: { record: record.NONEXISTENT },
  },
  {
    rule: "RESTRICTED_RESULT_ENTRANT",
    role: "COMPLIANCE_REVIEWER",
    permission: "screening.disposition.decide",
    same: (actor) => ({ resultEnteredByAccountId: actor }),
    missing: { resultEnteredByAccountId: undefined },
  },
  {
    rule: "SIGNED_EVALUATION_IMMUTABLE",
    role: "TRAINER_EVALUATOR",
    permission: "competency.evaluation.edit",
    // Not an actor fact: signed is immutable for everyone; unsigned edits.
    same: () => ({ evaluationSigned: true }),
    swapped: { evaluationSigned: false },
    missing: { evaluationSigned: undefined },
  },
  {
    rule: "OFFER_SELF_APPROVAL",
    role: "PSA_MANAGER",
    permission: "compensation.approve",
    same: (actor) => ({ changedByAccountIds: [actor] }),
    missing: { changedByAccountIds: undefined },
  },
  {
    rule: "EXPORT_APPROVAL",
    role: "PSA_MANAGER",
    permission: "record.export.standard",
    same: (actor) => ({ priorApproverAccountIds: [actor] }),
    missing: { priorApproverAccountIds: undefined },
  },
  {
    rule: "DUAL_CONTROL",
    role: "CLASSIFICATION_REVIEWER",
    permission: "classification.review.decide",
    same: (actor) => ({
      priorApproverAccountIds: [account.OTHER_STAFF, actor],
    }),
    missing: { priorApproverAccountIds: undefined },
  },
  {
    rule: "OWN_RECORD",
    role: "RECRUITER",
    permission: "candidate.read.assigned",
    same: () => ({ record: record.OWN_FILE }),
    missing: { record: record.NONEXISTENT },
  },
];

function applyFacts(
  r: AuthorizationRequest,
  change: Partial<SeparationFacts> | { record: string },
): AuthorizationRequest {
  if ("record" in change) {
    return { ...r, resource: { ...r.resource, id: change.record as string } };
  }
  const separation = { ...r.separation, ...change } as Record<string, unknown>;
  for (const key of Object.keys(separation)) {
    if (separation[key] === undefined) delete separation[key];
  }
  return { ...r, separation: separation as SeparationFacts };
}

describe("separation of duties (§15)", () => {
  it("every named policy in use is exercised, and every defined rule is tested", () => {
    const used = new Set(
      permissionCatalog.flatMap((p) => [
        p.separationPolicy,
        p.dualControlHook && "DUAL_CONTROL",
      ]),
    );
    const covered = new Set(ruleCases.map((c) => c.rule));
    for (const rule of used)
      if (rule)
        expect(covered.has(rule) || rule === "READINESS_APPROVAL", rule).toBe(
          true,
        );
    // Rule-level coverage for rules with no engine path below.
    expect([...separationRules].sort()).toEqual(
      [
        ...covered,
        "READINESS_APPROVAL",
        "ADMIN_BUSINESS_DECISION",
        "BREAK_GLASS_ORDINARY_WORKFLOW",
        "AUDIT_SELF_MODIFICATION",
      ].sort(),
    );
  });

  it.each(ruleCases.map((c) => [c.rule, c] as const))(
    "separation rule %s: different actor allows; same actor, missing facts, and multi-role deny",
    async (_rule, c) => {
      // Valid different-actor control.
      expectAllow(await decide(c.role, c.permission), c.role);
      // Same actor (immutable account ID, not a display name).
      expectDeny(
        await decide(c.role, c.permission, (r) =>
          applyFacts(r, c.same(account.ACTOR)),
        ),
        c.rule === "OWN_RECORD" || c.rule === "CANDIDATE_SELF_VERIFICATION"
          ? "SEPARATION_CONFLICT"
          : "SEPARATION_CONFLICT",
      );
      // Missing facts deny (never default to allow).
      const missing = await decide(c.role, c.permission, (r) =>
        applyFacts(r, c.missing),
      );
      expectDeny(missing);
      // Swapped IDs: the other party is someone else → allowed.
      expectAllow(
        await decide(c.role, c.permission, (r) =>
          applyFacts(
            r,
            c.swapped ??
              ("record" in c.same(account.ACTOR)
                ? { record: record.IN_TEAM }
                : c.same(account.OTHER_AUDITOR)),
          ),
        ),
        c.role,
      );
      // Multi-role: a second role holding the same grant cannot bypass it.
      const world = matrixWorld();
      world.assign(account.ACTOR, "PSA_MANAGER", "TEAM", scope.TEAM);
      world.assign(
        account.ACTOR,
        "COMPLIANCE_REVIEWER",
        "BRANCH",
        scope.BRANCH,
      );
      expectDeny(
        await decide(
          c.role,
          c.permission,
          (r) => applyFacts(r, c.same(account.ACTOR)),
          world,
        ),
      );
    },
  );

  const input = (over: Partial<SeparationInput>): SeparationInput => ({
    actorAccountId: account.ACTOR,
    actorPrincipalType: "STAFF",
    effectiveRoleCode: "PSA_MANAGER",
    operation: "APPROVE",
    permissionDomain: "BUSINESS",
    policy: null,
    dualControlHook: null,
    subjectAccountIds: [],
    facts: validSeparation,
    elevation: "NONE",
    dualControl: restrictiveDualControl,
    ...over,
  });

  it("separation rule READINESS_APPROVAL: candidates and recruiter-only actors never approve readiness", () => {
    expect(
      readinessApprovalRule(input({ actorPrincipalType: "CANDIDATE" })).kind,
    ).toBe("DENY");
    expect(
      readinessApprovalRule(input({ effectiveRoleCode: "RECRUITER" })).kind,
    ).toBe("DENY");
    expect(
      readinessApprovalRule(input({ effectiveRoleCode: "COMPLIANCE_REVIEWER" }))
        .kind,
    ).toBe("PASS");
  });

  it("separation rule ADMIN_BUSINESS_DECISION: technical authority never approves business work", async () => {
    expect(
      administratorBusinessRule(
        input({ effectiveRoleCode: "SYSTEM_ADMINISTRATOR" }),
      ),
    ).toMatchObject({ kind: "DENY", reason: "SEPARATION_CONFLICT" });
    expect(
      administratorBusinessRule(
        input({
          effectiveRoleCode: "SYSTEM_ADMINISTRATOR",
          permissionDomain: "TECHNICAL",
        }),
      ).kind,
    ).toBe("PASS");
  });

  it("separation rule BREAK_GLASS_ORDINARY_WORKFLOW: break-glass elevation never approves ordinary workflow", async () => {
    expectDeny(
      await decide("PSA_MANAGER", "compensation.approve", (r) => ({
        ...r,
        elevation: "BREAK_GLASS",
      })),
      "SEPARATION_CONFLICT",
    );
    // break_glass.start itself is granted to nobody (pending decision).
    expect(findPermission("break_glass.start")).not.toBeNull();
  });

  it("separation rule AUDIT_SELF_MODIFICATION: no permission mutates audit records, and the rule denies self-documented changes", () => {
    const auditMutation = permissionCatalog.filter(
      (p) =>
        p.resource === "audit" &&
        p.operation !== "READ" &&
        p.operation !== "EXPORT",
    );
    expect(auditMutation).toEqual([]);
    expect(
      auditSelfModificationRule(
        input({ facts: { documentedActorAccountIds: [account.ACTOR] } }),
      ),
    ).toMatchObject({ kind: "DENY", reason: "SEPARATION_CONFLICT" });
    expect(auditSelfModificationRule(input({ facts: {} }))).toMatchObject({
      kind: "DENY",
      reason: "SEPARATION_FACTS_MISSING",
    });
    expect(
      auditSelfModificationRule(
        input({ facts: { documentedActorAccountIds: [account.OTHER_STAFF] } }),
      ).kind,
    ).toBe("PASS");
  });

  it("separation rule DUAL_CONTROL rejects the same user acting under two roles", async () => {
    const world = matrixWorld();
    world.assign(account.ACTOR, "PSA_MANAGER", "ORGANIZATION", scope.ORG);
    world.resolver.addDesignation(
      account.ACTOR,
      "CLASSIFICATION_APPROVER",
      scope.ORG,
    );
    expectDeny(
      await decide(
        "CLASSIFICATION_REVIEWER",
        "classification.review.decide",
        (r) => ({
          ...r,
          separation: {
            ...validSeparation,
            priorApproverAccountIds: [account.ACTOR],
          },
        }),
        world,
      ),
      "SEPARATION_CONFLICT",
    );
  });
});

// ------------------------------------------------------- §9.4 recent auth

describe("recent authentication (§9.4)", () => {
  const purposes = [
    ...new Map(
      permissionCatalog
        .filter((p) => p.recentAuth)
        .map((p) => [`${p.recentAuth!.policy}/${p.recentAuth!.purpose}`, p]),
    ).values(),
  ];
  const holder = (code: string): RoleCode => {
    for (const role of [
      "PSA_MANAGER",
      "COMPLIANCE_REVIEWER",
      "HR_SPECIALIST",
      "AUDITOR_READ_ONLY",
      "SYSTEM_ADMINISTRATOR",
      "CLASSIFICATION_REVIEWER",
      "TRAINER_EVALUATOR",
      "RECRUITER",
    ] as RoleCode[]) {
      if (matrixWorld().facts.grant(role, code)) return role;
    }
    throw new Error("no holder");
  };
  const granted = purposes.filter((p) => {
    try {
      holder(p.code);
      return true;
    } catch {
      return false;
    }
  });

  it.each(
    granted.map(
      (p) =>
        [
          `${p.recentAuth!.policy}/${p.recentAuth!.purpose} (${p.code})`,
          p,
        ] as const,
    ),
  )(
    "recent authentication %s: exact freshness, strength, and binding",
    async (_label, p) => {
      const role = holder(p.code);
      const actor =
        role === "AUDITOR_READ_ONLY" ? account.AUDITOR : account.ACTOR;
      const strong = p.recentAuth!.policy === "RECENT_STRONG_AUTH";
      const withEvidence = async (
        reauth: {
          at: Date;
          method: "PASSWORD_TOTP" | "PASSWORD_BACKUP_CODE";
          purpose: string;
        } | null,
        over: Parameters<typeof staffSession>[1] = {},
        tweak: (w: MatrixWorld) => void = () => {},
      ) => {
        const world = matrixWorld();
        const request = satisfyingRequest(world, role, p, actor);
        world.facts.evidence.set(
          sessionOf(actor),
          staffSession(actor, { reauthentication: reauth, ...over }),
        );
        tweak(world);
        return world.decide(request);
      };
      const purpose = p.recentAuth!.purpose!;
      // Strict window: 299s fresh, exactly 300s stale.
      expect(
        (await withEvidence({ at: at(-299), method: "PASSWORD_TOTP", purpose }))
          .decision,
      ).toBe("ALLOW");
      expectDeny(
        await withEvidence({ at: at(-300), method: "PASSWORD_TOTP", purpose }),
        "RECENT_AUTH_REQUIRED",
      );
      // No step-up at all; wrong purpose.
      expectDeny(await withEvidence(null), "RECENT_AUTH_REQUIRED");
      expectDeny(
        await withEvidence({
          at: at(-10),
          method: "PASSWORD_TOTP",
          purpose: "STAFF_SECURITY",
        }),
        "RECENT_AUTH_REQUIRED",
      );
      // A backup code never satisfies strong policies.
      const backup = await withEvidence({
        at: at(-10),
        method: "PASSWORD_BACKUP_CODE",
        purpose,
      });
      if (strong) {
        expectDeny(backup, "RECENT_AUTH_REQUIRED");
        expect(backup.decision === "DENY" && backup.challenge).toBe(
          "STRONGER_METHOD_REQUIRED",
        );
      } else {
        expect(backup.decision).toBe("ALLOW");
      }
      // Stale account version (security change since sign-in).
      expectDeny(
        await withEvidence(
          { at: at(-10), method: "PASSWORD_TOTP", purpose },
          { sessionAccountVersion: 1, currentAccountVersion: 2 },
        ),
      );
      // Impossible future timestamp (clock skew beyond tolerance).
      expectDeny(
        await withEvidence({ at: at(60), method: "PASSWORD_TOTP", purpose }),
      );
      // Step-up made before a privilege expansion or authorization change.
      expectDeny(
        await withEvidence(
          { at: at(-10), method: "PASSWORD_TOTP", purpose },
          {},
          (w) => {
            for (const a of w.facts.assignments) a.effectiveFrom = at(-5);
          },
        ),
        "RECENT_AUTH_REQUIRED",
      );
      expectDeny(
        await withEvidence(
          { at: at(-10), method: "PASSWORD_TOTP", purpose },
          {},
          (w) =>
            w.facts.epochs.set(actor, {
              authorizationVersion: 2,
              versionChangedAt: at(-5),
            }),
        ),
        "RECENT_AUTH_REQUIRED",
      );
      // Evidence bound to another account's session never counts.
      expectDeny(
        await withEvidence(null, {}, (w) =>
          w.facts.evidence.set(
            sessionOf(actor),
            staffSession(account.OTHER_STAFF, {
              sessionId: sessionOf(actor),
              reauthentication: {
                at: at(-10),
                method: "PASSWORD_TOTP",
                purpose,
              },
            }),
          ),
        ),
      );
    },
  );

  it("recent authentication cannot be asserted by the client request", async () => {
    for (const key of [
      "reauthentication",
      "assurance",
      "mfaAuthenticatedAt",
      "recentAuth",
    ]) {
      expectDeny(
        await decide(
          "COMPLIANCE_REVIEWER",
          "screening.result.read_restricted",
          (r) =>
            ({
              ...r,
              [key]: { at: at(-1), method: "PASSWORD_TOTP" },
            }) as never,
        ),
        "INVALID_CONTEXT",
      );
    }
  });

  it("recent authentication followed by a role or account change reauthorizes completely", async () => {
    const world = matrixWorld();
    const p = findPermission("screening.result.read_restricted")!;
    const request = satisfyingRequest(world, "COMPLIANCE_REVIEWER", p);
    expect((await world.decide(request)).decision).toBe("ALLOW");
    world.facts.assignments[0]!.status = "REVOKED";
    expectDeny(await world.decide(request));
    world.facts.assignments[0]!.status = "ACTIVE";
    world.facts.accounts.set(account.ACTOR, {
      id: account.ACTOR,
      accountType: "STAFF",
      status: "DISABLED",
    });
    expectDeny(await world.decide(request), "ACCOUNT_INACTIVE");
  });
});

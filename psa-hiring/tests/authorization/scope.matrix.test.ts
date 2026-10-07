import { describe, expect, it } from "vitest";
import { narrowConstraint } from "@/modules/identity-access/application/authorize-query";
import type { AuthorizationDecision } from "@/modules/identity-access/domain/authorization-decision";
import type {
  RoleCode,
  ScopeType,
} from "@/modules/identity-access/domain/authorization-vocabulary";
import { findPermission } from "@/modules/identity-access/policy/permission-catalog";
import {
  account,
  expectAllow,
  expectDeny,
  matrixWorld,
  principalOf,
  sessionOf,
  staffSession,
  type MatrixWorld,
} from "../fixtures/authorization/matrix-harness";
import {
  AUDIT_RECORDS_FROM,
  AUDIT_RECORDS_TO,
  NOW,
  at,
  record,
  scope,
  u,
} from "../fixtures/scopes";
import { scopeConditions, scopeRows } from "./matrix-manifest";

// M1.7 §11: every scope type × inside / outside / missing / inactive /
// expired / malformed / wrong-type / cross-organization, through the real
// decision pipeline and the accepted synthetic resolver (§11.4: no M2
// tables). A resource outside every effective scope denies before any
// payload is materialized: the decision is made from placement only.

const READ = findPermission("candidate.read.assigned")!;

type Case = Readonly<{
  /** Assignment scope reference (or a transform of the world). */
  ref: string;
  resource: string;
  setup?: (w: MatrixWorld, assignmentId: string) => void;
  expect: "ALLOW" | readonly string[];
}>;

const STAFF_ROLE: RoleCode = "RECRUITER";
const DENIED = ["SCOPE_MISMATCH"] as const;

const table: Record<
  ScopeType,
  Record<(typeof scopeConditions)[number], Case>
> = {
  ASSIGNED_RECORDS: {
    inside: { ref: scope.SET, resource: record.IN_TEAM, expect: "ALLOW" },
    outside: { ref: scope.SET, resource: record.IN_BRANCH, expect: DENIED },
    missing: { ref: scope.MISSING, resource: record.IN_TEAM, expect: DENIED },
    inactive: {
      ref: scope.SET,
      resource: record.IN_TEAM,
      setup: (w) => w.resolver.deactivate(scope.SET),
      expect: DENIED,
    },
    expired: {
      ref: scope.SET,
      resource: record.IN_TEAM,
      setup: (w) => (w.facts.assignments[0]!.effectiveTo = NOW),
      expect: ["ASSIGNMENT_INACTIVE"],
    },
    malformed: { ref: "not-a-scope", resource: record.IN_TEAM, expect: DENIED },
    "wrong-type": { ref: scope.TEAM, resource: record.IN_TEAM, expect: DENIED },
    "cross-organization": {
      ref: scope.SET_ORG2,
      resource: record.IN_TEAM,
      expect: DENIED,
    },
  },
  TEAM: {
    inside: { ref: scope.TEAM, resource: record.IN_TEAM, expect: "ALLOW" },
    outside: { ref: scope.TEAM, resource: record.IN_BRANCH, expect: DENIED },
    missing: { ref: scope.MISSING, resource: record.IN_TEAM, expect: DENIED },
    inactive: {
      ref: scope.INACTIVE_TEAM,
      resource: record.INACTIVE_PARENT,
      expect: DENIED,
    },
    expired: {
      ref: scope.TEAM,
      resource: record.IN_TEAM,
      setup: (w) => (w.facts.assignments[0]!.effectiveTo = NOW),
      expect: ["ASSIGNMENT_INACTIVE"],
    },
    malformed: { ref: "TEAM-1", resource: record.IN_TEAM, expect: DENIED },
    "wrong-type": {
      ref: scope.BRANCH,
      resource: record.IN_TEAM,
      expect: DENIED,
    },
    "cross-organization": {
      ref: scope.TEAM2,
      resource: record.OTHER_ORG,
      expect: DENIED,
    },
  },
  BRANCH: {
    inside: { ref: scope.BRANCH, resource: record.IN_TEAM, expect: "ALLOW" },
    outside: {
      ref: scope.BRANCH,
      resource: record.SIBLING_BRANCH,
      expect: DENIED,
    },
    missing: { ref: scope.MISSING, resource: record.IN_TEAM, expect: DENIED },
    inactive: {
      ref: scope.INACTIVE_BRANCH,
      resource: record.INACTIVE_PARENT,
      expect: DENIED,
    },
    expired: {
      ref: scope.BRANCH,
      resource: record.IN_TEAM,
      setup: (w) => (w.facts.assignments[0]!.effectiveTo = NOW),
      expect: ["ASSIGNMENT_INACTIVE"],
    },
    malformed: {
      ref: "",
      resource: record.IN_TEAM,
      expect: ["POLICY_UNAVAILABLE"],
    },
    "wrong-type": { ref: scope.TEAM, resource: record.IN_TEAM, expect: DENIED },
    "cross-organization": {
      ref: scope.ORG2_BRANCH,
      resource: record.IN_TEAM,
      expect: DENIED,
    },
  },
  ORGANIZATION: {
    inside: { ref: scope.ORG, resource: record.IN_TEAM, expect: "ALLOW" },
    outside: { ref: scope.ORG, resource: record.NONEXISTENT, expect: DENIED },
    missing: { ref: scope.MISSING, resource: record.IN_TEAM, expect: DENIED },
    inactive: {
      ref: scope.ORG,
      resource: record.IN_TEAM,
      setup: (w) => w.resolver.deactivate(scope.ORG),
      expect: DENIED,
    },
    expired: {
      ref: scope.ORG,
      resource: record.IN_TEAM,
      setup: (w) => (w.facts.assignments[0]!.effectiveTo = NOW),
      expect: ["ASSIGNMENT_INACTIVE"],
    },
    malformed: { ref: "org", resource: record.IN_TEAM, expect: DENIED },
    "wrong-type": {
      ref: scope.BRANCH,
      resource: record.IN_TEAM,
      expect: DENIED,
    },
    "cross-organization": {
      ref: scope.ORG,
      resource: record.OTHER_ORG,
      expect: DENIED,
    },
  },
  AUDIT_ASSIGNMENT: {
    inside: { ref: scope.AUDIT, resource: record.IN_TEAM, expect: "ALLOW" },
    outside: { ref: scope.AUDIT, resource: record.OTHER_GROUP, expect: DENIED },
    missing: { ref: scope.MISSING, resource: record.IN_TEAM, expect: DENIED },
    inactive: {
      ref: scope.AUDIT,
      resource: record.IN_TEAM,
      setup: (w) => w.resolver.deactivate(scope.AUDIT),
      expect: DENIED,
    },
    expired: {
      ref: scope.AUDIT_EXPIRED,
      resource: record.IN_TEAM,
      expect: DENIED,
    },
    malformed: { ref: "audit!", resource: record.IN_TEAM, expect: DENIED },
    "wrong-type": { ref: scope.ORG, resource: record.IN_TEAM, expect: DENIED },
    "cross-organization": {
      ref: scope.AUDIT,
      resource: record.OTHER_ORG,
      expect: DENIED,
    },
  },
};

async function run(type: ScopeType, c: Case): Promise<AuthorizationDecision> {
  const world = matrixWorld();
  const actor = type === "AUDIT_ASSIGNMENT" ? account.AUDITOR : account.ACTOR;
  const role: RoleCode =
    type === "AUDIT_ASSIGNMENT" ? "AUDITOR_READ_ONLY" : STAFF_ROLE;
  const id = world.assign(actor, role, type, c.ref);
  c.setup?.(world, id);
  return world.decide({
    principal: principalOf(actor),
    permission: READ.code,
    operation: READ.operation,
    resource: {
      kind: "RECORD",
      id: c.resource,
      sensitivity: "CONFIDENTIAL_PERSONNEL",
    },
  });
}

describe("scope matrix (§11)", () => {
  it("covers every scope type and condition", () => {
    for (const row of scopeRows) {
      expect(table[row.type][row.condition], row.id).toBeDefined();
    }
  });

  it.each(scopeRows.map((r) => [r.id, r] as const))("%s", async (_id, row) => {
    const c = table[row.type][row.condition];
    const decision = await run(row.type, c);
    if (c.expect === "ALLOW") {
      expectAllow(
        decision,
        row.type === "AUDIT_ASSIGNMENT" ? "AUDITOR_READ_ONLY" : STAFF_ROLE,
      );
    } else {
      expectDeny(decision);
      expect(c.expect, JSON.stringify(decision)).toContain(decision.reasonCode);
    }
  });
});

describe("scope boundaries and selection (§11.2–§11.3)", () => {
  it("contains a team's records in its branch but never a sibling branch or another organization", async () => {
    const world = matrixWorld();
    world.assign(account.ACTOR, STAFF_ROLE, "BRANCH", scope.BRANCH);
    const decide = (id: string) =>
      world.decide({
        principal: principalOf(account.ACTOR),
        permission: READ.code,
        operation: READ.operation,
        resource: { kind: "RECORD", id, sensitivity: "CONFIDENTIAL_PERSONNEL" },
      });
    expect((await decide(record.IN_TEAM)).decision).toBe("ALLOW");
    expect((await decide(record.IN_BRANCH)).decision).toBe("ALLOW");
    expectDeny(await decide(record.SIBLING_BRANCH), "SCOPE_MISMATCH");
    expectDeny(await decide(record.OTHER_ORG), "SCOPE_MISMATCH");
  });

  it("uses an inclusive start and exclusive end for assignments and audit windows", async () => {
    for (const [from, to, outcome] of [
      [NOW, null, "ALLOW"],
      [at(1), null, "DENY"],
      [at(-60), at(1), "ALLOW"],
      [at(-60), NOW, "DENY"],
    ] as const) {
      const world = matrixWorld();
      world.assign(account.ACTOR, STAFF_ROLE, "TEAM", scope.TEAM, {
        effectiveFrom: from,
        effectiveTo: to,
      });
      const decision = await world.decide({
        principal: principalOf(account.ACTOR),
        permission: READ.code,
        operation: READ.operation,
        resource: {
          kind: "RECORD",
          id: record.IN_TEAM,
          sensitivity: "CONFIDENTIAL_PERSONNEL",
        },
      });
      expect(decision.decision).toBe(outcome);
    }

    // Audit records dated [recordsFrom, recordsTo); assignment active
    // [startsAt, endsAt) on the server clock.
    const world = matrixWorld();
    const atStart = u("bd000000", 1);
    const atEnd = u("bd000000", 2);
    world.resolver
      .addRecord(atStart, {
        organizationId: scope.ORG,
        branchId: scope.BRANCH,
        recordGroupIds: [scope.GROUP],
        recordedAt: AUDIT_RECORDS_FROM,
        subjectAccountIds: [],
      })
      .addRecord(atEnd, {
        organizationId: scope.ORG,
        branchId: scope.BRANCH,
        recordGroupIds: [scope.GROUP],
        recordedAt: AUDIT_RECORDS_TO,
        subjectAccountIds: [],
      })
      .addAuditAssignment(u("bd000000", 3), {
        organizationId: scope.ORG,
        auditorAccountId: account.AUDITOR,
        categories: ["CONFIDENTIAL_PERSONNEL"],
        recordGroupIds: [scope.GROUP],
        recordsFrom: AUDIT_RECORDS_FROM,
        recordsTo: AUDIT_RECORDS_TO,
        startsAt: NOW,
        endsAt: at(60),
      })
      .addAuditAssignment(u("bd000000", 4), {
        organizationId: scope.ORG,
        auditorAccountId: account.AUDITOR,
        categories: ["CONFIDENTIAL_PERSONNEL"],
        recordGroupIds: [scope.GROUP],
        recordsFrom: AUDIT_RECORDS_FROM,
        recordsTo: AUDIT_RECORDS_TO,
        startsAt: at(-60),
        endsAt: NOW,
      });
    const audit = async (assignment: string, id: string) => {
      const w = matrixWorld();
      Object.assign(w.deps, { resolver: world.resolver });
      w.assign(
        account.AUDITOR,
        "AUDITOR_READ_ONLY",
        "AUDIT_ASSIGNMENT",
        assignment,
      );
      return (
        await w.decide({
          principal: principalOf(account.AUDITOR),
          permission: READ.code,
          operation: READ.operation,
          resource: {
            kind: "RECORD",
            id,
            sensitivity: "CONFIDENTIAL_PERSONNEL",
          },
        })
      ).decision;
    };
    expect(await audit(u("bd000000", 3), atStart)).toBe("ALLOW");
    expect(await audit(u("bd000000", 3), atEnd)).toBe("DENY");
    expect(await audit(u("bd000000", 4), atStart)).toBe("DENY");
    expect(await audit(scope.AUDIT, record.OUT_OF_WINDOW)).toBe("DENY");
    expect(await audit(scope.AUDIT_FUTURE, record.IN_TEAM)).toBe("DENY");
    expect(await audit(scope.AUDIT_OTHER_AUDITOR, record.IN_TEAM)).toBe("DENY");
  });

  it("authorizes administrative targets that are themselves scopes, within the actor's scope only", async () => {
    const propose = findPermission("role_assignment.propose")!;
    const world = matrixWorld();
    world.assign(account.ACTOR, "PSA_MANAGER", "BRANCH", scope.BRANCH, {
      effectiveFrom: at(-86_400),
    });
    world.facts.evidence.set(
      sessionOf(account.ACTOR),
      staffSession(account.ACTOR, {
        reauthentication: {
          at: at(-10),
          method: "PASSWORD_TOTP",
          purpose: propose.recentAuth?.purpose ?? "PRIVILEGED_ACCESS_CHANGE",
        },
      }),
    );
    const target = (scopeType: ScopeType, id: string) =>
      world.decide({
        principal: principalOf(account.ACTOR),
        permission: propose.code,
        operation: propose.operation,
        resource: { kind: "SCOPE", scopeType, id, sensitivity: "INTERNAL" },
        ...(propose.requiresReason ? { reasonCode: "NEW_ACCESS" } : {}),
      });
    expect((await target("TEAM", scope.TEAM)).decision).toBe("ALLOW");
    expectDeny(await target("TEAM", scope.TEAM2), "SCOPE_MISMATCH");
    expectDeny(await target("ORGANIZATION", scope.ORG), "SCOPE_MISMATCH");
    expectDeny(await target("BRANCH", scope.ORG2_BRANCH), "SCOPE_MISMATCH");
    expectDeny(await target("TEAM", scope.BRANCH), "SCOPE_MISMATCH");
  });

  it("lets a client selection narrow a list scope but never widen it", async () => {
    const world = matrixWorld();
    world.assign(account.ACTOR, STAFF_ROLE, "BRANCH", scope.BRANCH);
    world.assign(account.ACTOR, STAFF_ROLE, "TEAM", scope.TEAM2);
    const decision = await world.query({
      principal: principalOf(account.ACTOR),
      permission: READ.code,
      operation: "READ",
      sensitivity: "CONFIDENTIAL_PERSONNEL",
    });
    expect(decision.decision).toBe("ALLOW");
    if (decision.decision !== "ALLOW") return;
    const constraint = decision.constraint;
    expect(
      narrowConstraint(constraint, { type: "TEAM", id: scope.TEAM2 }),
    ).toMatchObject({ scopes: [{ type: "TEAM", teamId: scope.TEAM2 }] });
    // A selection the principal does not hold (or a wider one) yields nothing.
    for (const selection of [
      { type: "ORGANIZATION", id: scope.ORG },
      { type: "BRANCH", id: scope.BRANCH2 },
      { type: "TEAM", id: scope.TEAM },
      { type: "ORGANIZATION", id: scope.ORG2 },
    ] as const) {
      expect(narrowConstraint(constraint, selection)).toBeNull();
    }
    // The request itself cannot carry scopes or roles.
    expectDeny(
      await world.query({
        principal: principalOf(account.ACTOR),
        permission: READ.code,
        operation: "READ",
        sensitivity: "CONFIDENTIAL_PERSONNEL",
        scopes: [{ type: "ORGANIZATION", organizationId: scope.ORG2 }],
      } as never),
      "INVALID_CONTEXT",
    );
  });
});

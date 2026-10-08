import { describe, expect, it } from "vitest";
import { roleCodes } from "@/modules/identity-access/domain/authorization-vocabulary";
import { findPermission } from "@/modules/identity-access/policy/permission-catalog";
import {
  account,
  expectAllow,
  expectDeny,
  homeScope,
  matrixWorld,
  principalOf,
  satisfyingRequest,
  sessionOf,
  staffSession,
} from "../fixtures/authorization/matrix-harness";
import { at, record, scope } from "../fixtures/scopes";
import { pairRows } from "./matrix-manifest";

// M1.7 §10: every role against every permission in the accepted catalog,
// through the real central decision pipeline. For each pair the matrix
// row states the explicit maximum grant; granted pairs ALLOW with every
// required condition/scope/state/separation/assurance fact present and
// DENY once only the grant is removed; ungranted pairs DENY with the same
// valid facts. Synthetic envelopes only; no M2 persistence.

describe("role × permission matrix (§10)", () => {
  it("covers every catalog role and permission exactly once", () => {
    const ids = new Set(pairRows.map((r) => r.id));
    expect(ids.size).toBe(pairRows.length);
    expect(pairRows.length).toBe(roleCodes.length * 192);
    expect(pairRows.filter((r) => r.granted)).toHaveLength(397);
  });

  it.each(pairRows.map((row) => [row.id, row] as const))(
    "%s",
    async (_id, row) => {
      const definition = findPermission(row.permission)!;
      const world = matrixWorld();
      const request = satisfyingRequest(world, row.role, definition);
      const decision = await world.decide(request);
      if (row.expected === "ALLOW") {
        expectAllow(decision, row.role);
        if (row.role !== "CANDIDATE" && decision.decision === "ALLOW") {
          expect(decision.effectiveScopeType).toBe(homeScope(row.role).type);
          expect(decision.effectiveAssignmentId).not.toBeNull();
        }
        // Remove only the grant: every other fact still valid.
        world.facts.removedGrants.add(`${row.role}|${row.permission}`);
        expectDeny(await world.decide(request), "PERMISSION_MISSING");
      } else {
        expectDeny(decision, "PERMISSION_MISSING");
      }
      const denials = world.events.filter(
        (e) => e.code === "authz.high_risk_denied",
      );
      if (row.denialEvent && row.expected !== "ALLOW") {
        expect(denials).toHaveLength(1);
        expect(denials[0]).toMatchObject({ permissionCode: row.permission });
      }
      if (!definition.highRisk) expect(denials).toHaveLength(0);
    },
  );
});

describe("codes, inheritance, and principal crossover (§10)", () => {
  it.each([
    "*",
    "admin",
    "isAdmin",
    "screening.*",
    "screening.result",
    "screening.result.read_restricted.extra",
    "SCREENING.RESULT.READ_RESTRICTED",
    "candidate.read.assigned ",
    "",
  ])("denies the unknown, wildcard, or prefix code %j", async (code) => {
    const world = matrixWorld();
    world.assign(account.ACTOR, "PSA_MANAGER", "ORGANIZATION", scope.ORG);
    const decision = await world.decide({
      principal: principalOf(account.ACTOR),
      permission: code,
      operation: "READ",
      resource: { kind: "RECORD", id: record.IN_TEAM, sensitivity: "INTERNAL" },
    });
    expectDeny(decision);
    expect(["PERMISSION_UNKNOWN", "INVALID_CONTEXT"]).toContain(
      decision.reasonCode,
    );
  });

  it("denies a permission whose stored catalog row is retired or drifted", async () => {
    const definition = findPermission("candidate.read.assigned")!;
    for (const override of [
      { status: "RETIRED" },
      { maxSensitivity: "RESTRICTED_SCREENING_MEDICAL" },
      { catalogVersion: 99 },
    ]) {
      const world = matrixWorld();
      const request = satisfyingRequest(world, "RECRUITER", definition);
      world.facts.permissionOverrides.set(definition.code, override);
      expectDeny(await world.decide(request), "POLICY_UNAVAILABLE");
    }
  });

  it("denies a retired role, a revoked/superseded/proposed assignment, and an expired one", async () => {
    const definition = findPermission("candidate.read.assigned")!;
    const cases: [string, (w: ReturnType<typeof matrixWorld>) => void][] = [
      ["retired role", (w) => w.facts.retiredRoles.add("RECRUITER")],
      ["revoked", (w) => (w.facts.assignments[0]!.status = "REVOKED")],
      ["superseded", (w) => (w.facts.assignments[0]!.status = "SUPERSEDED")],
      ["proposed", (w) => (w.facts.assignments[0]!.status = "PROPOSED")],
      ["expired", (w) => (w.facts.assignments[0]!.effectiveTo = at(0))],
      ["future", (w) => (w.facts.assignments[0]!.effectiveFrom = at(1))],
    ];
    for (const [label, mutate] of cases) {
      const world = matrixWorld();
      const request = satisfyingRequest(world, "RECRUITER", definition);
      mutate(world);
      const decision = await world.decide(request);
      expectDeny(decision);
      expect(["ASSIGNMENT_INACTIVE", "PERMISSION_MISSING"], label).toContain(
        decision.reasonCode,
      );
    }
  });

  it("refuses an unknown condition or a tampered grant row instead of granting", async () => {
    const definition = findPermission("candidate.read.assigned")!;
    for (const condition of [
      { kind: "ANY" },
      { kind: "DESIGNATION", v: 1, designation: "EVERYTHING" },
      "true",
      { v: 1, kind: "CANDIDATE_OWNERSHIP" },
    ]) {
      const world = matrixWorld();
      const request = satisfyingRequest(world, "RECRUITER", definition);
      world.facts.conditionOverride = condition;
      expectDeny(await world.decide(request), "POLICY_UNAVAILABLE");
    }
  });

  it("never lets an operation mismatch inherit a different action", async () => {
    const definition = findPermission("candidate.read.assigned")!;
    for (const operation of [
      "EDIT",
      "APPROVE",
      "DOWNLOAD",
      "EXPORT",
      "ADMINISTER",
    ] as const) {
      const world = matrixWorld();
      const request = satisfyingRequest(world, "RECRUITER", definition);
      expectDeny(
        await world.decide({ ...request, operation }),
        "INVALID_CONTEXT",
      );
    }
  });

  it("never lets a candidate use a staff role or staff use the candidate role", async () => {
    // A candidate account holding a staff assignment still has only the
    // candidate-self relationship.
    const staffPermission = findPermission("candidate.read.assigned")!;
    const world = matrixWorld();
    world.assign(account.CANDIDATE_A, "PSA_MANAGER", "ORGANIZATION", scope.ORG);
    expectDeny(
      await world.decide({
        principal: principalOf(account.CANDIDATE_A, "CANDIDATE"),
        permission: staffPermission.code,
        operation: staffPermission.operation,
        resource: {
          kind: "RECORD",
          id: record.IN_TEAM,
          sensitivity: staffPermission.maxSensitivity,
        },
      }),
      "PERMISSION_MISSING",
    );
    // A staff assignment to the CANDIDATE policy role is tampering.
    const selfPermission =
      findPermission("candidate.profile.read_own") ??
      findPermission(
        pairRows.find((r) => r.role === "CANDIDATE" && r.granted)!.permission,
      )!;
    const staffWorld = matrixWorld();
    staffWorld.assign(account.ACTOR, "CANDIDATE", "ORGANIZATION", scope.ORG);
    expectDeny(
      await staffWorld.decide({
        principal: principalOf(account.ACTOR),
        permission: selfPermission.code,
        operation: selfPermission.operation,
        resource: {
          kind: "RECORD",
          id: record.IN_TEAM,
          sensitivity: selfPermission.maxSensitivity,
        },
      }),
      "PERMISSION_MISSING",
    );
  });

  it("denies service, inactive, incomplete, password-only, and unauthenticated principals with valid grants", async () => {
    const definition = findPermission("candidate.read.assigned")!;
    const cases = [
      [principalOf(account.SERVICE, "SERVICE"), "ACCOUNT_INACTIVE"],
      [principalOf(account.INACTIVE_STAFF), "ACCOUNT_INACTIVE"],
      [principalOf(account.PASSWORD_ONLY_STAFF), "UNAUTHENTICATED"],
      [
        principalOf(account.CANDIDATE_INCOMPLETE, "CANDIDATE"),
        "ACCOUNT_INACTIVE",
      ],
      [null, "UNAUTHENTICATED"],
      [
        {
          ...principalOf(account.ACTOR),
          sessionId: sessionOf(account.OTHER_STAFF),
        },
        "UNAUTHENTICATED",
      ],
      [
        { ...principalOf(account.ACTOR), accountType: "CANDIDATE" },
        "ACCOUNT_INACTIVE",
      ],
    ] as const;
    for (const [principal, reason] of cases) {
      const world = matrixWorld();
      for (const id of [
        account.SERVICE,
        account.INACTIVE_STAFF,
        account.PASSWORD_ONLY_STAFF,
        account.ACTOR,
      ]) {
        world.assign(id, "RECRUITER", "ORGANIZATION", scope.ORG);
      }
      const request = satisfyingRequest(world, "RECRUITER", definition);
      expectDeny(await world.decide({ ...request, principal }), reason);
    }
  });
});

describe("multi-role union and least privilege (§10)", () => {
  const read = findPermission("candidate.read.assigned")!;

  it("unions only explicit grants and picks the least-privileged sufficient assignment deterministically", async () => {
    for (const order of [0, 1]) {
      const world = matrixWorld();
      const request = satisfyingRequest(world, "RECRUITER", read);
      world.facts.assignments.length = 0;
      const wide = () =>
        world.assign(account.ACTOR, "PSA_MANAGER", "ORGANIZATION", scope.ORG);
      const narrow = () =>
        world.assign(account.ACTOR, "RECRUITER", "TEAM", scope.TEAM);
      const ids = order ? [narrow(), wide()] : [wide(), narrow()];
      const decision = await world.decide(request);
      expectAllow(decision, "RECRUITER");
      expect(decision.decision === "ALLOW" && decision.effectiveScopeType).toBe(
        "TEAM",
      );
      expect(
        decision.decision === "ALLOW" && decision.effectiveAssignmentId,
      ).toBe(order ? ids[0] : ids[1]);
    }
  });

  it("falls through to a later assignment only when an earlier one fails its own checks", async () => {
    // The narrow assignment began after the step-up (privilege expansion),
    // so only the older, wider assignment can use it.
    const approve = findPermission("role_assignment.approve")!;
    const world = matrixWorld();
    // Old organization-wide PSA_MANAGER assignment (from satisfyingRequest)
    // plus a brand-new, narrower team assignment.
    const request = satisfyingRequest(world, "PSA_MANAGER", approve);
    world.assign(account.ACTOR, "PSA_MANAGER", "TEAM", scope.TEAM, {
      effectiveFrom: at(-5),
    });
    const decision = await world.decide(request);
    expect(decision.decision).toBe("ALLOW");
    expect(decision.decision === "ALLOW" && decision.effectiveScopeType).toBe(
      "ORGANIZATION",
    );
  });

  it("never lets a second role bypass separation of duties", async () => {
    const world = matrixWorld();
    const request = satisfyingRequest(world, "RECRUITER", read);
    world.assign(account.ACTOR, "PSA_MANAGER", "ORGANIZATION", scope.ORG);
    world.assign(account.ACTOR, "HR_SPECIALIST", "BRANCH", scope.BRANCH);
    expectDeny(
      await world.decide({
        ...request,
        resource: { ...request.resource, id: record.OWN_FILE },
      }),
      "SEPARATION_CONFLICT",
    );
  });

  it("never lets a wider general role broaden a narrow specialist permission", async () => {
    const restricted = findPermission("screening.result.read_restricted")!;
    const world = matrixWorld();
    // Compliance reviewer only for TEAM2; recruiter organization-wide.
    world.assign(account.ACTOR, "COMPLIANCE_REVIEWER", "TEAM", scope.TEAM2);
    world.assign(account.ACTOR, "RECRUITER", "ORGANIZATION", scope.ORG);
    world.facts.evidence.set(
      sessionOf(account.ACTOR),
      staffSession(account.ACTOR, {
        reauthentication: {
          at: at(-10),
          method: "PASSWORD_TOTP",
          purpose: restricted.recentAuth?.purpose ?? "RESTRICTED_DATA_ACCESS",
        },
      }),
    );
    expectDeny(
      await world.decide({
        principal: principalOf(account.ACTOR),
        permission: restricted.code,
        operation: restricted.operation,
        resource: {
          kind: "RECORD",
          id: record.IN_TEAM,
          sensitivity: restricted.maxSensitivity,
        },
        ...(restricted.requiresReason ? { reasonCode: "MATRIX_TEST" } : {}),
      }),
      "SCOPE_MISMATCH",
    );
  });
});

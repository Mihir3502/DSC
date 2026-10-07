import { describe, expect, it } from "vitest";
import {
  designations,
  roleCodes,
  type RoleCode,
  type ScopeType,
} from "@/modules/identity-access/domain/authorization-vocabulary";
import { allowedScopeTypesByRole } from "@/modules/identity-access/domain/role-assignment";
import {
  findPermission,
  permissionCatalog,
} from "@/modules/identity-access/policy/permission-catalog";
import { grantCatalog } from "@/modules/identity-access/policy/role-permission-catalog";
import {
  account,
  expectDeny,
  matrixWorld,
  principalOf,
  sessionOf,
  staffSession,
  validSeparation,
} from "../fixtures/authorization/matrix-harness";
import { at, record, scope } from "../fixtures/scopes";

// M1.7 §19: administrator technical authority never becomes business
// access/approval/export, and the auditor stays read-only and bounded by
// an active audit assignment (organization, record group, date window,
// data category). Every decision runs through the real pipeline with the
// most favorable other facts (fresh strong step-up, every designation,
// valid separation facts) so only the role boundary can deny.

const grantsOf = (role: RoleCode) =>
  grantCatalog.filter((g) => g.roleCode === role).map((g) => g.permissionCode);

function strongestRequest(
  role: RoleCode,
  actor: string,
  code: string,
  scopeType: ScopeType,
  scopeId: string,
  resourceId: string = record.IN_TEAM,
) {
  const world = matrixWorld();
  const p = findPermission(code)!;
  world.assign(actor, role, scopeType, scopeId);
  for (const d of designations)
    world.resolver.addDesignation(actor, d, scopeId);
  world.resolver.addRelationship(actor, resourceId, "INTERVIEWER");
  world.resolver.addRelationship(actor, resourceId, "EVALUATOR");
  world.facts.evidence.set(
    sessionOf(actor),
    staffSession(actor, {
      reauthentication: {
        at: at(-10),
        method: "PASSWORD_TOTP",
        purpose: p.recentAuth?.purpose ?? "STAFF_SECURITY",
      },
    }),
  );
  return {
    world,
    request: {
      principal: principalOf(actor),
      permission: p.code,
      operation: p.operation,
      resource: {
        kind: "RECORD",
        id: resourceId,
        sensitivity: p.maxSensitivity,
      },
      separation: validSeparation,
      holdCategory: "DOCUMENT",
      ...(p.workflowPolicy
        ? { workflow: { policy: p.workflowPolicy, state: "OPEN" } }
        : {}),
      ...(p.requiresReason ? { reasonCode: "MATRIX_TEST" } : {}),
    } as const,
  };
}

describe("system administrator boundary (§19.1)", () => {
  const adminGrants = new Set(grantsOf("SYSTEM_ADMINISTRATOR"));

  it("administrator grants are technical only: no approve, review, download, export, or business restricted data", () => {
    for (const code of adminGrants) {
      const p = findPermission(code)!;
      expect(p.domain, code).toBe("TECHNICAL");
      expect(["APPROVE", "REVIEW", "DOWNLOAD", "EXPORT"], code).not.toContain(
        p.operation,
      );
      // Security operations only (matrix §7 "Restricted access audit:
      // Security operations"): never identity/financial or screening/medical.
      if (p.restrictedData) {
        expect(p.maxSensitivity, code).toBe("SECURITY_AUDIT_RESTRICTED");
      }
    }
  });

  // Every business, export, or business-restricted permission. The
  // administrator's own TECHNICAL security-operations grants are covered by
  // the role × permission matrix instead.
  const business = permissionCatalog.filter(
    (p) =>
      p.domain !== "TECHNICAL" ||
      p.isExport ||
      p.maxSensitivity === "RESTRICTED_IDENTITY_FINANCIAL" ||
      p.maxSensitivity === "RESTRICTED_SCREENING_MEDICAL",
  );
  it.each(business.map((p) => [p.code] as const))(
    "administrator with organization scope, every designation, and fresh step-up is denied %s",
    async (code) => {
      const { world, request } = strongestRequest(
        "SYSTEM_ADMINISTRATOR",
        account.ADMIN,
        code,
        "ORGANIZATION",
        scope.ORG,
      );
      expectDeny(await world.decide(request));
    },
  );

  it("administrator cannot list or search business records", async () => {
    for (const code of [
      "candidate.read.assigned",
      "application.read",
      "screening.result.read_restricted",
    ]) {
      const world = matrixWorld();
      world.assign(
        account.ADMIN,
        "SYSTEM_ADMINISTRATOR",
        "ORGANIZATION",
        scope.ORG,
      );
      const p = findPermission(code)!;
      expectDeny(
        await world.query({
          principal: principalOf(account.ADMIN),
          permission: code,
          operation: "READ",
          sensitivity: p.maxSensitivity,
          ...(p.requiresReason ? { reasonCode: "MATRIX_TEST" } : {}),
        }),
      );
    }
  });

  it("administrator technical permissions never reach the administrator's own worker or candidate file", async () => {
    for (const code of adminGrants) {
      const { world, request } = strongestRequest(
        "SYSTEM_ADMINISTRATOR",
        account.ADMIN,
        code,
        "ORGANIZATION",
        scope.ORG,
        record.OWN_FILE,
      );
      world.resolver.addRecord("5c09e000-0000-4000-8000-0000000001ff", {
        organizationId: scope.ORG,
        branchId: scope.BRANCH,
        subjectAccountIds: [account.ADMIN],
      });
      const decision = await world.decide({
        ...request,
        resource: {
          ...request.resource,
          id: "5c09e000-0000-4000-8000-0000000001ff",
        },
      });
      expectDeny(decision, "SEPARATION_CONFLICT");
    }
  });

  it("no catalog permission lets anyone modify, delete, repair, or rehash audit history", () => {
    const mutation = permissionCatalog.filter(
      (p) =>
        p.resource === "audit" && !["READ", "EXPORT"].includes(p.operation),
    );
    expect(mutation).toEqual([]);
    expect(
      permissionCatalog.filter((p) =>
        /audit.*(edit|delete|repair|rehash|purge)/.test(p.code),
      ),
    ).toEqual([]);
  });
});

describe("auditor boundary (§19.2)", () => {
  const auditorGrants = new Set(grantsOf("AUDITOR_READ_ONLY"));

  it("auditor grants are read or export only", () => {
    for (const code of auditorGrants) {
      expect(["READ", "EXPORT"], code).toContain(
        findPermission(code)!.operation,
      );
    }
  });

  const writes = permissionCatalog.filter(
    (p) => !["READ", "EXPORT"].includes(p.operation),
  );
  it.each(writes.map((p) => [p.code] as const))(
    "auditor with an active assignment, every designation, and fresh step-up is denied %s",
    async (code) => {
      const { world, request } = strongestRequest(
        "AUDITOR_READ_ONLY",
        account.AUDITOR,
        code,
        "AUDIT_ASSIGNMENT",
        scope.AUDIT,
      );
      expectDeny(await world.decide(request));
    },
  );

  const read = "candidate.read.assigned";
  it.each([
    [
      "active assignment, in group, in window",
      scope.AUDIT,
      record.IN_TEAM,
      "ALLOW",
    ],
    ["expired assignment", scope.AUDIT_EXPIRED, record.IN_TEAM, "DENY"],
    ["future assignment", scope.AUDIT_FUTURE, record.IN_TEAM, "DENY"],
    [
      "another auditor's assignment",
      scope.AUDIT_OTHER_AUDITOR,
      record.IN_TEAM,
      "DENY",
    ],
    [
      "record outside the assignment window",
      scope.AUDIT,
      record.OUT_OF_WINDOW,
      "DENY",
    ],
    ["record in another group", scope.AUDIT, record.OTHER_GROUP, "DENY"],
    ["record in another organization", scope.AUDIT, record.OTHER_ORG, "DENY"],
    ["missing assignment", scope.MISSING, record.IN_TEAM, "DENY"],
  ] as const)(
    "auditor %s → %s",
    async (_label, assignment, resource, outcome) => {
      const { world, request } = strongestRequest(
        "AUDITOR_READ_ONLY",
        account.AUDITOR,
        read,
        "AUDIT_ASSIGNMENT",
        assignment,
        resource,
      );
      expect((await world.decide(request)).decision).toBe(outcome);
    },
  );

  it("auditor category bounds the data classification", async () => {
    const world = matrixWorld();
    world.assign(
      account.AUDITOR,
      "AUDITOR_READ_ONLY",
      "AUDIT_ASSIGNMENT",
      scope.AUDIT_NARROW,
    );
    const decide = (sensitivity: "CONFIDENTIAL_PERSONNEL" | "INTERNAL") =>
      world.decide({
        principal: principalOf(account.AUDITOR),
        permission: read,
        operation: "READ",
        resource: { kind: "RECORD", id: record.IN_TEAM, sensitivity },
      });
    expect((await decide("CONFIDENTIAL_PERSONNEL")).decision).toBe("ALLOW");
    expectDeny(await decide("INTERNAL"), "SCOPE_MISMATCH");
  });

  it("auditor list queries are bounded to the assignment before materialization", async () => {
    const world = matrixWorld();
    world.assign(
      account.AUDITOR,
      "AUDITOR_READ_ONLY",
      "AUDIT_ASSIGNMENT",
      scope.AUDIT,
    );
    const decision = await world.query({
      principal: principalOf(account.AUDITOR),
      permission: read,
      operation: "READ",
      sensitivity: "CONFIDENTIAL_PERSONNEL",
    });
    expect(decision).toMatchObject({
      decision: "ALLOW",
      constraint: {
        kind: "SCOPES",
        scopes: [
          {
            type: "AUDIT_ASSIGNMENT",
            organizationId: scope.ORG,
            recordGroupIds: [scope.GROUP],
          },
        ],
      },
    });
  });
});

describe("role scope-type boundary (ADR-0005 R6/R8)", () => {
  // A role may act only through its approved scope types: the auditor only
  // through AUDIT_ASSIGNMENT, the administrator only ORGANIZATION. A stored
  // assignment outside that set (bypassing the proposal validation) must
  // never grant anything.
  const disallowed = roleCodes.flatMap((role) =>
    (
      [
        "ASSIGNED_RECORDS",
        "TEAM",
        "BRANCH",
        "ORGANIZATION",
        "AUDIT_ASSIGNMENT",
      ] as const
    )
      .filter(
        (t) =>
          role !== "CANDIDATE" && !allowedScopeTypesByRole[role].includes(t),
      )
      .map((t) => [role, t] as const),
  );

  it.each(disallowed)(
    "never honors a stored %s assignment on a %s scope",
    async (role, type) => {
      const code = grantsOf(role).find(
        (c) => findPermission(c)!.operation === "READ",
      )!;
      const ref = {
        ASSIGNED_RECORDS: scope.SET,
        TEAM: scope.TEAM,
        BRANCH: scope.BRANCH,
        ORGANIZATION: scope.ORG,
        AUDIT_ASSIGNMENT: scope.AUDIT,
      }[type];
      const actor =
        role === "AUDITOR_READ_ONLY" ? account.AUDITOR : account.ACTOR;
      const { world, request } = strongestRequest(role, actor, code, type, ref);
      expectDeny(await world.decide(request), "POLICY_UNAVAILABLE");
    },
  );
});

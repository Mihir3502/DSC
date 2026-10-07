import { describe, expect, it, vi } from "vitest";
import type { PermissionDefinition } from "@/modules/identity-access/policy/permission-catalog";
import {
  account,
  expectDeny,
  matrixWorld,
  principalOf,
} from "../fixtures/authorization/matrix-harness";
import { record, scope } from "../fixtures/scopes";

// M1.7 §22: two engine branches cannot be reached with the accepted catalog
// (every permission is ACTIVE, and no READ/EXPORT permission has a workflow
// policy). This file injects synthetic definitions through the permission
// lookup only, so a future catalog change cannot silently turn either
// branch into an allow. Isolated in its own file so the mock never reaches
// another suite.

const synthetic = vi.hoisted(() => new Map<string, unknown>());

vi.mock(
  "@/modules/identity-access/policy/permission-catalog",
  async (importOriginal) => {
    const original =
      await importOriginal<
        typeof import("@/modules/identity-access/policy/permission-catalog")
      >();
    return {
      ...original,
      findPermission: (code: unknown) =>
        (typeof code === "string" && synthetic.get(code)) ||
        original.findPermission(code),
    };
  },
);

const { findPermission } =
  await import("@/modules/identity-access/policy/permission-catalog");
const base = findPermission("candidate.read.assigned") as PermissionDefinition;

describe("catalog-drift decision branches (§7, §22)", () => {
  it("denies a permission whose definition is no longer active", async () => {
    synthetic.set("candidate.read.retired", {
      ...base,
      code: "candidate.read.retired",
      status: "RETIRED",
    });
    const w = matrixWorld();
    w.assign(account.ACTOR, "RECRUITER", "ORGANIZATION", scope.ORG);
    expectDeny(
      await w.decide({
        principal: principalOf(account.ACTOR),
        permission: "candidate.read.retired",
        operation: "READ",
        resource: {
          kind: "RECORD",
          id: record.IN_TEAM,
          sensitivity: "INTERNAL",
        },
      }),
      "PERMISSION_MISSING",
    );
  });

  it("denies a list query for a workflow-governed permission", async () => {
    synthetic.set("candidate.read.workflow", {
      ...base,
      code: "candidate.read.workflow",
      workflowPolicy: "CANDIDACY_WORKFLOW",
    });
    const w = matrixWorld();
    w.assign(account.ACTOR, "RECRUITER", "ORGANIZATION", scope.ORG);
    const decision = await w.query({
      principal: principalOf(account.ACTOR),
      permission: "candidate.read.workflow",
      operation: "READ",
      sensitivity: "INTERNAL",
    });
    expect(decision.decision).toBe("DENY");
    expectDeny(decision, "WORKFLOW_STATE_DENIED");
  });
});

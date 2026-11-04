import { describe, expect, it } from "vitest";
import { permissionCatalog } from "./permission-catalog";
import {
  candidacyWorkflowPolicy,
  productionWorkflowPolicies,
} from "./workflow-policies";

// The production workflow registry stays as narrow as what is built (M2.4,
// ADR-0005): a workflow-gated permission denies unless its domain exists.

describe("production workflow policies", () => {
  it("permits only draft editing, and only in APPLICATION_INCOMPLETE", () => {
    const gated = permissionCatalog.filter((p) => p.workflowPolicy !== null);
    const permitted = gated.flatMap((p) =>
      candidacyWorkflowPolicy.states
        .filter((s) => candidacyWorkflowPolicy.permits(p.code, s, undefined))
        .map((s) => `${p.code}@${s}`),
    );
    expect(permitted.sort()).toEqual([
      "application.assist@APPLICATION_INCOMPLETE",
      "application.own.edit@APPLICATION_INCOMPLETE",
      "application.own.submit@APPLICATION_INCOMPLETE",
    ]);
  });

  it("denies an unknown state and registers no other policy", () => {
    expect(
      candidacyWorkflowPolicy.permits(
        "application.own.edit",
        "MADE_UP",
        undefined,
      ),
    ).toBe(false);
    expect([...productionWorkflowPolicies.keys()]).toEqual([
      "CANDIDACY_WORKFLOW",
    ]);
  });
});

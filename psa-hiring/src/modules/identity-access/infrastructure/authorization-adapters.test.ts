import { describe, expect, it } from "vitest";
import type {
  CandidateOwnershipResolver,
  ScopeResourceResolver,
} from "../application/ports/scope-resource-resolver";
import {
  NonproductionAssignmentHarness,
  RefusingAssignmentHarness,
} from "./assignment-harness";
import {
  SyntheticCandidateOwnership,
  SyntheticScopeResolver,
  UnavailableCandidateOwnership,
  UnavailableScopeResolver,
} from "./scope-resolvers";

// Fail-closed adapters and test-only harness refusal (packet M1.4 §9.3,
// §10.2, AC-M1.4-06, AC-M1.4-13).

const id = (n: number) =>
  `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const productionLike = [
  "production",
  "staging",
  "local",
  undefined,
  "",
  "TEST",
];

describe("authorization adapters", () => {
  it("refuses to construct test-only adapters outside APP_ENV=test", () => {
    for (const appEnv of productionLike) {
      expect(
        () => new NonproductionAssignmentHarness(appEnv),
        String(appEnv),
      ).toThrow(/only when APP_ENV is test/);
      expect(() => new SyntheticScopeResolver(appEnv), String(appEnv)).toThrow(
        /only when APP_ENV is test/,
      );
      expect(
        () => new SyntheticCandidateOwnership(appEnv),
        String(appEnv),
      ).toThrow(/only when APP_ENV is test/);
    }
    expect(new NonproductionAssignmentHarness("test").allowsBootstrap()).toBe(
      true,
    );
  });

  it("refuses bootstrap and resolves nothing by default", async () => {
    expect(new RefusingAssignmentHarness().allowsBootstrap()).toBe(false);
    const resolver: ScopeResourceResolver = new UnavailableScopeResolver();
    const ownership: CandidateOwnershipResolver =
      new UnavailableCandidateOwnership();
    const at = new Date();
    expect(await resolver.resolveScope("ORGANIZATION", id(1), at, {})).toEqual({
      status: "UNAVAILABLE",
    });
    expect(await resolver.resolveResource(id(1), at, {})).toEqual({
      status: "UNAVAILABLE",
    });
    expect(
      await resolver.hasRelationship(id(1), id(2), "INTERVIEWER", at, {}),
    ).toBe(false);
    expect(
      await resolver.hasDesignation(
        id(1),
        "READINESS_APPROVER",
        { type: "ORGANIZATION", id: id(3), organizationId: id(3) },
        at,
        {},
      ),
    ).toBe(false);
    expect(await ownership.owns(id(1), id(2), at, {})).toBe("UNAVAILABLE");
  });

  it("rejects cross-organization parentage, duplicate IDs, and type mismatches", async () => {
    const resolver = new SyntheticScopeResolver("test")
      .addOrganization(id(1))
      .addOrganization(id(2))
      .addBranch(id(3), id(1))
      .addBranch(id(4), id(2));
    expect(() => resolver.addTeam(id(5), id(3), id(2))).toThrow(
      /cross-organization/,
    );
    expect(() =>
      resolver.addRecord(id(6), { organizationId: id(1), branchId: id(4) }),
    ).toThrow(/cross-organization/);
    expect(() => resolver.addBranch(id(3), id(1))).toThrow(
      /already registered/,
    );
    expect(() => resolver.addBranch(id(7), id(3))).toThrow(/unknown synthetic/);
    expect(await resolver.resolveScope("TEAM", id(3), new Date(), {})).toEqual({
      status: "TYPE_MISMATCH",
    });
    expect(
      await resolver.resolveScope("BRANCH", id(99), new Date(), {}),
    ).toEqual({
      status: "MISSING",
    });
  });
});

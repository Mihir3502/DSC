import { describe, expect, it } from "vitest";
import { outcomeForDenial } from "@/modules/identity-access/delivery/authorization-error-mapper";
import type { DenyDecision } from "@/modules/identity-access/domain/authorization-decision";
import { permissionCatalog } from "@/modules/identity-access/policy/permission-catalog";
import {
  account,
  expectDeny,
  matrixWorld,
  principalOf,
} from "../fixtures/authorization/matrix-harness";
import { record, scope } from "../fixtures/scopes";

// M1.7 §12: Candidate A versus Candidate B through synthetic ownership
// envelopes (future M2 candidacy resources; no M2 persistence). Changing
// only the opaque identifier while keeping A's valid session must deny, and
// every "not yours" variant (B's record, invalid format, nonexistent, wrong
// type, out-of-scope, hidden) must map to the same external outcome so A
// cannot distinguish or enumerate them. Real owned account/session
// resources are covered against PostgreSQL in
// tests/integration/authorization/route-object-field.test.ts
// ("Candidate A cannot revoke or detect Candidate B's sessions").

const selfPermissions = permissionCatalog.filter(
  (p) => p.domain === "CANDIDATE_SELF",
);

const candidateA = principalOf(account.CANDIDATE_A, "CANDIDATE");

describe("Candidate A cross-record matrix (§12)", () => {
  it.each(selfPermissions.map((p) => [p.code, p] as const))(
    "Candidate A reaches only A's own envelope for %s",
    async (_code, p) => {
      const world = matrixWorld();
      const base = {
        principal: candidateA,
        permission: p.code,
        operation: p.operation,
        ...(p.workflowPolicy
          ? { workflow: { policy: p.workflowPolicy, state: "OPEN" } }
          : {}),
        ...(p.requiresReason ? { reasonCode: "MATRIX_TEST" } : {}),
      } as const;
      const at = (id: string) =>
        world.decide({
          ...base,
          resource: { kind: "RECORD", id, sensitivity: p.maxSensitivity },
        });
      expect((await at(record.IN_TEAM)).decision).toBe("ALLOW");

      const variants = [
        record.IN_BRANCH, // Candidate B's envelope
        record.NONEXISTENT, // well-formed but unknown
        record.OTHER_ORG, // exists, no owner relationship
        record.OWN_FILE, // staff member's own file
        scope.TEAM, // wrong type: a scope id, not a record
      ];
      const outcomes = new Set<string>();
      for (const id of variants) {
        const decision = await at(id);
        expectDeny(decision, "SCOPE_MISMATCH");
        outcomes.add(
          outcomeForDenial(decision as DenyDecision, "UNKNOWN").kind,
        );
      }
      // Invalid-format identifiers fail the request contract the same way.
      for (const id of ["", "not-a-uuid", "../../etc", `${record.IN_TEAM} `]) {
        const decision = await at(id);
        expectDeny(decision);
        outcomes.add(
          outcomeForDenial(decision as DenyDecision, "UNKNOWN").kind,
        );
      }
      // One external outcome for every "not yours" case: a safe not-found.
      expect([...outcomes]).toEqual(["NOT_FOUND"]);
    },
  );

  it("Candidate A's session cannot be used with Candidate B's account or a staff session", async () => {
    const p = selfPermissions[0]!;
    const world = matrixWorld();
    const request = (principal: ReturnType<typeof principalOf>) =>
      world.decide({
        principal,
        permission: p.code,
        operation: p.operation,
        resource: {
          kind: "RECORD",
          id: record.IN_BRANCH,
          sensitivity: p.maxSensitivity,
        },
        ...(p.workflowPolicy
          ? { workflow: { policy: p.workflowPolicy, state: "OPEN" } }
          : {}),
      });
    // A's session claiming to be B.
    expectDeny(
      await request({
        ...principalOf(account.CANDIDATE_B, "CANDIDATE"),
        sessionId: candidateA.sessionId,
      }),
      "UNAUTHENTICATED",
    );
    // B's real session reaches B's own envelope only.
    expect(
      (await request(principalOf(account.CANDIDATE_B, "CANDIDATE"))).decision,
    ).toBe("ALLOW");
    // Staff can never use candidate-self permissions, even for a record they can see.
    world.assign(account.ACTOR, "PSA_MANAGER", "ORGANIZATION", scope.ORG);
    expectDeny(await request(principalOf(account.ACTOR)), "PERMISSION_MISSING");
  });

  it("Candidate A cannot list, search, or count other candidates", async () => {
    const world = matrixWorld();
    for (const p of selfPermissions.filter((x) => x.operation === "READ")) {
      const decision = await world.query({
        principal: candidateA,
        permission: p.code,
        operation: "READ",
        sensitivity: p.maxSensitivity,
      });
      // The only possible list constraint is A's own account.
      if (decision.decision === "ALLOW") {
        expect(decision.constraint).toEqual({
          kind: "OWNER",
          accountId: account.CANDIDATE_A,
        });
      }
    }
    for (const code of ["candidate.read.assigned", "application.read"]) {
      expectDeny(
        await world.query({
          principal: candidateA,
          permission: code,
          operation: "READ",
          sensitivity: "CONFIDENTIAL_PERSONNEL",
        }),
        "PERMISSION_MISSING",
      );
    }
  });

  it("wrong-scope staff are denied before any payload and see the same not-found", async () => {
    const world = matrixWorld();
    world.assign(account.ACTOR, "RECRUITER", "TEAM", scope.TEAM2);
    const decide = (id: string) =>
      world.decide({
        principal: principalOf(account.ACTOR),
        permission: "candidate.read.assigned",
        operation: "READ",
        resource: { kind: "RECORD", id, sensitivity: "CONFIDENTIAL_PERSONNEL" },
      });
    const outcomes = new Set<string>();
    for (const id of [record.IN_TEAM, record.NONEXISTENT, record.OTHER_ORG]) {
      const decision = await decide(id);
      expectDeny(decision, "SCOPE_MISMATCH");
      outcomes.add(outcomeForDenial(decision as DenyDecision, "UNKNOWN").kind);
    }
    expect([...outcomes]).toEqual(["NOT_FOUND"]);
  });
});

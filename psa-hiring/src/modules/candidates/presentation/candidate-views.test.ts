import { describe, expect, it } from "vitest";
import { project } from "@/modules/identity-access";
import {
  candidateStartContract,
  duplicateQueueContract,
  prospectDetailContract,
} from "./candidate-views";

// Exact M2.2 projections (packet M2.2 §19, AC-M2.2-11): strict schemas
// refuse foreign fields (internal ids, duplicate data on candidate views,
// PII on the queue), and a view without its permission is refused whole.

const ctx = (
  contract: Readonly<{
    audience: "CANDIDATE" | "STAFF" | "SERVICE";
    purpose: "LIST" | "DETAIL" | "EDIT" | "REVIEW" | "STATUS" | "SECURITY";
  }>,
  allowed: string[],
) => ({
  audience: contract.audience,
  purpose: contract.purpose,
  allowed: new Set(allowed),
});

const startView = {
  opening: { title: "TEST Caregiver", location: "Testville", closes: null },
  needsPersonDetails: true,
  own: null,
};

describe("candidate projections", () => {
  it("projects the candidate start view only with the own-read permission", () => {
    expect(
      project(
        candidateStartContract,
        startView,
        ctx(candidateStartContract, ["candidate.candidacy.read_own"]),
      ).kind,
    ).toBe("PROJECTED");
    expect(
      project(
        candidateStartContract,
        startView,
        ctx(candidateStartContract, []),
      ).kind,
    ).not.toBe("PROJECTED");
  });

  it("never emits duplicate or identifier fields on the candidate view", () => {
    const result = project(
      candidateStartContract,
      {
        ...startView,
        possibleDuplicate: true,
        personId: "00000000-0000-4000-8000-000000000001",
      } as typeof startView,
      ctx(candidateStartContract, ["candidate.candidacy.read_own"]),
    );
    expect(result.kind).toBe("PROJECTED");
    expect(
      Object.keys(result.kind === "PROJECTED" ? result.value : {}).sort(),
    ).toEqual(["needsPersonDetails", "opening", "own"]);
    expect(
      project(
        candidateStartContract,
        {
          ...startView,
          opening: { ...startView.opening, cycleId: "x" },
        } as typeof startView,
        ctx(candidateStartContract, ["candidate.candidacy.read_own"]),
      ).kind,
    ).not.toBe("PROJECTED");
  });

  it("keeps personal data out of the duplicate queue", () => {
    const queue = {
      cases: [
        {
          id: "0123456789ab",
          tier: "HIGH" as const,
          status: "Pending review" as const,
          created: "2026-10-08",
        },
      ],
    };
    const allowed = ctx(duplicateQueueContract, ["candidate.duplicate.review"]);
    expect(project(duplicateQueueContract, queue, allowed).kind).toBe(
      "PROJECTED",
    );
    expect(
      project(
        duplicateQueueContract,
        {
          cases: [{ ...queue.cases[0]!, email: "t@example.test" }],
        } as unknown as typeof queue,
        allowed,
      ).kind,
    ).not.toBe("PROJECTED");
  });

  it("refuses an unknown stage or owner label on the staff detail", () => {
    const view = {
      id: "0123456789ab",
      reference: "C-0123ABCD",
      displayName: "TEST Person",
      email: "t@example.test",
      phone: null,
      opening: "TEST Caregiver · Testville",
      stage: "Prospect" as const,
      status: "Active" as const,
      source: "Staff entered" as const,
      owner: "Unassigned" as const,
      possibleDuplicate: false,
      history: [],
      version: 1,
      actions: [],
    };
    const allowed = ctx(prospectDetailContract, ["candidate.prospect.read"]);
    expect(project(prospectDetailContract, view, allowed).kind).toBe(
      "PROJECTED",
    );
    expect(
      project(
        prospectDetailContract,
        { ...view, stage: "Interview" } as unknown as typeof view,
        allowed,
      ).kind,
    ).not.toBe("PROJECTED");
    expect(
      project(
        prospectDetailContract,
        {
          ...view,
          owner: "00000000-0000-4000-8000-000000000001",
        } as unknown as typeof view,
        allowed,
      ).kind,
    ).not.toBe("PROJECTED");
  });
});

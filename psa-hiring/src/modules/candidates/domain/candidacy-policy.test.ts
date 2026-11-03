import { describe, expect, it } from "vitest";
import {
  candidacyPublicIdPattern,
  candidateReferencePattern,
  candidateVisibleStatus,
  canonicalPair,
  decideMerge,
  evaluateDuplicateSignals,
  isCandidacyPublicId,
  stageTransition,
  type MergeSide,
} from "./candidacy-policy";
import {
  newCandidateReference,
  newPublicId,
} from "../infrastructure/candidates-repository";

// Pure M2.2 rules (packet M2.2 §9–§15): named stage transitions, the
// candidate-visible status map, DUP-1 signals (names never match), and
// merge gates/survivor policy. Identifiers are synthetic.

describe("candidacy stage transitions", () => {
  const prospect = { stage: "PROSPECT", status: "ACTIVE" } as const;
  const started = {
    stage: "APPLICATION_INCOMPLETE",
    status: "ACTIVE",
  } as const;
  const closed = { stage: "PROSPECT", status: "TERMINAL" } as const;

  it("allows only the named M2.2 transitions", () => {
    expect(stageTransition("create_prospect", null)).toEqual(prospect);
    expect(stageTransition("start_application", null)).toEqual(started);
    expect(
      stageTransition("start_application_from_prospect", prospect),
    ).toEqual(started);
    expect(stageTransition("close_prospect", prospect)).toEqual(closed);
  });

  it("refuses repeated, backward, and reopening transitions", () => {
    expect(stageTransition("create_prospect", prospect)).toBeNull();
    expect(stageTransition("start_application", started)).toBeNull();
    expect(
      stageTransition("start_application_from_prospect", started),
    ).toBeNull();
    expect(
      stageTransition("start_application_from_prospect", closed),
    ).toBeNull();
    expect(stageTransition("close_prospect", started)).toBeNull();
    expect(stageTransition("close_prospect", closed)).toBeNull();
    expect(stageTransition("start_application_from_prospect", null)).toBeNull();
  });

  it("maps internal stage to a plain candidate-visible status", () => {
    expect(candidateVisibleStatus("PROSPECT", "ACTIVE")).toBe("NOT_STARTED");
    expect(candidateVisibleStatus("APPLICATION_INCOMPLETE", "ACTIVE")).toBe(
      "APPLICATION_STARTED",
    );
    expect(candidateVisibleStatus("PROSPECT", "TERMINAL")).toBe("CLOSED");
    expect(candidateVisibleStatus("APPLICATION_INCOMPLETE", "ARCHIVED")).toBe(
      "CLOSED",
    );
  });
});

describe("DUP-1 duplicate signals", () => {
  const a = { emailNormalized: "a@example.test", phoneE164: "+15025550142" };

  it("scores exact email HIGH and exact phone MEDIUM", () => {
    expect(evaluateDuplicateSignals(a, { ...a })).toEqual({
      signals: ["EXACT_EMAIL", "EXACT_PHONE"],
      tier: "HIGH",
    });
    expect(
      evaluateDuplicateSignals(a, {
        emailNormalized: "b@example.test",
        phoneE164: "+15025550142",
      }),
    ).toEqual({ signals: ["EXACT_PHONE"], tier: "MEDIUM" });
  });

  it("never matches on absent phones or anything other than exact values", () => {
    expect(
      evaluateDuplicateSignals(
        { emailNormalized: "a@example.test", phoneE164: null },
        { emailNormalized: "c@example.test", phoneE164: null },
      ),
    ).toBeNull();
    expect(
      evaluateDuplicateSignals(a, {
        emailNormalized: "a@example.tes",
        phoneE164: "+15025550143",
      }),
    ).toBeNull();
  });

  it("orders pairs canonically and refuses a self-pair", () => {
    expect(canonicalPair("b", "a")).toEqual(["a", "b"]);
    expect(canonicalPair("a", "b")).toEqual(["a", "b"]);
    expect(() => canonicalPair("a", "a")).toThrow();
  });
});

describe("merge gates and survivor policy", () => {
  const side = (over: Partial<MergeSide>): MergeSide => ({
    personId: "p-1",
    status: "ACTIVE",
    candidateAccountId: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    activeCycleIds: [],
    ...over,
  });
  const older = side({ personId: "p-2" });
  const newer = side({
    personId: "p-1",
    createdAt: new Date("2026-02-01T00:00:00Z"),
  });

  it("requires a confirmed case and two active people", () => {
    expect(decideMerge("PENDING", older, newer)).toEqual({
      kind: "BLOCKED",
      reason: "BLOCKED_CASE_NOT_CONFIRMED",
    });
    expect(
      decideMerge("CONFIRMED_DUPLICATE", older, { ...newer, status: "MERGED" }),
    ).toEqual({ kind: "BLOCKED", reason: "BLOCKED_PERSON_NOT_ACTIVE" });
  });

  it("blocks two different candidate accounts and same-cycle collisions", () => {
    expect(
      decideMerge(
        "CONFIRMED_DUPLICATE",
        { ...older, candidateAccountId: "acct-1" },
        { ...newer, candidateAccountId: "acct-2" },
      ),
    ).toEqual({ kind: "BLOCKED", reason: "BLOCKED_TWO_CANDIDATE_ACCOUNTS" });
    expect(
      decideMerge(
        "CONFIRMED_DUPLICATE",
        { ...older, activeCycleIds: ["cycle-1"] },
        { ...newer, activeCycleIds: ["cycle-1"] },
      ),
    ).toEqual({
      kind: "BLOCKED",
      reason: "BLOCKED_CURRENT_CANDIDACY_COLLISION",
    });
  });

  it("keeps the account-owned person, otherwise the older record", () => {
    const owned = decideMerge("CONFIRMED_DUPLICATE", older, {
      ...newer,
      candidateAccountId: "acct-1",
    });
    expect(owned.kind === "MERGE" && owned.survivor.personId).toBe("p-1");
    expect(owned.kind === "MERGE" && owned.resolutionCodes).toContain(
      "SURVIVOR_ACCOUNT_OWNED",
    );
    const plain = decideMerge("CONFIRMED_DUPLICATE", newer, older);
    expect(plain.kind === "MERGE" && plain.survivor.personId).toBe("p-2");
    const transfer = decideMerge(
      "CONFIRMED_DUPLICATE",
      { ...older, candidateAccountId: "acct-1" },
      { ...newer, candidateAccountId: "acct-1" },
    );
    expect(transfer.kind).toBe("MERGE");
  });

  it("breaks creation-time ties by identifier, deterministically", () => {
    const tie = decideMerge(
      "CONFIRMED_DUPLICATE",
      side({ personId: "p-9" }),
      side({ personId: "p-3" }),
    );
    expect(tie.kind === "MERGE" && tie.survivor.personId).toBe("p-3");
  });
});

describe("references", () => {
  it("generates well-formed, varied references and route ids", () => {
    const refs = new Set<string>();
    const ids = new Set<string>();
    for (let i = 0; i < 500; i += 1) {
      const ref = newCandidateReference();
      const id = newPublicId();
      expect(ref).toMatch(candidateReferencePattern);
      expect(id).toMatch(candidacyPublicIdPattern);
      refs.add(ref);
      ids.add(id);
    }
    expect(refs.size).toBe(500);
    expect(ids.size).toBe(500);
    expect(isCandidacyPublicId("0123456789ab")).toBe(true);
    expect(isCandidacyPublicId("0123456789AB")).toBe(false);
    expect(isCandidacyPublicId("0123456789ai")).toBe(false);
  });
});

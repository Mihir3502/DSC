import { describe, expect, it } from "vitest";
import {
  candidateNavigation,
  candidateStatusCode,
  candidateStatusWording,
  compareWorkItems,
  isActionable,
  parseTaskFilter,
  resolveNextAction,
  selectCurrentCandidacy,
  taskCategory,
  workTypes,
  type ContextCandidate,
  type WorkItemFacts,
} from "./candidate-portal";
import { candidacyStages, candidacyStatuses } from "./candidacy-policy";

// Candidate portal rules (packet M2.3 §7–§12; AC-M2.3-02/03/04/08).

const incomplete = { stage: "APPLICATION_INCOMPLETE", status: "ACTIVE" };
const at = (minute: number) => new Date(Date.UTC(2026, 10, 3, 12, minute));
const item = (over: Partial<WorkItemFacts> = {}): WorkItemFacts => ({
  id: "a",
  workTypeCode: "COMPLETE_APPLICATION",
  status: "OPEN",
  priority: "NORMAL",
  dueAt: null,
  createdAt: at(0),
  ...over,
});

describe("candidate-visible status", () => {
  it("maps every accepted stage and status to reviewed wording, with no internal code", () => {
    for (const stage of candidacyStages) {
      for (const status of candidacyStatuses) {
        const code = candidateStatusCode(stage, status);
        expect(code).not.toBe("UNAVAILABLE");
        const wording = JSON.stringify(candidateStatusWording[code]);
        expect(wording).not.toMatch(/PROSPECT|INCOMPLETE|ACTIVE|TERMINAL/);
      }
    }
  });

  it("fails closed for an unknown stage or status", () => {
    expect(candidateStatusCode("MADE_UP", "ACTIVE")).toBe("UNAVAILABLE");
    expect(candidateStatusCode("PROSPECT", "MADE_UP")).toBe("UNAVAILABLE");
  });

  it("promises no selection, employment, eligibility, or timing", () => {
    expect(JSON.stringify(candidateStatusWording)).not.toMatch(
      /selected|hired|employ|eligible|approved|days|guarantee/i,
    );
  });
});

describe("next action", () => {
  it("returns one action, ranked by priority, due date, age, and stable ID", () => {
    const later = item({ id: "b", dueAt: at(30) });
    const sooner = item({ id: "c", dueAt: at(10) });
    const high = item({ id: "d", priority: "HIGH", dueAt: at(50) });
    expect(
      [later, sooner, high, item({ id: "a" })]
        .sort(compareWorkItems)
        .map((i) => i.id),
    ).toEqual(["d", "c", "b", "a"]);
    expect(resolveNextAction(incomplete, [later, sooner])?.dueAt).toEqual(
      at(10),
    );
  });

  it("falls back to the stage when no task row exists, with no invented due date", () => {
    expect(resolveNextAction(incomplete, [])).toEqual({
      workTypeCode: "COMPLETE_APPLICATION",
      dueAt: null,
    });
  });

  it("offers no action for a stale, unknown, or finished item, or an ineligible candidacy", () => {
    const closed = { stage: "APPLICATION_INCOMPLETE", status: "TERMINAL" };
    const prospect = { stage: "PROSPECT", status: "ACTIVE" };
    expect(resolveNextAction(closed, [item()])).toBeNull();
    expect(resolveNextAction(prospect, [item()])).toBeNull();
    expect(isActionable(item({ workTypeCode: "MADE_UP" }), incomplete)).toBe(
      false,
    );
    expect(isActionable(item({ status: "COMPLETED" }), incomplete)).toBe(false);
    expect(isActionable(item({ status: "CANCELED" }), incomplete)).toBe(false);
  });

  it("registers only the M2.3 work type", () => {
    expect(Object.keys(workTypes)).toEqual(["COMPLETE_APPLICATION"]);
  });
});

describe("task filters and categories", () => {
  it("allowlists filters and defaults to action needed", () => {
    expect(parseTaskFilter(undefined)).toBe("action_needed");
    expect(parseTaskFilter("completed")).toBe("completed");
    for (const bad of ["ALL", "", "completed'", ["completed"], 1]) {
      expect(parseTaskFilter(bad)).toBeNull();
    }
  });

  it("keeps finished tasks as history and hides stale active ones", () => {
    const closed = { stage: "PROSPECT", status: "TERMINAL" };
    expect(taskCategory(item(), incomplete)).toBe("action_needed");
    expect(taskCategory(item(), closed)).toBeNull();
    expect(taskCategory(item({ status: "COMPLETED" }), closed)).toBe(
      "completed",
    );
    expect(taskCategory(item({ status: "CANCELED" }), closed)).toBe(
      "completed",
    );
    expect(
      taskCategory(item({ workTypeCode: "MADE_UP" }), incomplete),
    ).toBeNull();
  });
});

describe("after submission", () => {
  const submitted = { stage: "APPLICATION_SUBMITTED", status: "ACTIVE" };

  it("offers no next action, shows the task under review, and uses plain wording", () => {
    expect(resolveNextAction(submitted, [])).toBeNull();
    expect(taskCategory(item({ status: "COMPLETED" }), submitted)).toBe(
      "under_review",
    );
    expect(
      taskCategory(item({ status: "COMPLETED" }), {
        stage: "APPLICATION_SUBMITTED",
        status: "TERMINAL",
      }),
    ).toBe("completed");
    expect(candidateStatusCode("APPLICATION_SUBMITTED", "ACTIVE")).toBe(
      "APPLICATION_SUBMITTED",
    );
  });
});

describe("candidacy context", () => {
  const candidate = (over: Partial<ContextCandidate>): ContextCandidate => ({
    ...incomplete,
    publicId: "aaaaaaaaaaaa",
    updatedAt: at(0),
    closedAt: null,
    hasAction: false,
    nearestDue: null,
    ...over,
  });

  it("selects by action, due date, recency, closure, then stable ID", () => {
    const action = candidate({ publicId: "action", hasAction: true });
    const due = candidate({ publicId: "due", nearestDue: at(5) });
    const recent = candidate({ publicId: "recent", updatedAt: at(40) });
    const closed = candidate({
      publicId: "closed",
      status: "TERMINAL",
      closedAt: at(59),
      updatedAt: at(59),
    });
    expect(
      selectCurrentCandidacy([closed, recent, due, action])?.publicId,
    ).toBe("action");
    expect(selectCurrentCandidacy([closed, recent, due])?.publicId).toBe("due");
    expect(selectCurrentCandidacy([closed, recent])?.publicId).toBe("recent");
    expect(selectCurrentCandidacy([closed])?.publicId).toBe("closed");
    expect(
      selectCurrentCandidacy([
        candidate({ publicId: "bbb" }),
        candidate({ publicId: "aaa" }),
      ])?.publicId,
    ).toBe("aaa");
    expect(selectCurrentCandidacy([])).toBeNull();
  });
});

describe("navigation", () => {
  it("lists only implemented destinations, and Application only with a candidacy", () => {
    expect(candidateNavigation(null).map((e) => e.label)).toEqual([
      "Home",
      "My Tasks",
      "Security",
      "Help",
    ]);
    expect(candidateNavigation("abcdefghjkmn").map((e) => e.label)).toEqual([
      "Home",
      "Application",
      "My Tasks",
      "Security",
      "Help",
    ]);
    expect(JSON.stringify(candidateNavigation("abcdefghjkmn"))).not.toMatch(
      /Documents|Messages|Training|Offer|Screening|Onboarding|Competency/,
    );
  });
});

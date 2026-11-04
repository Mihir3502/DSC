import { describe, expect, it } from "vitest";
import {
  blockerLabels,
  deriveBlockers,
  mergeTimeline,
  stageEventLabels,
  workspaceTabs,
} from "./candidate-workspace";

const active = {
  stage: "APPLICATION_SUBMITTED",
  status: "ACTIVE",
  returned: false,
  overdue: false,
  unassigned: false,
  possibleDuplicate: false,
};

describe("workspace tabs", () => {
  it("offers Application only with permission and a submission, and never a count", () => {
    const keys = (canReadApplication: boolean, everSubmitted: boolean) =>
      workspaceTabs("0123456789ab", { canReadApplication, everSubmitted }).map(
        (t) => t.key,
      );
    expect(keys(true, true)).toEqual(["overview", "application"]);
    expect(keys(false, true)).toEqual(["overview"]);
    expect(keys(true, false)).toEqual(["overview"]);
    for (const tab of workspaceTabs("0123456789ab", {
      canReadApplication: true,
      everSubmitted: true,
    })) {
      expect(Object.keys(tab).sort()).toEqual(["href", "key", "label"]);
      expect(tab.label).not.toMatch(/\d/);
    }
  });
});

describe("blockers", () => {
  it("reports each stored fact, and nothing when none apply", () => {
    expect(deriveBlockers(active)).toEqual([]);
    expect(deriveBlockers({ ...active, unassigned: true })).toEqual([
      "NO_OWNER",
    ]);
    expect(deriveBlockers({ ...active, overdue: true })).toEqual([
      "STAFF_WORK_OVERDUE",
    ]);
    expect(deriveBlockers({ ...active, possibleDuplicate: true })).toEqual([
      "POSSIBLE_DUPLICATE",
    ]);
    expect(
      deriveBlockers({ ...active, stage: "APPLICATION_INCOMPLETE" }),
    ).toEqual(["WAITING_FOR_SUBMISSION"]);
  });

  it("shows a return instead of a plain wait", () => {
    expect(
      deriveBlockers({
        ...active,
        stage: "APPLICATION_INCOMPLETE",
        returned: true,
      }),
    ).toEqual(["RETURNED_FOR_CORRECTION"]);
  });

  it("has none for a closed record, whatever else is true", () => {
    expect(
      deriveBlockers({
        ...active,
        status: "TERMINAL",
        unassigned: true,
        overdue: true,
      }),
    ).toEqual([]);
  });

  it("never words a blocker as a compliance result", () => {
    for (const label of Object.values(blockerLabels)) {
      expect(label).not.toMatch(/clear|approved|screening|compliance|hold$/i);
    }
  });
});

describe("timeline", () => {
  const at = (minute: number, name: string) => ({
    occurredAt: new Date(Date.UTC(2027, 0, 1, 0, minute)),
    name,
  });

  it("merges newest first, keeps ties stable, and honors the bound", () => {
    const merged = mergeTimeline(
      [
        [at(1, "a"), at(3, "b")],
        [at(3, "c"), at(2, "d")],
      ],
      3,
    );
    expect(merged.map((e) => e.name)).toEqual(["b", "c", "d"]);
  });

  it("has wording for every stage-history command", () => {
    expect(Object.keys(stageEventLabels).sort()).toEqual(
      [
        "close_prospect",
        "create_prospect",
        "return_application",
        "start_application",
        "start_application_from_prospect",
        "submit_application",
      ].sort(),
    );
  });
});

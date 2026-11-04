import { describe, expect, it } from "vitest";
import { staffNavigation, type StaffMenuFacts } from "./staff-navigation";

const none: StaffMenuFacts = {
  workQueue: false,
  addCandidate: false,
  submittedApplications: false,
  positions: false,
  duplicates: false,
};
const labels = (facts: Partial<StaffMenuFacts>) =>
  staffNavigation({ ...none, ...facts }).map((e) => e.label);

describe("staff menu", () => {
  it("always leaves Security, and nothing else, for someone with no permissions", () => {
    expect(labels({})).toEqual(["Security"]);
  });

  it("adds each item only with its own fact, in a fixed order", () => {
    expect(labels({ positions: true })).toEqual(["Positions", "Security"]);
    expect(labels({ submittedApplications: true })).toEqual([
      "Submitted Applications",
      "Security",
    ]);
    expect(
      labels({
        workQueue: true,
        addCandidate: true,
        submittedApplications: true,
        positions: true,
        duplicates: true,
      }),
    ).toEqual([
      "Dashboard",
      "Work Queue",
      "Add Candidate",
      "Submitted Applications",
      "Positions",
      "Possible Duplicates",
      "Security",
    ]);
  });

  it("links only to staff routes, with unique keys", () => {
    const entries = staffNavigation({
      workQueue: true,
      addCandidate: true,
      submittedApplications: true,
      positions: true,
      duplicates: true,
    });
    for (const entry of entries) expect(entry.href).toMatch(/^\/staff(\/|$)/);
    expect(new Set(entries.map((e) => e.key)).size).toBe(entries.length);
  });
});

import { describe, expect, it } from "vitest";
import { grantCatalog } from "@/modules/identity-access/policy/role-permission-catalog";
import {
  decodeWorkQueueCursor,
  dueWindow,
  emptyWorkQueueFilters,
  encodeWorkQueueCursor,
  nextStaffAction,
  parseDueDate,
  parseWorkQueueFilters,
  workerPathLabels,
  workQueueQuery,
} from "./work-queue";

const NOW = new Date("2027-03-10T15:00:00.000Z");
const CREATED = "2027-03-01T10:00:00.123456Z";

describe("work queue filters", () => {
  it("accepts every closed value and treats blanks as no filter", () => {
    expect(parseWorkQueueFilters({})).toEqual(emptyWorkQueueFilters);
    expect(
      parseWorkQueueFilters({ stage: "", assignment: "", branch: "" }),
    ).toEqual(emptyWorkQueueFilters);
    expect(
      parseWorkQueueFilters({
        assignment: "TEAM",
        stage: "APPLICATION_SUBMITTED",
        due: "OVERDUE",
        workerPath: "CONTRACTOR",
        exception: "RETURNED",
      }),
    ).toMatchObject({ assignment: "TEAM", workerPath: "CONTRACTOR" });
  });

  it.each([
    ["an unknown name", { owner: "x" }],
    ["an authority field", { organizationId: "x" }],
    ["an unknown stage", { stage: "OFFER" }],
    ["an approved-looking path", { workerPath: "APPROVED_1099" }],
    ["a repeated value", { stage: ["PROSPECT", "PROSPECT"] }],
    ["a malformed branch", { branch: "abc" }],
    ["a control character", { due: "OVERDUE\n" }],
    ["a malformed cursor", { after: "abc" }],
  ])("refuses %s", (_name, search) => {
    expect(parseWorkQueueFilters(search)).toBeNull();
  });

  it("never lets a proposal read as an approved worker path", () => {
    for (const label of Object.values(workerPathLabels)) {
      expect(label).not.toMatch(/approved|1099/i);
    }
  });

  it("builds page links from filters, without a cursor unless asked", () => {
    expect(workQueueQuery(emptyWorkQueueFilters)).toBe("");
    expect(
      workQueueQuery({ ...emptyWorkQueueFilters, stage: "PROSPECT" }, "c"),
    ).toBe("?stage=PROSPECT&after=c");
  });
});

describe("work queue cursor", () => {
  it("round-trips exact instants, with or without a due date", () => {
    for (const cursor of [
      { dueAt: null, createdAt: CREATED, publicId: "0123456789ab" },
      {
        dueAt: "2027-03-12T23:59:59.999000Z",
        createdAt: CREATED,
        publicId: "0123456789ab",
      },
    ]) {
      expect(decodeWorkQueueCursor(encodeWorkQueueCursor(cursor))).toEqual(
        cursor,
      );
    }
  });

  it.each([
    "x".repeat(81),
    "none~only-two",
    `none~2027-03-01T10:00:00Z~0123456789ab`,
    `none~${CREATED}~NOT-A-PUBLIC-ID`,
    `2027-99-99T00:00:00.000000Z~${CREATED}~0123456789ab`,
    `none~${CREATED}~0123456789ab~extra`,
  ])("refuses %s", (value) => {
    expect(decodeWorkQueueCursor(value)).toBeNull();
  });
});

describe("due dates", () => {
  it("runs a due date to the end of that UTC day, and blank clears it", () => {
    expect(parseDueDate("2027-03-10", NOW)).toEqual({
      ok: true,
      dueAt: new Date("2027-03-10T23:59:59.999Z"),
    });
    expect(parseDueDate("", NOW)).toEqual({ ok: true, dueAt: null });
    expect(parseDueDate(undefined, NOW)).toEqual({ ok: true, dueAt: null });
  });

  it.each([
    "2027-03-09",
    "2028-03-10",
    "2027-02-31",
    "03/10/2027",
    "2027-03-10T00:00:00Z",
  ])("refuses %s", (value) => {
    expect(parseDueDate(value, NOW)).toEqual({ ok: false });
  });

  it("accepts the last allowed day and refuses a non-string", () => {
    expect(parseDueDate("2028-03-09", NOW).ok).toBe(true);
    expect(parseDueDate(20270310, NOW)).toEqual({ ok: false });
  });

  it("derives due windows from the clock", () => {
    expect(dueWindow("TODAY", NOW)).toEqual({
      from: NOW,
      to: new Date("2027-03-11T00:00:00.000Z"),
    });
    expect(dueWindow("NEXT_7", NOW).to).toEqual(
      new Date("2027-03-18T00:00:00.000Z"),
    );
  });
});

describe("next staff action", () => {
  it("offers only what exists for each stage", () => {
    expect(nextStaffAction("PROSPECT", false, false)).toMatch(/Start/);
    expect(nextStaffAction("APPLICATION_INCOMPLETE", false, false)).toMatch(
      /candidate to submit/,
    );
    expect(nextStaffAction("APPLICATION_INCOMPLETE", true, false)).toMatch(
      /correction/,
    );
    expect(nextStaffAction("APPLICATION_SUBMITTED", false, true)).toMatch(
      /Review/,
    );
    expect(nextStaffAction("APPLICATION_SUBMITTED", false, false)).toBe(
      "None right now",
    );
    expect(nextStaffAction("UNKNOWN", false, true)).toBe("None right now");
  });
});

describe("work queue grants", () => {
  const holders = (permission: string) =>
    grantCatalog
      .filter((g) => g.permissionCode === permission)
      .map((g) => g.roleCode)
      .sort();

  it("grants exactly the approved roles, and nothing to auditors or administrators", () => {
    expect(holders("candidate.work_queue.read")).toEqual([
      "HR_SPECIALIST",
      "PSA_MANAGER",
      "RECRUITER",
    ]);
    expect(holders("candidate.due_date.manage")).toEqual([
      "PSA_MANAGER",
      "RECRUITER",
    ]);
    expect(holders("candidate.owner.assign_others")).toEqual(["PSA_MANAGER"]);
  });
});

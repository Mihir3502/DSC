import { describe, expect, it } from "vitest";
import {
  cycleEditable,
  cycleTransition,
  effectiveAvailability,
  hierarchyTransition,
  positionTransition,
  windowCoherent,
  withinWindow,
  type CycleCommand,
} from "./lifecycle";
import { cycleStatuses, hierarchyStatuses, positionStatuses } from "./values";

// M2.1 named transitions and effective availability (packet M2.1 §7–§12;
// AC-M2.1-06/08). Every (command, from-status) pair is enumerated.

describe("hiring-cycle transitions", () => {
  const allowed: Readonly<Record<CycleCommand, Record<string, string>>> = {
    publish: { DRAFT: "PUBLISHED" },
    open: { PUBLISHED: "OPEN" },
    close: { OPEN: "CLOSED", PUBLISHED: "CLOSED" },
    cancel: { DRAFT: "CANCELLED", PUBLISHED: "CANCELLED", OPEN: "CANCELLED" },
    archive: { CLOSED: "ARCHIVED", CANCELLED: "ARCHIVED" },
  };

  for (const command of Object.keys(allowed) as CycleCommand[]) {
    for (const from of cycleStatuses) {
      it(`${command} from ${from}`, () => {
        expect(cycleTransition(command, from)).toBe(
          allowed[command][from] ?? null,
        );
      });
    }
  }

  it("never returns a closed, cancelled, or archived cycle to published or open", () => {
    for (const from of ["CLOSED", "CANCELLED", "ARCHIVED"] as const) {
      expect(cycleTransition("open", from)).toBeNull();
      expect(cycleTransition("publish", from)).toBeNull();
    }
  });

  it("edits only drafts", () => {
    expect(cycleStatuses.filter(cycleEditable)).toEqual(["DRAFT"]);
  });
});

describe("hierarchy and position transitions", () => {
  it("activates drafts and inactive rows and inactivates only active ones", () => {
    for (const from of hierarchyStatuses) {
      expect(hierarchyTransition("activate", from)).toBe(
        from === "DRAFT" || from === "INACTIVE" ? "ACTIVE" : null,
      );
      expect(hierarchyTransition("inactivate", from)).toBe(
        from === "ACTIVE" ? "INACTIVE" : null,
      );
    }
  });

  it("retires any non-retired position and never reactivates a retired one", () => {
    for (const from of positionStatuses) {
      expect(positionTransition("retire", from)).toBe(
        from === "RETIRED" ? null : "RETIRED",
      );
    }
    expect(positionTransition("activate", "RETIRED")).toBeNull();
  });
});

describe("the application window", () => {
  const opensAt = new Date("2026-11-01T13:00:00.000Z");
  const closesAt = new Date("2026-11-08T13:00:00.000Z");
  const window = { opensAt, closesAt, openEnded: false };

  it("is coherent only when closing strictly after opening, or explicitly open-ended", () => {
    expect(windowCoherent(window)).toBe(true);
    expect(windowCoherent({ ...window, closesAt: opensAt })).toBe(false);
    expect(windowCoherent({ ...window, closesAt: null })).toBe(false);
    expect(windowCoherent({ opensAt, closesAt: null, openEnded: true })).toBe(
      true,
    );
    expect(windowCoherent({ opensAt, closesAt, openEnded: true })).toBe(false);
    expect(windowCoherent({ ...window, opensAt: new Date(Number.NaN) })).toBe(
      false,
    );
  });

  it("opens inclusively and closes exclusively", () => {
    expect(withinWindow(window, new Date(opensAt.getTime() - 1))).toBe(false);
    expect(withinWindow(window, opensAt)).toBe(true);
    expect(withinWindow(window, new Date(closesAt.getTime() - 1))).toBe(true);
    expect(withinWindow(window, closesAt)).toBe(false);
  });
});

describe("effective public availability", () => {
  const base = {
    opensAt: new Date("2026-11-01T13:00:00.000Z"),
    closesAt: new Date("2026-11-08T13:00:00.000Z"),
    openEnded: false,
    everOpened: true,
    parentsActive: true,
  };
  const at = (iso: string) => new Date(iso);

  it("accepts only OPEN cycles inside the window with every parent active", () => {
    expect(
      effectiveAvailability(
        { ...base, status: "OPEN" },
        at("2026-11-02T00:00:00Z"),
      ),
    ).toBe("ACCEPTING");
    expect(
      effectiveAvailability(
        { ...base, status: "OPEN" },
        at("2026-11-08T12:59:59.999Z"),
      ),
    ).toBe("ACCEPTING");
  });

  it("stops accepting at exactly closes_at even though the stored status is still OPEN", () => {
    expect(
      effectiveAvailability(
        { ...base, status: "OPEN" },
        at("2026-11-08T13:00:00.000Z"),
      ),
    ).toBe("NO_LONGER_ACCEPTING");
  });

  it("fails closed when a parent is inactive", () => {
    expect(
      effectiveAvailability(
        { ...base, status: "OPEN", parentsActive: false },
        at("2026-11-02T00:00:00Z"),
      ),
    ).toBe("NO_LONGER_ACCEPTING");
  });

  it("hides drafts, published-not-open (upcoming not approved), cancelled, archived, and never-opened closed cycles", () => {
    for (const status of [
      "DRAFT",
      "PUBLISHED",
      "CANCELLED",
      "ARCHIVED",
    ] as const) {
      expect(
        effectiveAvailability({ ...base, status }, at("2026-11-02T00:00:00Z")),
        status,
      ).toBe("NOT_PUBLIC");
    }
    expect(
      effectiveAvailability(
        { ...base, status: "CLOSED", everOpened: false },
        at("2026-11-02T00:00:00Z"),
      ),
    ).toBe("NOT_PUBLIC");
    expect(
      effectiveAvailability(
        { ...base, status: "CLOSED", everOpened: true },
        at("2026-11-02T00:00:00Z"),
      ),
    ).toBe("NO_LONGER_ACCEPTING");
  });

  it("keeps an open-ended cycle accepting until it is closed", () => {
    expect(
      effectiveAvailability(
        { ...base, status: "OPEN", closesAt: null, openEnded: true },
        at("2099-01-01T00:00:00Z"),
      ),
    ).toBe("ACCEPTING");
  });
});

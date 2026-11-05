import { describe, expect, it } from "vitest";
import {
  holdCategories,
  holdCategoryLabels,
  normalizeHoldReason,
  parseHoldReviewDate,
} from "./holds";

const NOW = new Date("2027-03-10T15:00:00.000Z");

describe("holds", () => {
  it("runs a review date to the end of that UTC day, within 180 days", () => {
    expect(parseHoldReviewDate("2027-03-10", NOW)).toEqual(
      new Date("2027-03-10T23:59:59.999Z"),
    );
    for (const bad of [
      "2027-03-09",
      "2028-01-01",
      "2027-02-31",
      "soon",
      undefined,
    ]) {
      expect(parseHoldReviewDate(bad, NOW)).toBeNull();
    }
  });

  it("requires a bounded reason with no control characters", () => {
    expect(normalizeHoldReason(" TEST ")).toBe("TEST");
    for (const bad of ["", "   ", "x".repeat(1001), "a\u0007b", 5]) {
      expect(normalizeHoldReason(bad)).toBeNull();
    }
  });

  it("has wording for every category", () => {
    for (const category of holdCategories) {
      expect(holdCategoryLabels[category].length).toBeGreaterThan(0);
    }
  });
});

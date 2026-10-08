import { describe, expect, it } from "vitest";
import { formatInZone, parseZonedLocal, toZonedLocal } from "./zoned-time";

// Wall-clock ↔ UTC for staff-entered windows (packet M2.1 §12.4, TEST_STRATEGY
// §9: explicit UTC boundaries and DST). Nonexistent and ambiguous local
// times are refused rather than guessed.

describe("zoned local time", () => {
  it("converts a local New York time to the right UTC instant in winter and summer", () => {
    expect(parseZonedLocal("2026-01-15T09:00", "America/New_York")).toEqual({
      ok: true,
      instant: new Date("2026-01-15T14:00:00.000Z"),
    });
    expect(parseZonedLocal("2026-07-15T09:00", "America/New_York")).toEqual({
      ok: true,
      instant: new Date("2026-07-15T13:00:00.000Z"),
    });
  });

  it("refuses the nonexistent spring-forward hour and the ambiguous fall-back hour", () => {
    expect(parseZonedLocal("2026-03-08T02:30", "America/New_York")).toEqual({
      ok: false,
      problem: "NONEXISTENT_LOCAL_TIME",
    });
    expect(parseZonedLocal("2026-11-01T01:30", "America/New_York")).toEqual({
      ok: false,
      problem: "AMBIGUOUS_LOCAL_TIME",
    });
  });

  it("refuses malformed, impossible, and out-of-range values", () => {
    for (const bad of [
      "2026-02-30T09:00",
      "2026-13-01T09:00",
      "2026-01-01T24:00",
      "2026-01-01 09:00",
      "1999-12-31T23:59",
      "2026-01-01T09:00Z",
      "",
      42,
    ]) {
      expect(parseZonedLocal(bad, "UTC"), String(bad)).toEqual({
        ok: false,
        problem: "INVALID",
      });
    }
  });

  it("round-trips and formats with the zone name", () => {
    const instant = new Date("2026-10-09T21:00:00.000Z");
    expect(toZonedLocal(instant, "America/New_York")).toBe("2026-10-09T17:00");
    expect(formatInZone(instant, "America/New_York")).toBe(
      "Oct 9, 2026, 5:00 PM EDT",
    );
    expect(formatInZone(instant, "America/Chicago")).toMatch(/4:00 PM CDT$/);
  });
});

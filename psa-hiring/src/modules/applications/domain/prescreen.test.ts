import { describe, expect, it } from "vitest";
import {
  normalizeNotes,
  parseChecklistItems,
  parseResponses,
  passBlocker,
  type PrescreenFacts,
} from "./prescreen";

const items = [
  { code: "a", label: "A" },
  { code: "b", label: "B" },
];
const facts = (over: Partial<PrescreenFacts>): PrescreenFacts => ({
  items,
  responses: { a: "MET", b: "NOT_APPLICABLE" },
  responsesVersion: 2,
  exceptionResponsesVersion: null,
  ...over,
});

describe("prescreen rules", () => {
  it("passes only with every answer in and every unmet item excepted", () => {
    expect(passBlocker(facts({}))).toBeNull();
    expect(passBlocker(facts({ responses: { a: "MET" } }))).toBe(
      "PRESCREEN_INCOMPLETE",
    );
    const unmet = { responses: { a: "NOT_MET", b: "MET" } };
    expect(passBlocker(facts(unmet))).toBe("EXCEPTION_REQUIRED");
    expect(
      passBlocker(facts({ ...unmet, exceptionResponsesVersion: 2 })),
    ).toBeNull();
    expect(passBlocker(facts({ items: [], responses: {} }))).toBe(
      "PRESCREEN_INCOMPLETE",
    );
  });

  it("voids an exception approved on earlier answers", () => {
    expect(
      passBlocker(
        facts({
          responses: { a: "NOT_MET", b: "MET" },
          exceptionResponsesVersion: 1,
        }),
      ),
    ).toBe("EXCEPTION_REQUIRED");
  });

  it("accepts only known items and results", () => {
    expect(parseResponses(items, JSON.stringify({ a: "MET" }))).toEqual({
      a: "MET",
    });
    for (const bad of [
      "nope",
      "null",
      "[]",
      JSON.stringify({ z: "MET" }),
      JSON.stringify({ a: "YES" }),
      undefined,
      "x".repeat(4001),
    ]) {
      expect(parseResponses(items, bad)).toBeNull();
    }
  });

  it("bounds notes and refuses control characters", () => {
    expect(normalizeNotes("")).toEqual({ ok: true, notes: null });
    expect(normalizeNotes("  TEST\nnote ")).toEqual({
      ok: true,
      notes: "TEST\nnote",
    });
    expect(normalizeNotes("x".repeat(2001))).toEqual({ ok: false });
    expect(normalizeNotes("a\u0007b")).toEqual({ ok: false });
  });

  it("ignores malformed checklist rows", () => {
    expect(parseChecklistItems("nope")).toEqual([]);
    expect(
      parseChecklistItems([{ code: "a", label: "A" }, { code: 1 }]),
    ).toEqual([{ code: "a", label: "A" }]);
  });
});

import { describe, expect, it } from "vitest";
import {
  maskEmail,
  maskPhone,
  normalizeContactEmail,
  normalizeName,
  normalizePhone,
} from "./normalization";

// NORM-1 (packet M2.2 §7, §23): lawful names of any script are kept as
// entered; controls, bidi overrides, zero-width characters, markup, and
// oversized input are refused; only email and phone yield comparison
// values. All values are synthetic.

const name = (input: unknown, optional = false) =>
  normalizeName(input, { max: 100, optional });

describe("NORM-1 name normalization", () => {
  it.each([
    ["O'Brien", "O'Brien"],
    ["O’Brien", "O’Brien"],
    ["José", "José"],
    ["Nguyễn", "Nguyễn"],
    ["Anne-Marie", "Anne-Marie"],
    ["St. John", "St. John"],
    ["  Mary   Jane  ", "Mary Jane"],
    ["Zoë", "Zoë"],
    ["Ἀλέξανδρος", "Ἀλέξανδρος"],
    ["李", "李"],
    ["محمد", "محمد"],
  ])("keeps the lawful name %j", (input, expected) => {
    expect(name(input)).toEqual({ ok: true, value: expected });
  });

  it("composes decomposed input to NFC", () => {
    expect(name("José")).toEqual({ ok: true, value: "José" });
  });

  it.each([
    "Robert\u0000",
    "Ali‮ce",
    "Ma​ry",
    "Eve⁦x⁩",
    "﻿Ada",
    "Line\nBreak",
    "Del\u007F",
  ])("refuses hidden control or bidi characters in %j", (input) => {
    expect(name(input)).toEqual({ ok: false, problem: "INVALID_CHARACTERS" });
  });

  it.each([
    "<script>",
    "Robert'); DROP TABLE person;--",
    "R2D2",
    "@handle",
    "-Leading",
    "'Quoted",
    "Name=Value",
  ])("refuses markup, digits, and symbols in %j", (input) => {
    expect(name(input)).toEqual({ ok: false, problem: "INVALID_CHARACTERS" });
  });

  it("bounds length by characters and rejects oversized input early", () => {
    expect(name("a".repeat(100)).ok).toBe(true);
    expect(name("a".repeat(101))).toEqual({ ok: false, problem: "TOO_LONG" });
    expect(name("a".repeat(10_000))).toEqual({
      ok: false,
      problem: "TOO_LONG",
    });
  });

  it("distinguishes required and optional empties, and non-strings", () => {
    expect(name("")).toEqual({ ok: false, problem: "REQUIRED" });
    expect(name("   ")).toEqual({ ok: false, problem: "REQUIRED" });
    expect(name(undefined, true)).toEqual({ ok: true, value: null });
    expect(name("  ", true)).toEqual({ ok: true, value: null });
    expect(name(42)).toEqual({ ok: false, problem: "REQUIRED" });
  });

  it("never throws on arbitrary generated input (deterministic fuzz)", () => {
    let seed = 0x2f6e2b1;
    const next = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed;
    };
    for (let i = 0; i < 2000; i += 1) {
      const length = next() % 40;
      const text = Array.from({ length }, () =>
        String.fromCodePoint(next() % 0x2fff),
      ).join("");
      const result = name(text, i % 2 === 0);
      expect(typeof result.ok).toBe("boolean");
      if (result.ok && result.value !== null) {
        expect(result.value).toBe(result.value.normalize("NFC"));
        expect(result.value).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/u);
      }
    }
  });
});

describe("NORM-1 contact normalization", () => {
  it("normalizes email case and whitespace for comparison", () => {
    expect(normalizeContactEmail("  Test.Person@Example.TEST ")).toEqual({
      display: "Test.Person@Example.TEST",
      normalized: "test.person@example.test",
    });
    expect(normalizeContactEmail("not-an-email")).toBeNull();
    expect(normalizeContactEmail(undefined)).toBeNull();
  });

  it.each([
    ["(502) 555-0142", "+15025550142"],
    ["502.555.0142", "+15025550142"],
    ["1 502 555 0142", "+15025550142"],
    ["+44 20 7946 0958", "+442079460958"],
  ])("derives E.164 for %j", (input, e164) => {
    expect(normalizePhone(input)).toEqual({
      ok: true,
      value: { display: input, e164 },
    });
  });

  it("keeps an unparseable but plausible number as display only", () => {
    expect(normalizePhone("555-0142")).toEqual({
      ok: true,
      value: { display: "555-0142", e164: null },
    });
    expect(normalizePhone("(102) 555-0142")).toEqual({
      ok: true,
      value: { display: "(102) 555-0142", e164: null },
    });
  });

  it("refuses non-phone input and treats empty as absent", () => {
    expect(normalizePhone("call me")).toEqual({
      ok: false,
      problem: "INVALID_PHONE",
    });
    expect(normalizePhone("5‮025550142")).toEqual({
      ok: false,
      problem: "INVALID_PHONE",
    });
    expect(normalizePhone("1".repeat(41))).toEqual({
      ok: false,
      problem: "INVALID_PHONE",
    });
    expect(normalizePhone("")).toEqual({ ok: true, value: null });
  });

  it("masks contact values for the review projection", () => {
    expect(maskEmail("test.person@example.test")).toBe("t•••@example.test");
    expect(maskEmail("broken")).toBe("•••");
    expect(maskPhone("+15025550142")).toBe("•••-0142");
    expect(maskPhone("12")).toBe("•••");
  });
});

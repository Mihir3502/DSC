import { describe, expect, it } from "vitest";
import {
  checkText,
  isPublicReference,
  isSafePlainText,
  isTimezone,
  isWorkerPaths,
  normalizeCode,
} from "./values";

// M2.1 value rules (packet M2.1 §7.2, §10.1, §11.2, §23; AC-M2.1-01/04/15).

describe("codes", () => {
  it("normalizes case and whitespace and rejects anything outside the stored shape", () => {
    expect(normalizeCode("  lex-01 ")).toBe("LEX-01");
    expect(normalizeCode("home_care")).toBe("HOME_CARE");
    for (const bad of [
      "",
      "x",
      "-LEX",
      "LEX 01",
      "LEX/01",
      "Ł",
      "a".repeat(33),
      7,
      null,
    ]) {
      expect(normalizeCode(bad), String(bad)).toBeNull();
    }
  });
});

describe("public references and closed values", () => {
  it("accepts only 12-character Crockford base32 references", () => {
    expect(isPublicReference("k3m9x2p7q4ad")).toBe(true);
    for (const bad of [
      "K3M9X2P7Q4AD",
      "k3m9x2p7q4a",
      "k3m9x2p7q4adl",
      "iiiiiiiiiiii",
      "../../etc/pa",
      "00000000-0000",
    ]) {
      expect(isPublicReference(bad), bad).toBe(false);
    }
  });

  it("knows only the three reviewed worker-path values (no individual classification)", () => {
    expect(isWorkerPaths("W2_ONLY")).toBe(true);
    expect(isWorkerPaths("CONTRACTOR_ELIGIBLE_ONLY")).toBe(true);
    expect(isWorkerPaths("W2_AND_CONTRACTOR_ELIGIBLE")).toBe(true);
    for (const bad of ["1099", "APPROVED_1099", "CONTRACTOR", "w2_only", ""]) {
      expect(isWorkerPaths(bad), bad).toBe(false);
    }
  });

  it("accepts only real IANA timezones", () => {
    expect(isTimezone("America/New_York")).toBe(true);
    expect(isTimezone("UTC")).toBe(true);
    for (const bad of [
      "Mars/Olympus",
      "EST5EDT; DROP",
      "",
      "x".repeat(65),
      1,
    ]) {
      expect(isTimezone(bad), String(bad)).toBe(false);
    }
  });
});

describe("content safety fuzzing (stored/reflected XSS, templates, controls)", () => {
  const unsafe = [
    "<script>alert(1)</script>",
    "<img src=x onerror=alert(1)>",
    "</p><iframe src=//example.test>",
    "<!-- comment -->",
    "<svg/onload=alert(1)>",
    "＜script＞alert(1)＜/script＞",
    "click javascript:alert(1)",
    "JaVaScRiPt:alert(1)",
    "see data:text/html;base64,PHNjcmlwdD4=",
    "vbscript:msgbox(1)",
    "{{constructor.constructor('alert(1)')()}}",
    "${process.env}",
    "<% evil %>",
    "{% include x %}",
    "[[template]]",
    "abc‮evil",
    "abc⁦x⁩",
    "nul\u0000byte",
    "bell\u0007",
    "esc\u001B[31m",
    "c1\u0085control",
  ];

  it.each(unsafe)("rejects unsafe content %#", (payload) => {
    expect(isSafePlainText(payload, true)).toBe(false);
    expect(checkText(payload, { max: 8000, multiline: true })).toEqual({
      ok: false,
      problem: "UNSAFE_CONTENT",
    });
  });

  it("keeps ordinary punctuation, comparisons, quotes, and ampersands as plain text", () => {
    for (const ok of [
      "Pay is reviewed after 90 days & benefits apply.",
      "Must lift < 25 lb and work > 4 hours.",
      'Use the "client-first" approach.',
      "Bilingual (English/Spanish) preferred: 50% of visits.",
    ]) {
      expect(checkText(ok, { max: 200 }), ok).toEqual({ ok: true, value: ok });
    }
  });

  it("bounds length, trims, requires values, and keeps single-line fields single-line", () => {
    expect(checkText("  TEST  ", { max: 10 })).toEqual({
      ok: true,
      value: "TEST",
    });
    expect(checkText("x".repeat(11), { max: 10 })).toEqual({
      ok: false,
      problem: "TOO_LONG",
    });
    expect(checkText("", { max: 10 })).toEqual({
      ok: false,
      problem: "REQUIRED",
    });
    expect(checkText("   ", { max: 10, optional: true })).toEqual({
      ok: true,
      value: null,
    });
    expect(checkText("a\nb", { max: 10 })).toEqual({
      ok: false,
      problem: "UNSAFE_CONTENT",
    });
    expect(checkText("a\r\nb", { max: 10, multiline: true })).toEqual({
      ok: true,
      value: "a\nb",
    });
    expect(checkText({ toString: () => "x" }, { max: 10 })).toEqual({
      ok: false,
      problem: "REQUIRED",
    });
  });
});

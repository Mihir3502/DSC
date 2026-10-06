import { describe, expect, it } from "vitest";
import { scanForMarkers } from "./critical-tests";
import { redact, scanForCanaries } from "./data-canary";

// Forbidden samples are assembled at runtime so this file never contains a
// literal canary value itself (the data guard scans it).
const join = (...parts: string[]) => parts.join("");

describe("data canary guard", () => {
  it("accepts obviously synthetic values", () => {
    const text = [
      'email: "test-sender@example.test"',
      'ssn: "900-12-3456", alt: "123-00-4567", "666-10-1234"',
      'card: "0000 0000 0000 0000"',
      'secret: "TEST_app_password_not_secret"',
    ].join("\n");
    expect(scanForCanaries("sample.ts", text)).toEqual([]);
  });

  it.each([
    ["ssn-shaped value outside synthetic ranges", join("12", "3-45-", "6789")],
    ["payment-card number (passes Luhn)", join("4111", " 1111 ", "1111 1111")],
    [
      "personal email at a consumer mail provider",
      join("jane.doe", "@", "gmail", ".com"),
    ],
    ["private key material", join("-----BEGIN ", "RSA PRIVATE", " KEY-----")],
    ["live cloud or service token", join("AKIA", "ABCDEFGHIJKLMNOP")],
  ])("flags %s and redacts the value", (rule, value) => {
    const findings = scanForCanaries("sample.ts", `const x = "${value}";`);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ file: "sample.ts", line: 1, rule });
    expect(findings[0].redacted).not.toContain(value);
    expect(JSON.stringify(findings)).not.toContain(value.slice(3));
  });

  it("redacts to two characters plus length", () => {
    expect(redact("abcdefgh")).toBe("ab…[8 chars redacted]");
  });
});

describe("critical test guard", () => {
  it("accepts ordinary tests and comments mentioning markers", () => {
    const text = [
      'test("loads", async () => {});',
      'test.describe("routes", () => {});',
      "// never commit test.only here",
    ].join("\n");
    expect(scanForMarkers("a.spec.ts", text)).toEqual([]);
  });

  it.each([
    [join("test", '.only("x", () => {});'), ".only"],
    [join("test", '.skip("x", () => {});'), ".skip"],
    [join("test", '.fixme("x", () => {});'), ".fixme"],
    [join("test.describe", '.only("x", () => {});'), ".only"],
    [join("test", ".skip(isMobile);"), ".skip"],
  ])("flags %s", (line, marker) => {
    expect(scanForMarkers("a.spec.ts", line)).toEqual([
      { file: "a.spec.ts", line: 1, marker },
    ]);
  });

  it("allows a skip only with an approved-skip reference, never a focus", () => {
    expect(
      scanForMarkers(
        "a.spec.ts",
        join("test", '.skip("x"); // approved-skip: PSA-123'),
      ),
    ).toEqual([]);
    expect(
      scanForMarkers(
        "a.spec.ts",
        join("test", '.only("x"); // approved-skip: PSA-123'),
      ),
    ).toHaveLength(1);
  });
});

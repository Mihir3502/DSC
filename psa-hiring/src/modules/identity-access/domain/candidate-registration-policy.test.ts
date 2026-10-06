import { describe, expect, it } from "vitest";
import {
  checkNewPassword,
  describeDevice,
  intentAllowsEmail,
  isContinuationKey,
  maskEmail,
  resolvePostAuthDestination,
  type RegistrationIntent,
} from "./candidate-registration-policy";

const longPassphrase = "TEST a long passphrase with spaces 0001";

describe("checkNewPassword", () => {
  it("accepts long passphrases with spaces and no composition rules", () => {
    expect(checkNewPassword(longPassphrase, longPassphrase)).toEqual([]);
    expect(checkNewPassword("a".repeat(256), "a".repeat(256))).toEqual([]);
    expect(checkNewPassword("ünïcödé pässwörd", "ünïcödé pässwörd")).toEqual(
      [],
    );
  });

  it("never trims: surrounding spaces are part of the password", () => {
    expect(checkNewPassword(` ${longPassphrase} `, longPassphrase)).toEqual([
      "MISMATCH",
    ]);
  });

  it.each([
    [undefined, undefined, ["REQUIRED"]],
    ["", "", ["REQUIRED"]],
    ["short pass", "short pass", ["TOO_SHORT"]],
    ["a".repeat(257), "a".repeat(257), ["TOO_LONG"]],
    ["TEST tab\there 0001", "TEST tab\there 0001", ["CONTROL_CHARACTERS"]],
    ["TEST newline\n0001", "TEST newline\n0001", ["CONTROL_CHARACTERS"]],
    [longPassphrase, `${longPassphrase}x`, ["MISMATCH"]],
  ])("rejects %#", (password, confirmation, problems) => {
    expect(checkNewPassword(password, confirmation)).toEqual(problems);
  });
});

describe("post-authentication destinations", () => {
  it("resolves registry keys to same-origin paths", () => {
    expect(resolvePostAuthDestination("CANDIDATE_SECURITY")).toBe(
      "/candidate/security",
    );
    expect(isContinuationKey("CANDIDATE_SECURITY")).toBe(true);
  });

  it.each([
    undefined,
    "",
    "https://evil.example.test/",
    "//evil.example.test",
    "/\\evil.example.test",
    "javascript:alert(1)",
    "%2F%2Fevil.example.test",
    "/candidate/security?next=https://evil.example.test",
    "https://user:pass@evil.example.test",
    "/staff",
    "STAFF_HOME",
    "CANDIDATE_SECURITY\n",
    "toString",
    "__proto__",
    "constructor",
  ])("falls back to the candidate default for %j", (key) => {
    expect(resolvePostAuthDestination(key)).toBe("/candidate/security");
    expect(isContinuationKey(key)).toBe(false);
  });
});

describe("registration intent email binding", () => {
  const expiresAt = new Date("2026-10-07T00:00:00Z");
  const invitation: RegistrationIntent = {
    source: "CANDIDATE_INVITATION",
    continuationKey: "CANDIDATE_SECURITY",
    boundEmail: "test.invited@example.test",
    expiresAt,
  };

  it("binds an invitation to its own normalized email only", () => {
    expect(intentAllowsEmail(invitation, "test.invited@example.test")).toBe(
      true,
    );
    expect(intentAllowsEmail(invitation, "test.other@example.test")).toBe(
      false,
    );
  });

  it("allows any email for a public intent without binding", () => {
    const publicIntent: RegistrationIntent = {
      source: "PUBLIC_POSITION",
      continuationKey: "CANDIDATE_SECURITY",
      expiresAt,
    };
    expect(intentAllowsEmail(publicIntent, "test.any@example.test")).toBe(true);
    expect(
      intentAllowsEmail(
        { ...publicIntent, boundEmail: "x@example.test" },
        "x@example.test",
      ),
    ).toBe(false);
  });
});

describe("display helpers", () => {
  it("masks emails", () => {
    expect(maskEmail("test.person@example.test")).toBe("t•••@example.test");
    expect(maskEmail("bad")).toBe("•••");
  });

  it.each([
    [
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36",
      "Chrome on macOS",
    ],
    [
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:140.0) Gecko/20100101 Firefox/140.0",
      "Firefox on Windows",
    ],
    [
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
      "Safari on iOS",
    ],
    [null, "Unknown device"],
    ["curl/8.0", "Browser on unknown system"],
  ])("labels devices coarsely (%#)", (userAgent, label) => {
    expect(describeDevice(userAgent)).toBe(label);
  });
});

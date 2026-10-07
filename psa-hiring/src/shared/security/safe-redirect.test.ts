import { describe, expect, it } from "vitest";
import {
  applyProtectedHeaders,
  isProtectedPath,
  PROTECTED_CACHE_CONTROL,
} from "./protected-cache-policy";
import {
  isRegisteredDestination,
  isStrictRelativeDestination,
  registeredDestinations,
  SAFE_DEFAULT_DESTINATION,
  safeDestination,
} from "./safe-redirect";

// Redirect allowlist fuzzing and protected cache policy (packet M1.5
// §17.2, §18, AC-M1.5-10/11).

const malicious = [
  "https://evil.example.test/",
  "http://127.0.0.1:3100/candidate/security",
  "//evil.example.test",
  "///evil.example.test",
  "/\\evil.example.test",
  "\\\\evil.example.test",
  "/\t/evil.example.test",
  "/%2F%2Fevil.example.test",
  "/%5Cevil.example.test",
  "%2F%2Fevil.example.test",
  "/candidate/security/../../staff/security",
  "/candidate/./security",
  "/candidate/security%2F..%2F..%2Fstaff",
  "/candidate/security?next=https://evil.example.test",
  "/candidate/security?notice=revoked&next=//evil",
  "/candidate/security?notice=unknown",
  "/candidate/security#https://evil",
  "/sign-in?token=TESTCANARY-token",
  "/sign-in?email=test.person@example.test",
  "javascript:alert(1)",
  "JaVaScRiPt:alert(1)",
  "data:text/html,hi",
  " /candidate/security",
  "/candidate/security ",
  "/candidate/security\u0000",
  "/candidate/security\r\nSet-Cookie: x=1",
  "/candidate/securıty",
  "/CANDIDATE/SECURITY",
  "/candidate/security/",
  "",
  "/".repeat(300),
  "/staff/reauthenticate?purpose=https://evil",
  "/staff/reauthenticate?purpose=REGENERATE_BACKUP_CODES",
];

describe("safe redirect destinations", () => {
  it("registers only strict same-origin relative destinations without secrets", () => {
    for (const destination of registeredDestinations) {
      expect(isStrictRelativeDestination(destination), destination).toBe(true);
      expect(destination).not.toMatch(
        /token|email|@|session|role|scope|permission/i,
      );
    }
    expect(registeredDestinations).toContain(SAFE_DEFAULT_DESTINATION);
  });

  it.each(malicious)("falls back to the safe default for %j", (value) => {
    expect(isRegisteredDestination(value)).toBe(false);
    expect(safeDestination(value)).toBe(SAFE_DEFAULT_DESTINATION);
    expect(safeDestination(value, "/sign-in")).toBe("/sign-in");
  });

  it.each([
    undefined,
    null,
    42,
    {},
    ["/sign-in"],
    new URL("http://127.0.0.1/"),
  ])("rejects non-string destination %#", (value) => {
    expect(safeDestination(value)).toBe(SAFE_DEFAULT_DESTINATION);
  });

  it("never uses an unregistered fallback", () => {
    expect(safeDestination("https://evil", "https://evil")).toBe("/");
  });

  it("keeps exact registered destinations unchanged", () => {
    for (const destination of registeredDestinations) {
      expect(safeDestination(destination)).toBe(destination);
    }
  });

  it("rejects randomized mutations of registered destinations", () => {
    const inserts = [
      "/",
      "\\",
      "%2f",
      "//",
      "..",
      "@",
      ":",
      "?next=/",
      "#",
      "\u0000",
      " ",
    ];
    let seed = 7;
    const random = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed % n;
    };
    for (let i = 0; i < 500; i += 1) {
      const base =
        registeredDestinations[random(registeredDestinations.length)];
      const at = random(base.length + 1);
      const mutated = `${base.slice(0, at)}${inserts[random(inserts.length)]}${base.slice(at)}`;
      if (registeredDestinations.includes(mutated)) continue;
      expect(safeDestination(mutated), mutated).toBe(SAFE_DEFAULT_DESTINATION);
    }
  });
});

describe("protected cache policy", () => {
  it.each([
    "/sign-in",
    "/register",
    "/verify-email",
    "/recover",
    "/reset-password",
    "/candidate",
    "/candidate/security",
    "/staff",
    "/staff/security",
    "/staff/reauthenticate",
    "/staff/mfa",
    "/api/auth/get-session",
  ])("protects %s", (path) => {
    expect(isProtectedPath(path)).toBe(true);
  });

  it.each(["/", "/candidates", "/staffing", "/sign-inx"])(
    "does not over-match %s",
    (path) => {
      expect(isProtectedPath(path)).toBe(false);
    },
  );

  it("sets private no-store headers and overwrites cacheable values", () => {
    const headers = new Headers({
      "cache-control": "public, max-age=3600, s-maxage=86400",
    });
    applyProtectedHeaders(headers);
    expect(headers.get("cache-control")).toBe(PROTECTED_CACHE_CONTROL);
    expect(headers.get("cache-control")).not.toMatch(/public|s-maxage/);
    expect(headers.get("pragma")).toBe("no-cache");
    expect(headers.get("vary")).toBe("Cookie");
  });
});

import { describe, expect, it } from "vitest";
import {
  canResolvePrincipal,
  canSignInInteractively,
  decideRestriction,
  hasVerifiedEmail,
} from "./account-policy";
import {
  accountStatuses,
  accountTypes,
  isAccountStatus,
  isAccountType,
} from "./account-types";
import { InvalidEmailError, normalizeLoginEmail } from "./email";

describe("normalizeLoginEmail", () => {
  it("trims, applies NFC, and lowercases while keeping the display form", () => {
    expect(normalizeLoginEmail("  Test.User@Example.TEST ")).toEqual({
      login: "test.user@example.test",
      display: "Test.User@Example.TEST",
    });
  });

  it("does not apply provider-specific rewriting", () => {
    expect(normalizeLoginEmail("first.last+tag@example.test").login).toBe(
      "first.last+tag@example.test",
    );
  });

  it.each([
    ["control character", "test\u0000user@example.test"],
    ["newline", "test@example.test\nbcc@example.test"],
    ["zero-width space", "te​st@example.test"],
    ["bidi override", "test‮@example.test"],
    ["missing domain", "test@"],
    ["not a string", 42],
    ["oversized", `${"a".repeat(250)}@example.test`],
    ["non-ASCII (Better Auth sign-in accepts ASCII only)", "josé@example.test"],
  ])("rejects %s", (_label, input) => {
    expect(() => normalizeLoginEmail(input)).toThrow(InvalidEmailError);
  });

  it("never echoes the input in the error", () => {
    try {
      normalizeLoginEmail("secret.person\u0000@example.test");
    } catch (error) {
      expect((error as Error).message).toBe("INVALID_EMAIL");
    }
  });
});

describe("account policy", () => {
  it("resolves only ACTIVE, non-service accounts", () => {
    const resolvable: string[] = [];
    for (const accountType of accountTypes) {
      for (const status of accountStatuses) {
        if (canResolvePrincipal({ accountType, status })) {
          resolvable.push(`${accountType}/${status}`);
        }
        expect(
          canSignInInteractively({ accountType, status, emailVerified: true }),
        ).toBe(canResolvePrincipal({ accountType, status }));
      }
    }
    expect(resolvable).toEqual(["CANDIDATE/ACTIVE", "STAFF/ACTIVE"]);
  });

  it("requires a verified email before a candidate session (M1.2)", () => {
    const active = { status: "ACTIVE" as const, emailVerified: false };
    expect(
      canSignInInteractively({ ...active, accountType: "CANDIDATE" }),
    ).toBe(false);
    expect(canSignInInteractively({ ...active, accountType: "STAFF" })).toBe(
      true,
    );
    expect(
      canSignInInteractively({
        accountType: "CANDIDATE",
        status: "INVITED",
        emailVerified: true,
      }),
    ).toBe(false);
  });

  it("treats CLOSED as terminal and re-application as idempotent", () => {
    expect(decideRestriction("ACTIVE", "LOCKED")).toEqual({ kind: "apply" });
    expect(decideRestriction("LOCKED", "DISABLED")).toEqual({ kind: "apply" });
    expect(decideRestriction("INVITED", "CLOSED")).toEqual({ kind: "apply" });
    expect(decideRestriction("LOCKED", "LOCKED")).toEqual({
      kind: "already-applied",
    });
    expect(decideRestriction("CLOSED", "LOCKED")).toEqual({
      kind: "not-allowed",
    });
    expect(decideRestriction("CLOSED", "CLOSED")).toEqual({
      kind: "already-applied",
    });
  });

  it("keeps verified email independent of status", () => {
    expect(hasVerifiedEmail({ emailVerified: false })).toBe(false);
    expect(hasVerifiedEmail({ emailVerified: true })).toBe(true);
  });

  it("recognizes only the closed type/status sets", () => {
    expect(isAccountType("STAFF")).toBe(true);
    expect(isAccountType("staff")).toBe(false);
    expect(isAccountType("ADMIN")).toBe(false);
    expect(isAccountStatus("ACTIVE")).toBe(true);
    expect(isAccountStatus("SUSPENDED")).toBe(false);
  });
});

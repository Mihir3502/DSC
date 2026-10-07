import { describe, expect, it } from "vitest";
import { ServerEnvError } from "@/config/env-schema";
import { createLogger } from "@/shared/logging";
import { createMemoryDestination } from "../../../../tests/fixtures/canaries";
import {
  normalizeBackupCode,
  normalizeTotpCode,
} from "../application/staff-auth-support";
import { parseAuthEnv } from "./auth-env";
import { disabledAuthPaths, staffTwoFactorPlugin } from "./auth-options";
import { renderAuthEmail, staffActivationLink } from "./auth-email";
import {
  readCookie,
  readSetCookie,
  withoutCookies,
} from "./better-auth-mfa-adapter";
import { isForwardedAuthPath } from "./auth-http";
import { AuditRecorder, parseAuditKeyRing } from "@/modules/audit";
import {
  NonproductionHarnessGate,
  RefusingStaffAdministrationGate,
} from "./staff-administration-gate";
import {
  digestInvitationToken,
  isInvitationTokenShape,
  newInvitationToken,
} from "./staff-invitation-repository";

// M1.3 adapters (packet §7–§8, §10–§11, §15, AC-M1.3-03/06/13).

const origin = "http://localhost:3000";
const goodSecret = "0f3a9c27".repeat(8);
const localEnv = {
  APP_ENV: "local",
  BETTER_AUTH_SECRET: goodSecret,
  BETTER_AUTH_URL: origin,
  AUTH_TRUSTED_ORIGINS: origin,
};

function problemsOf(input: Record<string, string | undefined>): string[] {
  try {
    parseAuthEnv(input);
  } catch (error) {
    expect(error).toBeInstanceOf(ServerEnvError);
    return [...(error as ServerEnvError).problems];
  }
  throw new Error("expected auth configuration to be rejected");
}

describe("staff administration gate", () => {
  it("refuses everything in the application's own runtime", () => {
    const gate = new RefusingStaffAdministrationGate();
    expect(
      gate.allows(
        { kind: "BOOTSTRAP", reason: "LOCAL_BOOTSTRAP" },
        "INVITATION_ISSUE",
      ),
    ).toBe(false);
    expect(
      gate.allows(
        { kind: "ACCOUNT", accountId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
        "RECOVERY_COMPLETE",
      ),
    ).toBe(false);
  });

  it("cannot be constructed as a harness outside local/test", () => {
    for (const appEnv of ["staging", "production", undefined, "", "LOCAL"]) {
      expect(() => new NonproductionHarnessGate(appEnv)).toThrow(
        /only when APP_ENV is local or test/,
      );
    }
  });

  it("limits the harness to invitation bootstrap and recovery steps", () => {
    const local = new NonproductionHarnessGate("local");
    expect(
      local.allows(
        { kind: "BOOTSTRAP", reason: "LOCAL_BOOTSTRAP" },
        "INVITATION_ISSUE",
      ),
    ).toBe(true);
    expect(
      local.allows(
        { kind: "BOOTSTRAP", reason: "TEST_HARNESS" },
        "INVITATION_ISSUE",
      ),
    ).toBe(false);
    expect(
      local.allows(
        { kind: "BOOTSTRAP", reason: "LOCAL_BOOTSTRAP" },
        "RECOVERY_COMPLETE",
      ),
    ).toBe(false);
    const test = new NonproductionHarnessGate("test");
    expect(
      test.allows(
        { kind: "BOOTSTRAP", reason: "TEST_HARNESS" },
        "INVITATION_ISSUE",
      ),
    ).toBe(true);
  });
});

describe("staff authentication configuration", () => {
  it("uses safe bounded defaults", () => {
    const env = parseAuthEnv(localEnv);
    expect(env.AUTH_STAFF_INVITATION_EXPIRES_IN_SECONDS).toBe(259_200);
    expect(env.AUTH_STAFF_REENROLLMENT_EXPIRES_IN_SECONDS).toBe(14_400);
    expect(env.AUTH_STAFF_MFA_CHALLENGE_SECONDS).toBe(300);
    expect(env.AUTH_STAFF_MFA_MAX_FAILURES).toBe(5);
    expect(env.AUTH_STAFF_MFA_LOCKOUT_SECONDS).toBe(900);
    expect(env.AUTH_STAFF_RECENT_AUTH_SECONDS).toBe(300);
  });

  it("allows sub-minute lockout and recent-auth windows only in test", () => {
    const short = {
      AUTH_STAFF_MFA_LOCKOUT_SECONDS: "5",
      AUTH_STAFF_RECENT_AUTH_SECONDS: "5",
    };
    expect(problemsOf({ ...localEnv, ...short })).toEqual(
      expect.arrayContaining([
        "AUTH_STAFF_MFA_LOCKOUT_SECONDS must be at least 60 outside test",
        "AUTH_STAFF_RECENT_AUTH_SECONDS must be at least 60 outside test",
      ]),
    );
    expect(
      parseAuthEnv({
        ...localEnv,
        ...short,
        APP_ENV: "test",
        BETTER_AUTH_SECRET: "TEST-secret-for-unit-tests-only-0000000",
      }).AUTH_STAFF_RECENT_AUTH_SECONDS,
    ).toBe(5);
    expect(
      problemsOf({ ...localEnv, AUTH_STAFF_MFA_MAX_FAILURES: "50" }),
    ).toContain(
      "AUTH_STAFF_MFA_MAX_FAILURES must be an integer between 3 and 10",
    );
  });

  it("still refuses production-like startup and test secrets", () => {
    const production = {
      APP_ENV: "production",
      BETTER_AUTH_SECRET: goodSecret,
      BETTER_AUTH_URL: "https://hiring.example.org",
      AUTH_TRUSTED_ORIGINS: "https://hiring.example.org",
    };
    expect(problemsOf(production).join("\n")).toMatch(
      /distributed rate-limit store/,
    );
    expect(
      problemsOf({
        ...production,
        BETTER_AUTH_SECRET: "TEST-secret-0000000000000000000000",
      }).join("\n"),
    ).toMatch(/placeholder or test secret/);
  });
});

describe("two-factor plugin configuration", () => {
  it("configures TOTP + encrypted backup codes, lockout, and no OTP sender", () => {
    const plugin = staffTwoFactorPlugin();
    const options = plugin.options as Record<string, unknown> & {
      otpOptions?: { sendOTP?: unknown };
      backupCodeOptions?: Record<string, unknown>;
      accountLockout?: Record<string, unknown>;
    };
    expect(options.skipVerificationOnEnable).toBe(false);
    expect(options.otpOptions?.sendOTP).toBeUndefined();
    expect(options.backupCodeOptions).toMatchObject({
      storeBackupCodes: "encrypted",
      amount: 10,
      length: 10,
    });
    expect(options.accountLockout).toMatchObject({ enabled: true });
    expect(options.trustDeviceMaxAge).toBe(1);
  });

  it("closes every two-factor HTTP path", () => {
    for (const path of [
      "/two-factor/enable",
      "/two-factor/disable",
      "/two-factor/get-totp-uri",
      "/two-factor/verify-totp",
      "/two-factor/send-otp",
      "/two-factor/verify-otp",
      "/two-factor/verify-backup-code",
      "/two-factor/generate-backup-codes",
      "/verify-password",
    ]) {
      expect(disabledAuthPaths).toContain(path);
      expect(isForwardedAuthPath("POST", `/api/auth${path}`)).toBe(false);
      expect(isForwardedAuthPath("GET", `/api/auth${path}`)).toBe(false);
    }
  });
});

describe("staff invitation capability and email", () => {
  it("creates 256-bit tokens and stores a purpose-bound digest", () => {
    const token = newInvitationToken();
    expect(isInvitationTokenShape(token)).toBe(true);
    expect(newInvitationToken()).not.toBe(token);
    const digest = digestInvitationToken(token);
    expect(digest).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(digest).not.toContain(token);
    expect(isInvitationTokenShape("short")).toBe(false);
    expect(isInvitationTokenShape(`${token}?x`)).toBe(false);
  });

  it("builds the link from the configured origin with the capability in the fragment", () => {
    const token = newInvitationToken();
    expect(staffActivationLink(`${origin}/ignored/path`, token)).toBe(
      `${origin}/staff/activate#invite=${token}`,
    );
    expect(() => staffActivationLink(origin, "bad token")).toThrow();
  });

  it("renders minimal, escaped invitation and notice emails", () => {
    const token = newInvitationToken();
    const invitation = renderAuthEmail(
      {
        template: "STAFF_INVITATION",
        to: "test.staff@example.test",
        token,
        purpose: "STAFF_ACTIVATION",
        expiresInMinutes: 4320,
      },
      origin,
    );
    expect(invitation.subject).toBe("Activate your staff account");
    const body = `${invitation.text}\n${invitation.html}`;
    // The random token itself may spell a filtered word ("ROle"); check the
    // surrounding content only.
    expect(body.replaceAll(token, "<token>")).not.toMatch(
      /role|branch|team|candidate|admin|otpauth|<img|<script/i,
    );
    expect(body).not.toContain("test.staff@example.test");
    expect(invitation.text).toContain(`#invite=${token}`);
    const reset = renderAuthEmail(
      {
        template: "STAFF_INVITATION",
        to: "test.staff@example.test",
        token,
        purpose: "STAFF_REENROLLMENT",
        expiresInMinutes: 240,
      },
      origin,
    );
    expect(reset.subject).toMatch(/reset/);
    const notice = renderAuthEmail(
      {
        template: "STAFF_SECURITY_NOTICE",
        to: "test.staff@example.test",
        notice: "BACKUP_CODES_REGENERATED",
      },
      origin,
    );
    expect(notice.text).toMatch(/Earlier backup codes no longer work/);
    expect(notice.text).not.toMatch(/[A-Za-z0-9]{5}-[A-Za-z0-9]{5}/);
  });
});

describe("staff cookies and codes", () => {
  it("reads, finds, and strips cookies without exposing other values", () => {
    const headers = new Headers({
      cookie: "a=1; psa.trust_device=forged; psa.two_factor=abc%2Edef",
    });
    expect(readCookie(headers, "psa.two_factor")).toBe("abc.def");
    expect(readCookie(headers, "missing")).toBeNull();
    const stripped = withoutCookies(
      headers,
      ["psa.trust_device"],
      "psa.session_token=x",
    );
    expect(stripped.get("cookie")).toBe(
      "a=1; psa.two_factor=abc%2Edef; psa.session_token=x",
    );
    expect(
      withoutCookies(new Headers({ cookie: "psa.trust_device=1" }), [
        "psa.trust_device",
      ]).has("cookie"),
    ).toBe(false);
    expect(
      readSetCookie(
        [
          "psa.session_token=; Max-Age=0",
          "psa.two_factor=s%3Avalue; Path=/; HttpOnly",
        ],
        "psa.two_factor",
      ),
    ).toBe("s:value");
  });

  it("normalizes typed TOTP and backup codes without changing their case", () => {
    expect(normalizeTotpCode(" 123 456 ")).toBe("123456");
    expect(normalizeTotpCode("12345")).toBeNull();
    expect(normalizeTotpCode("12345a")).toBeNull();
    expect(normalizeBackupCode(" aB3dE fG5hJ ")).toBe("aB3dE-fG5hJ");
    expect(normalizeBackupCode("aB3dE-fG5hJ")).toBe("aB3dE-fG5hJ");
    expect(normalizeBackupCode("aB3dE-fG5h")).toBeNull();
    expect(normalizeBackupCode("x".repeat(200))).toBeNull();
  });
});

describe("staff security events", () => {
  it("keeps telemetry codes as allowlisted log lines and rejects unknown codes", async () => {
    const destination = createMemoryDestination();
    // Telemetry and rejected events never reach the database.
    const events = new AuditRecorder({
      db: {} as never,
      logger: createLogger({ destination }),
      keys: parseAuditKeyRing({ APP_ENV: "test" }),
      source: "LOCAL_TEST",
    });
    expect(
      await events.record({
        code: "staff.sign_in_first_factor_succeeded",
        accountRef: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      }),
    ).toBe(true);
    expect(await events.record({ code: "not.a.code" as never })).toBe(false);
    const lines = destination.records();
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({
      eventCode: "staff.sign_in_first_factor_succeeded",
      actorRef: "aaaaaaaaaaaa4aaa8aaaaaaaaaaaaaaa",
    });
    // The rejection is a safe alert: closed codes only, never the input.
    expect(lines[1]).toMatchObject({
      level: "error",
      reasonCode: "UNKNOWN_EVENT",
    });
    expect(JSON.stringify(lines[1])).not.toContain("not.a.code");
  });
});

import { describe, expect, it } from "vitest";
import { ServerEnvError } from "@/config/env-schema";
import { createTestAccount } from "../../../../tests/fixtures/auth/accounts";
import type { Auth } from "./auth";
import { parseAuthEnv } from "./auth-env";
import {
  isForwardedAuthPath,
  publicCodeForStatus,
  toSafeAuthResponse,
} from "./auth-http";
import {
  FileEmailCapture,
  InMemoryEmailCapture,
  RefusingEmailTransport,
} from "./auth-email";

// Built at runtime so no secret-like literal is committed (gitleaks).
const goodSecret = "0f3a9c27".repeat(8);
const correlationId = "0b9a7a3e-6a55-4c8e-9a3b-2f1d0c4e5a6b";

const localEnv = {
  APP_ENV: "local",
  BETTER_AUTH_SECRET: goodSecret,
  BETTER_AUTH_URL: "http://localhost:3000",
  AUTH_TRUSTED_ORIGINS: "http://localhost:3000,http://127.0.0.1:3000",
};

function problemsOf(input: Record<string, string | undefined>): string[] {
  try {
    parseAuthEnv(input);
  } catch (error) {
    expect(error).toBeInstanceOf(ServerEnvError);
    return [...(error as ServerEnvError).problems, (error as Error).message];
  }
  throw new Error("expected auth configuration to be rejected");
}

describe("auth configuration", () => {
  it("accepts a valid local configuration with bounded defaults", () => {
    const env = parseAuthEnv(localEnv);
    expect(env.AUTH_TRUSTED_ORIGINS).toEqual([
      "http://localhost:3000",
      "http://127.0.0.1:3000",
    ]);
    expect(env.AUTH_SESSION_EXPIRES_IN_SECONDS).toBe(28_800);
    expect(env.secureCookies).toBe(false);
    expect(Object.isFrozen(env)).toBe(true);
  });

  it("requires a secret and base URL", () => {
    const problems = problemsOf({
      ...localEnv,
      BETTER_AUTH_SECRET: undefined,
      BETTER_AUTH_URL: undefined,
    });
    expect(problems).toContain("BETTER_AUTH_SECRET is required");
    expect(problems.some((p) => p.startsWith("BETTER_AUTH_URL "))).toBe(true);
  });

  it.each([
    "replace_with_output_of_openssl_rand_hex_32",
    "TEST-auth-secret-for-disposable-db-only-0000",
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "short",
  ])("rejects a weak or placeholder secret outside test (%#)", (secret) => {
    const output = problemsOf({ ...localEnv, BETTER_AUTH_SECRET: secret }).join(
      "\n",
    );
    expect(output).toContain("BETTER_AUTH_SECRET");
    expect(output.includes(secret), "secret echoed").toBe(false);
  });

  it("allows the synthetic test secret only when APP_ENV=test", () => {
    expect(
      parseAuthEnv({
        ...localEnv,
        APP_ENV: "test",
        BETTER_AUTH_SECRET: "TEST-auth-secret-for-disposable-db-only-0000",
      }).APP_ENV,
    ).toBe("test");
  });

  it.each([
    [
      "wildcard origin",
      { AUTH_TRUSTED_ORIGINS: "https://*.example.test" },
      "must not contain wildcards",
    ],
    [
      "origin with path",
      { AUTH_TRUSTED_ORIGINS: "http://localhost:3000/app" },
      "http(s) origins without paths",
    ],
    ["no origins", { AUTH_TRUSTED_ORIGINS: " , " }, "at least one origin"],
    [
      "update age >= expiry",
      { AUTH_SESSION_UPDATE_AGE_SECONDS: "28800" },
      "less than AUTH_SESSION_EXPIRES_IN_SECONDS",
    ],
    [
      "unbounded session",
      { AUTH_SESSION_EXPIRES_IN_SECONDS: "99999999" },
      "between 300 and 604800",
    ],
  ])("rejects %s", (_label, override, message) => {
    expect(
      problemsOf({ ...localEnv, ...override }).some((p) => p.includes(message)),
    ).toBe(true);
  });

  it("fails closed for production-like startup (insecure cookies, local origins, rate-limit store)", () => {
    const problems = problemsOf({ ...localEnv, APP_ENV: "production" });
    expect(
      problems.some((p) => p.startsWith("BETTER_AUTH_URL must be an https")),
    ).toBe(true);
    expect(
      problems.some((p) => p.startsWith("AUTH_TRUSTED_ORIGINS must use https")),
    ).toBe(true);
    expect(
      problems.some((p) => p.includes("distributed rate-limit store")),
    ).toBe(true);
    const staging = problemsOf({
      ...localEnv,
      APP_ENV: "staging",
      BETTER_AUTH_URL: "https://hiring.example.test",
      AUTH_TRUSTED_ORIGINS: "https://hiring.example.test",
    });
    expect(staging).toEqual(
      expect.arrayContaining([
        expect.stringContaining("distributed rate-limit store"),
      ]),
    );
  });

  it.each([
    [
      "Mailpit in production",
      {
        APP_ENV: "production",
        AUTH_EMAIL_TRANSPORT: "smtp-local",
        SMTP_HOST: "127.0.0.1",
        SMTP_PORT: "1025",
        SMTP_FROM: "no-reply@example.test",
      },
      "AUTH_EMAIL_TRANSPORT smtp-local (Mailpit) is not allowed",
    ],
    [
      "non-loopback SMTP host locally",
      {
        AUTH_EMAIL_TRANSPORT: "smtp-local",
        SMTP_HOST: "smtp.example.test",
        SMTP_PORT: "1025",
        SMTP_FROM: "no-reply@example.test",
      },
      "SMTP_HOST must be a loopback host",
    ],
    [
      "file capture outside test",
      {
        AUTH_EMAIL_TRANSPORT: "capture-file",
        AUTH_EMAIL_CAPTURE_DIR: "/tmp/x",
      },
      "capture-file is allowed only in test",
    ],
    [
      "local denylist as production compromised-password check",
      { APP_ENV: "staging" },
      "approved privacy-preserving compromised-password provider",
    ],
    [
      "unbounded verification code lifetime",
      { AUTH_OTP_EXPIRES_IN_SECONDS: "86400" },
      "between 300 and 1800",
    ],
    [
      "unbounded reset link lifetime",
      { AUTH_RESET_EXPIRES_IN_SECONDS: "86400" },
      "between 300 and 3600",
    ],
  ])("rejects %s", (_label, override, message) => {
    expect(
      problemsOf({ ...localEnv, ...override }).some((p) => p.includes(message)),
    ).toBe(true);
  });

  it("accepts a loopback Mailpit transport locally", () => {
    const env = parseAuthEnv({
      ...localEnv,
      AUTH_EMAIL_TRANSPORT: "smtp-local",
      SMTP_HOST: "127.0.0.1",
      SMTP_PORT: "1025",
      SMTP_FROM: "no-reply@example.test",
    });
    expect(env.AUTH_EMAIL_TRANSPORT).toBe("smtp-local");
    expect(env.AUTH_OTP_EXPIRES_IN_SECONDS).toBe(600);
    expect(env.AUTH_RESET_EXPIRES_IN_SECONDS).toBe(1800);
  });

  it("marks cookies Secure for https base URLs", () => {
    expect(
      parseAuthEnv({
        ...localEnv,
        BETTER_AUTH_URL: "https://localhost:3000",
        AUTH_TRUSTED_ORIGINS: "https://localhost:3000",
      }).secureCookies,
    ).toBe(true);
  });
});

describe("auth HTTP sanitizing", () => {
  it.each([
    [400, "VALIDATION_FAILED"],
    [401, "UNAUTHENTICATED"],
    [403, "UNAUTHENTICATED"],
    [404, "NOT_FOUND"],
    [409, "CONFLICT"],
    [422, "VALIDATION_FAILED"],
    [429, "RATE_LIMITED"],
    [500, "INTERNAL_ERROR"],
    [503, "INTERNAL_ERROR"],
  ])("maps %i to %s", (status, code) => {
    expect(publicCodeForStatus(status)).toBe(code);
  });

  it("replaces library error bodies but keeps Set-Cookie", async () => {
    const library = new Response(
      JSON.stringify({
        code: "INVALID_EMAIL_OR_PASSWORD",
        message: "Invalid email or password test.person@example.test",
      }),
      {
        status: 401,
        headers: {
          "content-type": "application/json",
          "set-cookie": "psa.session_token=; Max-Age=0; Path=/",
        },
      },
    );
    const safe = await toSafeAuthResponse(library, correlationId);
    expect(safe.status).toBe(401);
    expect(safe.headers.get("content-type")).toBe("application/problem+json");
    expect(safe.headers.getSetCookie()).toEqual([
      "psa.session_token=; Max-Age=0; Path=/",
    ]);
    const text = await safe.text();
    expect(
      text.includes("INVALID_EMAIL_OR_PASSWORD") ||
        text.includes("example.test"),
    ).toBe(false);
    expect(JSON.parse(text)).toEqual({
      type: "about:blank",
      title: "Sign-in is required",
      status: 401,
      code: "UNAUTHENTICATED",
      correlationId,
    });
  });

  it("strips session tokens from successful JSON bodies", async () => {
    const library = Response.json({
      token: "TESTCANARY-token-9f3c2a",
      user: { id: "u1" },
      session: { id: "s1", token: "TESTCANARY-session-9f3c2a" },
    });
    const safe = await toSafeAuthResponse(library, correlationId);
    const text = await safe.text();
    expect(text.includes("9f3c2a"), "token leaked").toBe(false);
    expect(JSON.parse(text)).toEqual({
      user: { id: "u1" },
      session: { id: "s1" },
    });
    expect(safe.headers.get("cache-control")).toBe("no-store");
  });

  it("passes redirects through unchanged", async () => {
    const redirect = new Response(null, {
      status: 302,
      headers: { location: "/" },
    });
    expect(await toSafeAuthResponse(redirect, correlationId)).toBe(redirect);
  });
});

describe("auth HTTP surface", () => {
  it.each([
    ["GET", "/api/auth/get-session", true],
    ["GET", "/api/auth/get-session/", true],
    ["POST", "/api/auth/sign-in/email", false],
    ["POST", "/api/auth/sign-up/email", false],
    ["POST", "/api/auth/sign-out", false],
    ["POST", "/api/auth/email-otp/send-verification-otp", false],
    ["POST", "/api/auth/sign-in/email-otp", false],
    ["POST", "/api/auth/request-password-reset", false],
    ["POST", "/api/auth/reset-password", false],
    ["GET", "/api/auth/reset-password/abcdefghijklmnopqrstuvwx", false],
    ["POST", "/api/auth/change-password", false],
    ["GET", "/api/auth/list-sessions", false],
    ["POST", "/api/auth/get-session", false],
    ["GET", "/api/auth/get-session/../sign-up/email", false],
  ])("%s %s forwarded=%s", (method, path, expected) => {
    expect(isForwardedAuthPath(method, path)).toBe(expected);
  });
});

describe("test-only adapters fail closed outside test", () => {
  it("refuses the in-memory email capture outside APP_ENV=test", () => {
    expect(() => new InMemoryEmailCapture("local")).toThrow(
      /only when APP_ENV=test/,
    );
    expect(() => new InMemoryEmailCapture("production")).toThrow(
      /only when APP_ENV=test/,
    );
    expect(() => new InMemoryEmailCapture("test")).not.toThrow();
  });

  it("refuses the file email capture outside APP_ENV=test", () => {
    expect(() => new FileEmailCapture("/tmp/psa-capture", "local")).toThrow(
      /only when APP_ENV=test/,
    );
  });

  it("refuses to deliver email by default", async () => {
    await expect(
      new RefusingEmailTransport().deliver({
        template: "PASSWORD_CHANGED",
        to: "test.person@example.test",
        subject: "s",
        text: "t",
        html: "h",
      }),
    ).rejects.toThrow("DEPENDENCY.UNAVAILABLE");
  });

  it("refuses the account factory outside APP_ENV=test", async () => {
    const previous = process.env.APP_ENV;
    process.env.APP_ENV = "production";
    try {
      await expect(createTestAccount({} as Auth)).rejects.toThrow(
        /only when APP_ENV=test/,
      );
    } finally {
      if (previous === undefined) delete process.env.APP_ENV;
      else process.env.APP_ENV = previous;
    }
  });
});

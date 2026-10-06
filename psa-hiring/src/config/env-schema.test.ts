import { describe, expect, it } from "vitest";
import {
  buildProductionEnvInput,
  buildServerEnvInput,
} from "../../tests/fixtures/foundation";
import {
  parseLocalBootstrapEnv,
  parseMigrationEnv,
  parseServerEnv,
  ServerEnvError,
} from "./env-schema";

function problemsOf(fn: () => unknown): string[] {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ServerEnvError);
    const envError = error as ServerEnvError;
    return [...envError.problems, envError.message];
  }
  throw new Error("expected configuration to be rejected");
}

const migratorUrl =
  "postgresql://psa_migrator:TEST_migrator_password@127.0.0.1:5432/psa_test_fixture";
const adminUrl =
  "postgresql://psa_admin:TEST_admin_password@127.0.0.1:5432/psa_test_fixture";

describe("parseServerEnv (runtime)", () => {
  it("accepts a valid local configuration and returns a frozen object with defaults", () => {
    const env = parseServerEnv(buildServerEnvInput());
    expect(env.SMTP_PORT).toBe(1025);
    expect(env.DATABASE_POOL_MAX).toBe(5);
    expect(env.DATABASE_CONNECTION_TIMEOUT_MS).toBe(5000);
    expect(Object.isFrozen(env)).toBe(true);
  });

  it("accepts a production-shaped synthetic configuration", () => {
    expect(parseServerEnv(buildProductionEnvInput()).APP_ENV).toBe(
      "production",
    );
  });

  it("does not require the migration or admin URLs", () => {
    const env = parseServerEnv(buildServerEnvInput());
    expect(env).not.toHaveProperty("DATABASE_MIGRATION_URL");
    expect(env).not.toHaveProperty("DATABASE_ADMIN_URL");
  });

  it("names a missing DATABASE_URL", () => {
    const problems = problemsOf(() =>
      parseServerEnv(buildServerEnvInput({ DATABASE_URL: undefined })),
    );
    expect(problems).toContain("DATABASE_URL is required");
  });

  it("requires explicit APP_ENV and PROVIDER_MODE (no silent defaults)", () => {
    const problems = problemsOf(() =>
      parseServerEnv(
        buildServerEnvInput({ APP_ENV: undefined, PROVIDER_MODE: undefined }),
      ),
    );
    expect(problems.some((p) => p.startsWith("APP_ENV "))).toBe(true);
    expect(problems.some((p) => p.startsWith("PROVIDER_MODE "))).toBe(true);
  });

  it.each(["0", "65536", "abc", "25.5"])("rejects SMTP_PORT=%s", (port) => {
    const problems = problemsOf(() =>
      parseServerEnv(buildServerEnvInput({ SMTP_PORT: port })),
    );
    expect(problems).toContain(
      "SMTP_PORT must be an integer between 1 and 65535",
    );
  });

  it.each([
    ["DATABASE_POOL_MAX", "0"],
    ["DATABASE_POOL_MAX", "21"],
    ["DATABASE_CONNECTION_TIMEOUT_MS", "100"],
    ["DATABASE_IDLE_TIMEOUT_MS", "999999"],
  ])("rejects out-of-range %s=%s", (key, value) => {
    const problems = problemsOf(() =>
      parseServerEnv(buildServerEnvInput({ [key]: value })),
    );
    expect(
      problems.some((p) => p.startsWith(`${key} must be an integer`)),
    ).toBe(true);
  });

  it.each([
    "mysql://user:TEST-canary-secret-91@db.example.com/app",
    "postgres://user:TEST-canary-secret-91@",
    "not a url TEST-canary-secret-91",
  ])("never echoes a credential-bearing invalid URL (%#)", (url) => {
    const output = problemsOf(() =>
      parseServerEnv(buildServerEnvInput({ DATABASE_URL: url })),
    ).join("\n");
    expect(output).toContain("DATABASE_URL");
    expect(output).not.toContain("TEST-canary-secret-91");
    expect(output).not.toContain("user:");
  });

  it("rejects a non-reserved sender domain outside production", () => {
    const problems = problemsOf(() =>
      parseServerEnv(buildServerEnvInput({ SMTP_FROM: "hr@agency.internal" })),
    );
    expect(problems.some((p) => p.startsWith("SMTP_FROM "))).toBe(true);
  });

  it("rejects a runtime URL that reuses the migration role", () => {
    const problems = problemsOf(() =>
      parseServerEnv(
        buildServerEnvInput({
          DATABASE_URL: migratorUrl,
          DATABASE_MIGRATION_URL: migratorUrl,
        }),
      ),
    );
    expect(problems).toContain(
      "DATABASE_URL must use a different database role than DATABASE_MIGRATION_URL",
    );
  });

  describe("production fails closed", () => {
    it("rejects fake providers", () => {
      const problems = problemsOf(() =>
        parseServerEnv(buildProductionEnvInput({ PROVIDER_MODE: "fake" })),
      );
      expect(problems).toContain(
        "PROVIDER_MODE fake providers are not allowed in production",
      );
    });

    it.each(["127.0.0.1", "localhost", "[::1]", "api.localhost"])(
      "rejects loopback database and SMTP host %s",
      (host) => {
        const problems = problemsOf(() =>
          parseServerEnv(
            buildProductionEnvInput({
              DATABASE_URL: `postgresql://psa_app@${host}:5432/psa`,
              SMTP_HOST: host.replace(/^\[|\]$/g, ""),
            }),
          ),
        );
        expect(problems.some((p) => p.startsWith("DATABASE_URL "))).toBe(true);
        expect(problems.some((p) => p.startsWith("SMTP_HOST "))).toBe(true);
      },
    );

    it.each([
      "./.local/documents",
      ".local/documents",
      "/app/.local/x",
      "docs",
    ])("rejects repository-local document path %s", (dir) => {
      const problems = problemsOf(() =>
        parseServerEnv(buildProductionEnvInput({ DOCUMENT_STORAGE_ROOT: dir })),
      );
      expect(problems.some((p) => p.startsWith("DOCUMENT_STORAGE_ROOT "))).toBe(
        true,
      );
    });
  });
});

describe("parseMigrationEnv", () => {
  it("accepts an explicit migration URL", () => {
    expect(
      parseMigrationEnv({
        APP_ENV: "test",
        DATABASE_MIGRATION_URL: migratorUrl,
      }).DATABASE_MIGRATION_URL,
    ).toBe(migratorUrl);
  });

  it("never falls back to DATABASE_URL", () => {
    const problems = problemsOf(() =>
      parseMigrationEnv({
        APP_ENV: "test",
        DATABASE_URL: buildServerEnvInput().DATABASE_URL,
      }),
    );
    expect(problems).toContain("DATABASE_MIGRATION_URL is required");
  });
});

describe("parseLocalBootstrapEnv", () => {
  const valid = {
    APP_ENV: "test",
    DATABASE_ADMIN_URL: adminUrl,
    DATABASE_MIGRATION_URL: migratorUrl,
    DATABASE_URL: buildServerEnvInput().DATABASE_URL,
  };

  it("accepts loopback URLs for the fixed local roles", () => {
    expect(parseLocalBootstrapEnv(valid).APP_ENV).toBe("test");
  });

  it.each(["staging", "production"])("refuses APP_ENV=%s", (appEnv) => {
    const problems = problemsOf(() =>
      parseLocalBootstrapEnv({ ...valid, APP_ENV: appEnv }),
    );
    expect(problems).toContain(
      "APP_ENV must be local or test; local database bootstrap is refused",
    );
  });

  it("refuses a non-loopback host without echoing its password", () => {
    const output = problemsOf(() =>
      parseLocalBootstrapEnv({
        ...valid,
        DATABASE_ADMIN_URL:
          "postgresql://psa_admin:TEST-canary-secret-91@db.example.com/psa_test_fixture",
      }),
    ).join("\n");
    expect(output).toContain(
      "DATABASE_ADMIN_URL must point to a loopback host for local bootstrap",
    );
    expect(output).not.toContain("TEST-canary-secret-91");
  });

  it("requires the fixed migrator and app role names", () => {
    const problems = problemsOf(() =>
      parseLocalBootstrapEnv({
        ...valid,
        DATABASE_MIGRATION_URL: adminUrl,
        DATABASE_URL: adminUrl,
      }),
    );
    expect(problems).toContain(
      "DATABASE_MIGRATION_URL must use the psa_migrator role",
    );
    expect(problems).toContain("DATABASE_URL must use the psa_app role");
  });
});

import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseServerEnv, ServerEnvError } from "@/config/env-schema";
import { parseAuditKeyRing } from "@/modules/audit";
import { NonproductionAssignmentHarness } from "@/modules/identity-access/infrastructure/assignment-harness";
import { parseAuthEnv } from "@/modules/identity-access/infrastructure/auth-env";
import {
  SyntheticCandidateOwnership,
  SyntheticScopeResolver,
} from "@/modules/identity-access/infrastructure/scope-resolvers";
import { NonproductionHarnessGate } from "@/modules/identity-access/infrastructure/staff-administration-gate";
import { buildProductionEnvInput } from "../fixtures/foundation";
import type { ScopeResourceResolver } from "@/modules/identity-access/application/ports/scope-resource-resolver";
import { refusingBootstrap } from "@/modules/organization/application/configuration-runtime";
import { OrganizationScopeResolver } from "@/modules/organization/infrastructure/organization-scope-resolver";

// M1.7 §20, §31(14), AC-M1.7-13: production-like configuration rejects
// every test adapter, test key/secret, insecure setting, and harness, in
// one place, without echoing a value. Each row names the guard and the
// production-like environment it must refuse in.

const productionLike = ["staging", "production"] as const;
const goodKey = () => randomBytes(32).toString("base64");

function refuses(fn: () => unknown): string[] {
  try {
    fn();
  } catch (error) {
    if (error instanceof ServerEnvError) return [...error.problems];
    return [(error as Error).message];
  }
  throw new Error("expected production-like configuration to be refused");
}

const authBase = {
  BETTER_AUTH_SECRET: goodKey(),
  BETTER_AUTH_URL: "https://hiring.example.test",
  AUTH_TRUSTED_ORIGINS: "https://hiring.example.test",
};

describe("production-like configuration refuses unsafe settings (§20)", () => {
  it.each(productionLike)(
    "%s refuses fake providers, loopback hosts, and repository-local storage",
    (env) => {
      for (const override of [
        { PROVIDER_MODE: "fake" },
        { DATABASE_URL: "postgresql://psa_app@127.0.0.1:5432/psa" },
        { SMTP_HOST: "localhost" },
        { DOCUMENT_STORAGE_ROOT: ".local/documents" },
      ]) {
        expect(
          refuses(() =>
            parseServerEnv(
              buildProductionEnvInput({ APP_ENV: env, ...override }),
            ),
          ).length,
          JSON.stringify(Object.keys(override)),
        ).toBeGreaterThan(0);
      }
    },
  );

  it.each(productionLike)(
    "%s refuses test or placeholder auth secrets and insecure auth settings",
    (env) => {
      const cases = [
        { BETTER_AUTH_SECRET: "TEST-auth-secret-for-disposable-db-only-0000" },
        { BETTER_AUTH_SECRET: "replace_with_output_of_openssl_rand_hex_32" },
        { BETTER_AUTH_URL: "http://hiring.example.test" },
        { AUTH_TRUSTED_ORIGINS: "http://localhost:3000" },
        {
          AUTH_EMAIL_TRANSPORT: "capture-file",
          AUTH_EMAIL_CAPTURE_DIR: "/tmp/x",
        },
        { AUTH_STAFF_MFA_LOCKOUT_SECONDS: "5" },
        { AUTH_STAFF_RECENT_AUTH_SECONDS: "20" },
      ];
      for (const override of cases) {
        const problems = refuses(() =>
          parseAuthEnv({ APP_ENV: env, ...authBase, ...override }),
        );
        expect(
          problems.length,
          JSON.stringify(Object.keys(override)),
        ).toBeGreaterThan(0);
        // Secrets are never echoed (enum names and numeric limits may be).
        if ("BETTER_AUTH_SECRET" in override) {
          expect(
            problems.join(" ").includes(override.BETTER_AUTH_SECRET as string),
            "secret echoed",
          ).toBe(false);
        }
      }
    },
  );

  it.each(productionLike)(
    "%s refuses missing, synthetic, test, or reused audit integrity keys",
    (env) => {
      const secret = goodKey();
      for (const ring of [
        {},
        {
          AUDIT_INTEGRITY_KEYS: `t1:${goodKey()}`,
          AUDIT_INTEGRITY_ACTIVE_KEY_VERSION: "t1",
        },
        {
          AUDIT_INTEGRITY_KEYS: `v1:${secret}`,
          AUDIT_INTEGRITY_ACTIVE_KEY_VERSION: "v1",
          BETTER_AUTH_SECRET: secret,
        },
        {
          AUDIT_INTEGRITY_KEYS: `v1:${secret},v2:${secret}`,
          AUDIT_INTEGRITY_ACTIVE_KEY_VERSION: "v2",
        },
      ]) {
        expect(
          refuses(() => parseAuditKeyRing({ APP_ENV: env, ...ring })).length,
        ).toBeGreaterThan(0);
      }
    },
  );

  it.each(productionLike)(
    "%s refuses every synthetic resolver and test harness",
    (env) => {
      for (const make of [
        () => new SyntheticScopeResolver(env),
        () => new SyntheticCandidateOwnership(env),
        () => new NonproductionAssignmentHarness(env),
        () => new NonproductionHarnessGate(env),
      ]) {
        expect(refuses(make).length).toBeGreaterThan(0);
      }
    },
  );

  it("refuses the M2.1 bootstrap provisioning actor by default and fails scope resolution closed (M2.1)", async () => {
    expect(refusingBootstrap.allowsBootstrap()).toBe(false);
    // A real resolver whose database is unreachable answers UNAVAILABLE,
    // and assignment-set/audit-assignment scopes have no adapter yet.
    const broken: ScopeResourceResolver = new OrganizationScopeResolver(() => {
      throw new Error("TEST database unavailable");
    });
    const id = "00000000-0000-4000-8000-000000000001";
    const at = new Date();
    expect(await broken.resolveScope("ORGANIZATION", id, at, {})).toEqual({
      status: "UNAVAILABLE",
    });
    expect(await broken.resolveResource(id, at, {})).toEqual({
      status: "UNAVAILABLE",
    });
    for (const type of ["ASSIGNED_RECORDS", "AUDIT_ASSIGNMENT"] as const) {
      expect(await broken.resolveScope(type, id, at, {})).toEqual({
        status: "UNAVAILABLE",
      });
    }
    expect(await broken.resolveScope("TEAM", "not-a-uuid", at, {})).toEqual({
      status: "MISSING",
    });
  });

  it("accepts the same production-shaped configuration once every unsafe value is removed", () => {
    expect(parseServerEnv(buildProductionEnvInput()).APP_ENV).toBe(
      "production",
    );
    expect(
      parseAuditKeyRing({
        APP_ENV: "production",
        AUDIT_INTEGRITY_KEYS: `v1:${goodKey()}`,
        AUDIT_INTEGRITY_ACTIVE_KEY_VERSION: "v1",
      }).activeVersion,
    ).toBe("v1");
  });
});

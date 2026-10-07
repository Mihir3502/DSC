import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ServerEnvError } from "@/config/env-schema";
import { parseAuditKeyRing } from "./hmac-key-ring";

// Packet M1.6 §12.2, §19, AC-M1.6-06/14: environment-separated, versioned
// integrity keys. Keys here are generated in memory and never printed.

const key = () => randomBytes(32).toString("base64");
const problems = (env: Record<string, string | undefined>) => {
  try {
    parseAuditKeyRing(env);
    return [];
  } catch (error) {
    expect(error).toBeInstanceOf(ServerEnvError);
    return (error as ServerEnvError).problems;
  }
};

describe("audit integrity key ring", () => {
  it("uses the deterministic synthetic key only in local and test", () => {
    expect(parseAuditKeyRing({ APP_ENV: "test" }).activeVersion).toBe("t1");
    expect(parseAuditKeyRing({ APP_ENV: "local" }).activeVersion).toBe("t1");
    for (const appEnv of ["staging", "production", undefined]) {
      expect(problems({ APP_ENV: appEnv })).toEqual([
        "AUDIT_INTEGRITY_KEYS is required",
      ]);
    }
  });

  it("rejects missing, placeholder, test, short, low-entropy, and reused keys in production", () => {
    const secret = key();
    const cases: Record<string, string>[] = [
      {
        AUDIT_INTEGRITY_KEYS: `t1:${key()}`,
        AUDIT_INTEGRITY_ACTIVE_KEY_VERSION: "t1",
      },
      {
        AUDIT_INTEGRITY_KEYS: `v1:${Buffer.alloc(16, 9).toString("base64")}`,
        AUDIT_INTEGRITY_ACTIVE_KEY_VERSION: "v1",
      },
      {
        AUDIT_INTEGRITY_KEYS: `v1:${Buffer.alloc(32, 1).toString("base64")}`,
        AUDIT_INTEGRITY_ACTIVE_KEY_VERSION: "v1",
      },
      {
        AUDIT_INTEGRITY_KEYS: "v1:change-me-placeholder",
        AUDIT_INTEGRITY_ACTIVE_KEY_VERSION: "v1",
      },
      {
        AUDIT_INTEGRITY_KEYS: `v1:${secret},v2:${secret}`,
        AUDIT_INTEGRITY_ACTIVE_KEY_VERSION: "v2",
      },
      {
        AUDIT_INTEGRITY_KEYS: `v1:${key()}`,
        AUDIT_INTEGRITY_ACTIVE_KEY_VERSION: "v9",
      },
      {
        AUDIT_INTEGRITY_KEYS: `v1:${key()},v1:${key()}`,
        AUDIT_INTEGRITY_ACTIVE_KEY_VERSION: "v1",
      },
      {
        AUDIT_INTEGRITY_KEYS: `v1:${secret}`,
        AUDIT_INTEGRITY_ACTIVE_KEY_VERSION: "v1",
        BETTER_AUTH_SECRET: secret,
      },
      {
        AUDIT_INTEGRITY_KEYS: `bad:${key()}`,
        AUDIT_INTEGRITY_ACTIVE_KEY_VERSION: "bad",
      },
    ];
    for (const env of cases) {
      const found = problems({ APP_ENV: "production", ...env });
      expect(found.length, JSON.stringify(Object.keys(env))).toBeGreaterThan(0);
      // Errors name the variable and rule, never the value.
      for (const value of Object.values(env)) {
        expect(found.join(" ")).not.toContain(value);
      }
    }
  });

  it("supports rotation: the active key signs, retained keys verify", () => {
    const env = {
      APP_ENV: "production",
      AUDIT_INTEGRITY_KEYS: `v1:${key()},v2:${key()}`,
    };
    const v1 = parseAuditKeyRing({
      ...env,
      AUDIT_INTEGRITY_ACTIVE_KEY_VERSION: "v1",
    });
    const v2 = parseAuditKeyRing({
      ...env,
      AUDIT_INTEGRITY_ACTIVE_KEY_VERSION: "v2",
    });
    expect(v2.activeVersion).toBe("v2");
    expect(v2.versions).toEqual(["v1", "v2"]);
    const mac = v1.sign("v1", "canonical");
    expect(v2.verify("v1", "canonical", mac)).toBe(true);
    expect(v2.verify("v2", "canonical", mac)).toBe(false);
    expect(v2.verify("v1", "canonical!", mac)).toBe(false);
    expect(v2.verify("v7", "canonical", mac)).toBe(false);
    expect(() => v2.sign("v7", "canonical")).toThrow();
  });
});

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { ServerEnvError } from "@/config/env-schema";

// Versioned HMAC-SHA256 integrity keys (packet M1.6 §12.2, AC-M1.6-06,
// ADR-0012). Keys come only from environment secret configuration and
// live only in process memory: never in the database, repository,
// fixtures, logs, errors, or artifacts. The active version signs new
// rows; every retained version stays available to verify old rows.
//
//   AUDIT_INTEGRITY_KEYS=v1:<base64 ≥32 bytes>,v2:<base64 ≥32 bytes>
//   AUDIT_INTEGRITY_ACTIVE_KEY_VERSION=v2
//
// Local and test runs without configuration use one deterministic,
// publicly known synthetic key version (t1). Staging and production
// refuse it, any t* version, and any missing, short, low-entropy,
// duplicated, or reused key. Errors name variables and rules only.

const versionPattern = /^[tv][0-9]{1,4}$/;
const SYNTHETIC_VERSION = "t1";
const SYNTHETIC_KEY = createHash("sha256")
  .update("psa-hiring synthetic audit integrity key for local/test only")
  .digest();

export type AuditKeyRing = Readonly<{
  activeVersion: string;
  versions: readonly string[];
  /** HMAC-SHA256 of the canonical bytes as lowercase hex. */
  sign(version: string, canonical: string): string;
  /** Constant-time comparison; false for an unknown version. */
  verify(version: string, canonical: string, expectedHex: string): boolean;
}>;

type EnvInput = Record<string, string | undefined>;

export function parseAuditKeyRing(env: EnvInput): AuditKeyRing {
  const appEnv = env.APP_ENV;
  const productionLike = appEnv === "staging" || appEnv === "production";
  const raw = env.AUDIT_INTEGRITY_KEYS?.trim();
  const problems: string[] = [];
  const keys = new Map<string, Buffer>();

  if (!raw) {
    if (productionLike || (appEnv !== "local" && appEnv !== "test")) {
      throw new ServerEnvError(["AUDIT_INTEGRITY_KEYS is required"]);
    }
    keys.set(SYNTHETIC_VERSION, SYNTHETIC_KEY);
    return keyRing(keys, SYNTHETIC_VERSION);
  }

  for (const entry of raw.split(",")) {
    const separator = entry.indexOf(":");
    const version = entry.slice(0, separator).trim();
    const encoded = entry.slice(separator + 1).trim();
    if (separator < 1 || !versionPattern.test(version)) {
      problems.push("AUDIT_INTEGRITY_KEYS has an invalid key version");
      continue;
    }
    if (keys.has(version)) {
      problems.push("AUDIT_INTEGRITY_KEYS repeats a key version");
      continue;
    }
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
      problems.push("AUDIT_INTEGRITY_KEYS must use base64 key values");
      continue;
    }
    const key = Buffer.from(encoded, "base64");
    if (key.length < 32 || key.length > 128) {
      problems.push("AUDIT_INTEGRITY_KEYS keys must be 32 to 128 bytes");
      continue;
    }
    if (new Set(key).size < 16) {
      problems.push("AUDIT_INTEGRITY_KEYS contains a low-entropy key");
    }
    if (productionLike) {
      if (version.startsWith("t") || key.equals(SYNTHETIC_KEY)) {
        problems.push("AUDIT_INTEGRITY_KEYS contains a test key");
      }
      if (env.BETTER_AUTH_SECRET && encoded === env.BETTER_AUTH_SECRET) {
        problems.push("AUDIT_INTEGRITY_KEYS must not reuse another secret");
      }
    }
    for (const existing of keys.values()) {
      if (existing.equals(key)) {
        problems.push("AUDIT_INTEGRITY_KEYS reuses one key for two versions");
      }
    }
    keys.set(version, key);
  }

  const active = env.AUDIT_INTEGRITY_ACTIVE_KEY_VERSION?.trim();
  if (!active || !keys.has(active)) {
    problems.push(
      "AUDIT_INTEGRITY_ACTIVE_KEY_VERSION must name a configured key version",
    );
  }
  if (problems.length > 0) throw new ServerEnvError([...new Set(problems)]);
  return keyRing(keys, active!);
}

function keyRing(
  keys: Map<string, Buffer>,
  activeVersion: string,
): AuditKeyRing {
  const sign = (version: string, canonical: string) => {
    const key = keys.get(version);
    if (!key) throw new Error("unknown integrity key version");
    return createHmac("sha256", key).update(canonical, "utf8").digest("hex");
  };
  return Object.freeze({
    activeVersion,
    versions: Object.freeze([...keys.keys()]),
    sign,
    verify(version: string, canonical: string, expectedHex: string) {
      if (!keys.has(version) || !/^[0-9a-f]{64}$/.test(expectedHex)) {
        return false;
      }
      return timingSafeEqual(
        Buffer.from(sign(version, canonical), "hex"),
        Buffer.from(expectedHex, "hex"),
      );
    },
  });
}

let cached: AuditKeyRing | undefined;

/** The process key ring, parsed lazily from process.env. */
export function getAuditKeyRing(): AuditKeyRing {
  cached ??= parseAuditKeyRing(process.env);
  return cached;
}

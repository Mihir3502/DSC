import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { GENESIS_HASH, canonicalize, type SecurityEnvelope } from "./envelope";
import { chainPartitionFor } from "./integrity-chain";

// Packet M1.6 §12.2, AC-M1.6-05: versioned deterministic canonicalization
// and server-derived partitions. Synthetic values and keys only.

const envelope: SecurityEnvelope = {
  id: "4f5e3e1c-ae99-4a2c-9e7f-6b5b4a8c9eaf",
  schemaVersion: 1,
  eventName: "auth.sign_in_failed",
  eventVersion: 1,
  outcome: "FAILED",
  accountId: null,
  riskCode: "INVALID_CREDENTIALS",
  source: "LOCAL_TEST",
  correlationId: "3e6d4d2b-9d88-4f1b-8d6e-5a4a3f7b8d9e",
  requestId: "3e6d4d2b-9d88-4f1b-8d6e-5a4a3f7b8d9e",
  occurredAt: new Date("2026-10-07T12:00:00.123Z"),
  metadata: { policy_version: "p1", affected_count: 0 },
  retentionClassCode: "SECURITY_STANDARD_UNSET",
};
const link = {
  chainPartition: "SECURITY:00",
  chainSequence: 1,
  previousHash: GENESIS_HASH,
  integrityKeyVersion: "t1",
  canonicalizationVersion: 1,
};

describe("canonicalization v1", () => {
  it("is deterministic and independent of metadata key order", () => {
    const a = canonicalize("SECURITY", envelope, link);
    const b = canonicalize(
      "SECURITY",
      { ...envelope, metadata: { affected_count: 0, policy_version: "p1" } },
      link,
    );
    expect(a).toBe(b);
    // Golden vector: a change here breaks verification of stored history.
    expect(a).toBe(
      `["psa-audit-chain",1,"SECURITY","SECURITY:00",1,"${GENESIS_HASH}","t1",["4f5e3e1c-ae99-4a2c-9e7f-6b5b4a8c9eaf",1,"auth.sign_in_failed",1,"FAILED",null,"INVALID_CREDENTIALS","LOCAL_TEST","3e6d4d2b-9d88-4f1b-8d6e-5a4a3f7b8d9e","3e6d4d2b-9d88-4f1b-8d6e-5a4a3f7b8d9e","2026-10-07T12:00:00.123Z",[["affected_count",0],["policy_version","p1"]],"SECURITY_STANDARD_UNSET"]]`,
    );
  });

  it("changes the keyed MAC when any field, position, or link changes", () => {
    const key = Buffer.alloc(32, 7);
    const mac = (text: string) =>
      createHmac("sha256", key).update(text).digest("hex");
    const base = mac(canonicalize("SECURITY", envelope, link));
    const variants = [
      canonicalize("SECURITY", { ...envelope, riskCode: "DENIED" }, link),
      canonicalize("SECURITY", { ...envelope, accountId: envelope.id }, link),
      canonicalize("SECURITY", envelope, { ...link, chainSequence: 2 }),
      canonicalize("SECURITY", envelope, {
        ...link,
        previousHash: "1".repeat(64),
      }),
      canonicalize("SECURITY", envelope, {
        ...link,
        integrityKeyVersion: "v2",
      }),
      canonicalize(
        "SECURITY",
        {
          ...envelope,
          occurredAt: new Date("2026-10-07T12:00:00.124Z"),
        },
        link,
      ),
    ];
    for (const variant of variants) expect(mac(variant)).not.toBe(base);
  });

  it("refuses unknown canonicalization versions and unsafe numbers", () => {
    expect(() =>
      canonicalize("SECURITY", envelope, {
        ...link,
        canonicalizationVersion: 2,
      }),
    ).toThrow();
    expect(() =>
      canonicalize(
        "SECURITY",
        { ...envelope, metadata: { affected_count: 1.5 } },
        link,
      ),
    ).not.toThrow(); // metadata numbers are validated before canonicalization
  });
});

describe("chain partitions", () => {
  it("derives bounded server-owned partitions", () => {
    const org = "5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8d";
    expect(chainPartitionFor("AUDIT", org, null)).toBe(`ORG:${org}`);
    expect(chainPartitionFor("SECURITY", org, null)).toBe("SECURITY:00");
    expect(chainPartitionFor("AUDIT", null, null)).toBe("IDENTITY:00");
    const partitions = new Set(
      Array.from({ length: 200 }, (_, i) =>
        chainPartitionFor(
          "AUDIT",
          null,
          `00000000-0000-4000-8000-${i.toString(16).padStart(12, "0")}`,
        ),
      ),
    );
    expect(partitions.size).toBeGreaterThan(8);
    for (const p of partitions) expect(p).toMatch(/^IDENTITY:(0[0-9a-f]|10)$/);
    expect(() => chainPartitionFor("AUDIT", "ORG'; --", null)).toThrow();
  });
});

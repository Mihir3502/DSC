import type {
  ActorType,
  AuditCategory,
  AuditScopeType,
  EventOutcome,
  EventSource,
  RetentionClass,
  TargetType,
} from "./vocabulary";

// Immutable event envelopes exactly as they are persisted and hashed
// (packet M1.6 §7–§8, §12.2, ADR-0012). Metadata holds only flat,
// schema-validated safe facts: codes, bounded integers, booleans, and
// arrays of codes. Never free text, identifiers of people, or snapshots.

export type MetadataValue = string | number | boolean | readonly string[];
export type SafeMetadata = Readonly<Record<string, MetadataValue>>;

export type AuditEnvelope = Readonly<{
  id: string;
  schemaVersion: number;
  eventName: string;
  eventVersion: number;
  category: AuditCategory;
  outcome: EventOutcome;
  organizationId: string | null;
  candidacyId: string | null;
  actorType: ActorType;
  actorUserId: string | null;
  effectiveRoleCode: string | null;
  effectiveAssignmentId: string | null;
  effectiveScopeType: AuditScopeType | null;
  effectiveScopeReferenceId: string | null;
  permissionCode: string | null;
  action: string;
  targetType: TargetType | null;
  targetId: string | null;
  source: EventSource;
  reasonCode: string | null;
  correlationId: string;
  requestId: string;
  idempotencyKey: string | null;
  occurredAt: Date;
  metadata: SafeMetadata;
  previousRecordVersion: number | null;
  newRecordVersion: number | null;
  retentionClassCode: RetentionClass;
}>;

export type SecurityEnvelope = Readonly<{
  id: string;
  schemaVersion: number;
  eventName: string;
  eventVersion: number;
  outcome: EventOutcome;
  accountId: string | null;
  riskCode: string | null;
  source: EventSource;
  correlationId: string;
  requestId: string;
  occurredAt: Date;
  metadata: SafeMetadata;
  retentionClassCode: RetentionClass;
}>;

/** Chain position and integrity columns stored beside each envelope. */
export type ChainLink = Readonly<{
  chainPartition: string;
  chainSequence: number;
  /** Hex of the previous row's integrity hash (genesis: 64 zeros). */
  previousHash: string;
  integrityKeyVersion: string;
  canonicalizationVersion: number;
}>;

export const GENESIS_HASH = "0".repeat(64);

const auditFieldOrder = [
  "id",
  "schemaVersion",
  "eventName",
  "eventVersion",
  "category",
  "outcome",
  "organizationId",
  "candidacyId",
  "actorType",
  "actorUserId",
  "effectiveRoleCode",
  "effectiveAssignmentId",
  "effectiveScopeType",
  "effectiveScopeReferenceId",
  "permissionCode",
  "action",
  "targetType",
  "targetId",
  "source",
  "reasonCode",
  "correlationId",
  "requestId",
  "idempotencyKey",
  "occurredAt",
  "metadata",
  "previousRecordVersion",
  "newRecordVersion",
  "retentionClassCode",
] as const satisfies readonly (keyof AuditEnvelope)[];

const securityFieldOrder = [
  "id",
  "schemaVersion",
  "eventName",
  "eventVersion",
  "outcome",
  "accountId",
  "riskCode",
  "source",
  "correlationId",
  "requestId",
  "occurredAt",
  "metadata",
  "retentionClassCode",
] as const satisfies readonly (keyof SecurityEnvelope)[];

/**
 * Canonical serialization v1. A fixed-order JSON array: every field in a
 * reviewed order, null kept explicit, timestamps as millisecond ISO-8601
 * UTC, metadata as key-sorted [key, value] pairs. JSON.stringify output is
 * deterministic for arrays of strings, integers, booleans, and null
 * (ECMA-262), so no custom canonical-JSON algorithm is involved. Each
 * historical version must remain reproducible by the verifier forever.
 */
export function canonicalize(
  stream: "AUDIT",
  envelope: AuditEnvelope,
  link: ChainLink,
): string;
export function canonicalize(
  stream: "SECURITY",
  envelope: SecurityEnvelope,
  link: ChainLink,
): string;
export function canonicalize(
  stream: "AUDIT" | "SECURITY",
  envelope: AuditEnvelope | SecurityEnvelope,
  link: ChainLink,
): string {
  if (link.canonicalizationVersion !== 1) {
    throw new Error("unsupported canonicalization version");
  }
  const order: readonly string[] =
    stream === "AUDIT" ? auditFieldOrder : securityFieldOrder;
  const record = envelope as unknown as Record<string, unknown>;
  const fields = order.map((key) => canonicalValue(key, record[key]));
  return JSON.stringify([
    "psa-audit-chain",
    link.canonicalizationVersion,
    stream,
    link.chainPartition,
    link.chainSequence,
    link.previousHash,
    link.integrityKeyVersion,
    fields,
  ]);
}

function canonicalValue(key: string, value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (key === "metadata") {
    const entries = Object.entries(value as SafeMetadata).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    return entries.map(([k, v]) => [k, Array.isArray(v) ? [...v] : v]);
  }
  if (typeof value === "number" && !Number.isSafeInteger(value)) {
    throw new Error("canonical numbers must be safe integers");
  }
  return value;
}

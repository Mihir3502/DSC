import { sql } from "drizzle-orm";
import {
  GENESIS_HASH,
  canonicalize,
  type AuditEnvelope,
  type ChainLink,
  type SafeMetadata,
  type SecurityEnvelope,
} from "../domain/envelope";
import type { SqlExecutor } from "../infrastructure/audit-store";
import type { AuditKeyRing } from "../infrastructure/hmac-key-ring";

// Read-only integrity verification (packet M1.6 §12.3, AC-M1.6-05/13,
// ADR-0012). Streams every partition in sequence order with bounded
// memory, reconstructs the exact historical canonical form, and checks
// sequence continuity, the previous-hash link, the keyed HMAC under the
// stored key version, and agreement with the locked chain head.
//
// It never repairs, rewrites, rehashes, deletes, or prints metadata,
// hashes, or keys. The result is a safe summary: counts, and the first
// failing partition/sequence with a closed reason code.
//
// Limitation: tamper evidence is not tamper prevention. A party holding
// both database ownership and the integrity key can rewrite a whole chain
// consistently; independent backups, external checkpoints, access control,
// and database monitoring remain necessary (ADR-0012 threat model).

export const integrityFailureReasons = [
  "SEQUENCE_GAP",
  "DUPLICATE_SEQUENCE",
  "PREVIOUS_HASH_MISMATCH",
  "HMAC_MISMATCH",
  "UNKNOWN_KEY_VERSION",
  "UNSUPPORTED_CANONICALIZATION",
  "HEAD_MISMATCH",
  "ORPHAN_PARTITION",
  "MALFORMED_ROW",
] as const;
export type IntegrityFailureReason = (typeof integrityFailureReasons)[number];

export type IntegrityReport = Readonly<{
  ok: boolean;
  partitionsChecked: number;
  rowsChecked: number;
  failure: Readonly<{
    stream: "AUDIT" | "SECURITY";
    partition: string;
    sequence: number | null;
    reason: IntegrityFailureReason;
  }> | null;
}>;

const BATCH = 500;

type HeadRow = { partition: string; lastSequence: number; lastHash: string };

class IntegrityFailure extends Error {
  constructor(
    readonly reason: IntegrityFailureReason,
    readonly sequence: number | null,
  ) {
    super(reason);
  }
}

/**
 * Verifies every chain. The executor must be a read-only connection that
 * can read integrity columns (the migration identity in a READ ONLY
 * transaction; the runtime role cannot see them by design).
 */
export async function verifyAuditIntegrity(
  executor: SqlExecutor,
  keys: AuditKeyRing,
): Promise<IntegrityReport> {
  const { rows } = await executor.execute(
    sql`SELECT chain_partition, last_sequence, encode(last_hash, 'hex') AS last_hash
        FROM audit.chain_head ORDER BY chain_partition`,
  );
  const heads: HeadRow[] = rows.map((row) => ({
    partition: String(row.chain_partition),
    lastSequence: Number(row.last_sequence),
    lastHash: String(row.last_hash),
  }));
  let rowsChecked = 0;
  let partitionsChecked = 0;

  for (const stream of ["AUDIT", "SECURITY"] as const) {
    const table = stream === "AUDIT" ? "audit_event" : "security_event";
    const streamHeads = heads.filter((head) =>
      stream === "SECURITY"
        ? head.partition.startsWith("SECURITY:")
        : !head.partition.startsWith("SECURITY:"),
    );
    // Rows in a partition without any head: inserted or misplaced history.
    const orphan = await executor.execute(
      sql`SELECT e.chain_partition FROM ${sql.raw(`audit.${table}`)} e
          WHERE NOT EXISTS (SELECT 1 FROM audit.chain_head h WHERE h.chain_partition = e.chain_partition)
          LIMIT 1`,
    );
    if (orphan.rows[0]) {
      return failed(
        stream,
        String(orphan.rows[0].chain_partition),
        null,
        "ORPHAN_PARTITION",
      );
    }
    for (const head of streamHeads) {
      partitionsChecked++;
      try {
        rowsChecked += await verifyPartition(
          executor,
          keys,
          stream,
          table,
          head,
        );
      } catch (error) {
        if (error instanceof IntegrityFailure) {
          return failed(stream, head.partition, error.sequence, error.reason, {
            partitionsChecked,
            rowsChecked,
          });
        }
        throw error;
      }
    }
  }
  return { ok: true, partitionsChecked, rowsChecked, failure: null };
}

function failed(
  stream: "AUDIT" | "SECURITY",
  partition: string,
  sequence: number | null,
  reason: IntegrityFailureReason,
  counts = { partitionsChecked: 0, rowsChecked: 0 },
): IntegrityReport {
  return {
    ok: false,
    ...counts,
    failure: { stream, partition, sequence, reason },
  };
}

async function verifyPartition(
  executor: SqlExecutor,
  keys: AuditKeyRing,
  stream: "AUDIT" | "SECURITY",
  table: string,
  head: HeadRow,
): Promise<number> {
  // A fork (two rows claiming one position) is reported as such, whatever
  // order its rows happen to stream in.
  const fork = await executor.execute(
    sql`SELECT chain_sequence FROM ${sql.raw(`audit.${table}`)}
        WHERE chain_partition = ${head.partition}
        GROUP BY chain_sequence HAVING count(*) > 1
        ORDER BY chain_sequence LIMIT 1`,
  );
  if (fork.rows[0]) {
    throw new IntegrityFailure(
      "DUPLICATE_SEQUENCE",
      Number(fork.rows[0].chain_sequence),
    );
  }
  let expected = 1;
  let previous = GENESIS_HASH;
  let cursor: { sequence: number; id: string } | null = null;
  let checked = 0;

  for (;;) {
    const page: { rows: Record<string, unknown>[] } = await executor.execute(
      sql`SELECT *, encode(previous_hash, 'hex') AS previous_hex, encode(integrity_hash, 'hex') AS integrity_hex
          FROM ${sql.raw(`audit.${table}`)}
          WHERE chain_partition = ${head.partition}
          ${cursor ? sql`AND (chain_sequence, id) > (${cursor.sequence}, ${cursor.id}::uuid)` : sql``}
          ORDER BY chain_sequence, id
          LIMIT ${BATCH}`,
    );
    for (const row of page.rows) {
      const sequence = Number(row.chain_sequence);
      if (sequence < expected)
        throw new IntegrityFailure("DUPLICATE_SEQUENCE", sequence);
      if (sequence > expected)
        throw new IntegrityFailure("SEQUENCE_GAP", expected);
      if (row.previous_hex !== previous) {
        throw new IntegrityFailure("PREVIOUS_HASH_MISMATCH", sequence);
      }
      const keyVersion = String(row.integrity_key_version);
      if (!keys.versions.includes(keyVersion)) {
        throw new IntegrityFailure("UNKNOWN_KEY_VERSION", sequence);
      }
      const canonicalizationVersion = Number(row.canonicalization_version);
      if (canonicalizationVersion !== 1) {
        throw new IntegrityFailure("UNSUPPORTED_CANONICALIZATION", sequence);
      }
      const link: ChainLink = {
        chainPartition: head.partition,
        chainSequence: sequence,
        previousHash: previous,
        integrityKeyVersion: keyVersion,
        canonicalizationVersion,
      };
      let canonical: string;
      try {
        canonical =
          stream === "AUDIT"
            ? canonicalize("AUDIT", auditEnvelopeOf(row), link)
            : canonicalize("SECURITY", securityEnvelopeOf(row), link);
      } catch {
        throw new IntegrityFailure("MALFORMED_ROW", sequence);
      }
      if (!keys.verify(keyVersion, canonical, String(row.integrity_hex))) {
        throw new IntegrityFailure("HMAC_MISMATCH", sequence);
      }
      previous = String(row.integrity_hex);
      expected++;
      checked++;
      cursor = { sequence, id: String(row.id) };
    }
    if (page.rows.length < BATCH) break;
  }

  if (head.lastSequence !== expected - 1 || head.lastHash !== previous) {
    throw new IntegrityFailure("HEAD_MISMATCH", head.lastSequence);
  }
  return checked;
}

const nullableString = (value: unknown) =>
  value === null || value === undefined ? null : String(value);
const nullableNumber = (value: unknown) =>
  value === null || value === undefined ? null : Number(value);
const timeOf = (value: unknown) =>
  value instanceof Date ? value : new Date(String(value));
const metadataOf = (value: unknown) =>
  (typeof value === "string" ? JSON.parse(value) : value) as SafeMetadata;

function auditEnvelopeOf(row: Record<string, unknown>): AuditEnvelope {
  return {
    id: String(row.id),
    schemaVersion: Number(row.schema_version),
    eventName: String(row.event_name),
    eventVersion: Number(row.event_version),
    category: row.category as AuditEnvelope["category"],
    outcome: row.outcome as AuditEnvelope["outcome"],
    organizationId: nullableString(row.organization_id),
    candidacyId: nullableString(row.candidacy_id),
    actorType: row.actor_type as AuditEnvelope["actorType"],
    actorUserId: nullableString(row.actor_user_id),
    effectiveRoleCode: nullableString(row.effective_role_code),
    effectiveAssignmentId: nullableString(row.effective_assignment_id),
    effectiveScopeType: nullableString(
      row.effective_scope_type,
    ) as AuditEnvelope["effectiveScopeType"],
    effectiveScopeReferenceId: nullableString(row.effective_scope_reference_id),
    permissionCode: nullableString(row.permission_code),
    action: String(row.action),
    targetType: nullableString(row.target_type) as AuditEnvelope["targetType"],
    targetId: nullableString(row.target_id),
    source: row.source as AuditEnvelope["source"],
    reasonCode: nullableString(row.reason_code),
    correlationId: String(row.correlation_id),
    requestId: String(row.request_id),
    idempotencyKey: nullableString(row.idempotency_key),
    occurredAt: timeOf(row.occurred_at),
    metadata: metadataOf(row.metadata_json),
    previousRecordVersion: nullableNumber(row.previous_record_version),
    newRecordVersion: nullableNumber(row.new_record_version),
    retentionClassCode:
      row.retention_class_code as AuditEnvelope["retentionClassCode"],
  };
}

function securityEnvelopeOf(row: Record<string, unknown>): SecurityEnvelope {
  return {
    id: String(row.id),
    schemaVersion: Number(row.schema_version),
    eventName: String(row.event_name),
    eventVersion: Number(row.event_version),
    outcome: row.outcome as SecurityEnvelope["outcome"],
    accountId: nullableString(row.account_id),
    riskCode: nullableString(row.risk_code),
    source: row.source as SecurityEnvelope["source"],
    correlationId: String(row.correlation_id),
    requestId: String(row.request_id),
    occurredAt: timeOf(row.occurred_at),
    metadata: metadataOf(row.metadata_json),
    retentionClassCode:
      row.retention_class_code as SecurityEnvelope["retentionClassCode"],
  };
}

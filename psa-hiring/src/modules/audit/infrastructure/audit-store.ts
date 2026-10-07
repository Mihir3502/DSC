import { sql, type SQL } from "drizzle-orm";
import type {
  AuditEnvelope,
  ChainLink,
  SecurityEnvelope,
} from "../domain/envelope";

// Append-only storage adapter (packet M1.6 §12.1, ADR-0012). It exposes
// exactly two operations: lock a chain head, and append one event through
// the reviewed SECURITY DEFINER functions. There is deliberately no
// update, delete, repair, or rehash operation anywhere in the runtime.

/** Any Drizzle database or transaction handle (both expose execute). */
export type SqlExecutor = Readonly<{
  execute(query: SQL): Promise<{ rows: Record<string, unknown>[] }>;
}>;

export type ClaimedHead = Readonly<{
  nextSequence: number;
  previousHash: string;
  occurredAt: Date;
}>;

export async function claimChainHead(
  executor: SqlExecutor,
  partition: string,
): Promise<ClaimedHead> {
  const { rows } = await executor.execute(
    sql`SELECT next_sequence, previous_hash, occurred_at FROM audit.claim_chain_head(${partition})`,
  );
  const row = rows[0];
  if (!row) throw new Error("audit chain head unavailable");
  const occurredAt =
    row.occurred_at instanceof Date
      ? row.occurred_at
      : new Date(String(row.occurred_at));
  return {
    nextSequence: Number(row.next_sequence),
    previousHash: String(row.previous_hash),
    occurredAt,
  };
}

const hexBytes = (hex: string) => `\\x${hex}`;

function integrityJson(link: ChainLink, integrityHash: string) {
  return {
    chain_partition: link.chainPartition,
    chain_sequence: link.chainSequence,
    previous_hash: hexBytes(link.previousHash),
    integrity_hash: hexBytes(integrityHash),
    integrity_key_version: link.integrityKeyVersion,
    canonicalization_version: link.canonicalizationVersion,
  };
}

/** Appends one audit event; returns the stored (or deduplicated) ID. */
export async function appendAuditRow(
  executor: SqlExecutor,
  envelope: AuditEnvelope,
  link: ChainLink,
  integrityHash: string,
): Promise<string> {
  const row = {
    id: envelope.id,
    schema_version: envelope.schemaVersion,
    event_name: envelope.eventName,
    event_version: envelope.eventVersion,
    category: envelope.category,
    outcome: envelope.outcome,
    organization_id: envelope.organizationId,
    candidacy_id: envelope.candidacyId,
    actor_type: envelope.actorType,
    actor_user_id: envelope.actorUserId,
    effective_role_code: envelope.effectiveRoleCode,
    effective_assignment_id: envelope.effectiveAssignmentId,
    effective_scope_type: envelope.effectiveScopeType,
    effective_scope_reference_id: envelope.effectiveScopeReferenceId,
    permission_code: envelope.permissionCode,
    action: envelope.action,
    target_type: envelope.targetType,
    target_id: envelope.targetId,
    source: envelope.source,
    reason_code: envelope.reasonCode,
    correlation_id: envelope.correlationId,
    request_id: envelope.requestId,
    idempotency_key: envelope.idempotencyKey,
    occurred_at: envelope.occurredAt.toISOString(),
    metadata_json: envelope.metadata,
    previous_record_version: envelope.previousRecordVersion,
    new_record_version: envelope.newRecordVersion,
    retention_class_code: envelope.retentionClassCode,
    ...integrityJson(link, integrityHash),
  };
  const { rows } = await executor.execute(
    sql`SELECT audit.append_audit_event(${JSON.stringify(row)}::jsonb) AS id`,
  );
  return String(rows[0]?.id);
}

export async function appendSecurityRow(
  executor: SqlExecutor,
  envelope: SecurityEnvelope,
  link: ChainLink,
  integrityHash: string,
): Promise<string> {
  const row = {
    id: envelope.id,
    schema_version: envelope.schemaVersion,
    event_name: envelope.eventName,
    event_version: envelope.eventVersion,
    outcome: envelope.outcome,
    account_id: envelope.accountId,
    risk_code: envelope.riskCode,
    source: envelope.source,
    correlation_id: envelope.correlationId,
    request_id: envelope.requestId,
    occurred_at: envelope.occurredAt.toISOString(),
    metadata_json: envelope.metadata,
    retention_class_code: envelope.retentionClassCode,
    ...integrityJson(link, integrityHash),
  };
  const { rows } = await executor.execute(
    sql`SELECT audit.append_security_event(${JSON.stringify(row)}::jsonb) AS id`,
  );
  return String(rows[0]?.id);
}

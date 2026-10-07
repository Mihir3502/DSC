// Exact audit query projection (packet M1.6 §16.3, ADR-0012). Pure: only
// the listed fields leave the audit module. Never integrity hashes, key
// versions, chain partitions or sequences, request IDs, idempotency keys,
// internal assignment/scope reference IDs, unrestricted metadata, or
// denial policy detail. Metadata keys pass only when the event's catalog
// definition marks them projectable.

export type AuditEventView = Readonly<{
  id: string;
  occurredAt: Date;
  eventName: string;
  category: string;
  outcome: string;
  action: string;
  actor: Readonly<{ type: string; ref: string | null }>;
  /** Effective role and scope type summary; never the reference IDs. */
  authority: Readonly<{ roleCode: string; scopeType: string | null }> | null;
  target: Readonly<{ type: string; ref: string | null }> | null;
  reasonCode: string | null;
  correlationId: string;
  metadata: Readonly<
    Record<string, string | number | boolean | readonly string[]>
  >;
}>;

export const auditEventViewKeys = [
  "id",
  "occurredAt",
  "eventName",
  "category",
  "outcome",
  "action",
  "actor",
  "authority",
  "target",
  "reasonCode",
  "correlationId",
  "metadata",
] as const satisfies readonly (keyof AuditEventView)[];

type Lookup = (
  name: string,
  version?: number,
) => { projectable: readonly string[] } | null;

const str = (v: unknown) => (v === null || v === undefined ? null : String(v));

export function projectAuditEvent(
  row: Record<string, unknown>,
  findDefinition: Lookup,
): AuditEventView {
  const definition = findDefinition(
    String(row.event_name),
    Number(row.event_version),
  );
  const raw = (
    typeof row.metadata_json === "string"
      ? JSON.parse(row.metadata_json)
      : row.metadata_json
  ) as Record<string, unknown>;
  const metadata: Record<
    string,
    string | number | boolean | readonly string[]
  > = {};
  for (const key of definition?.projectable ?? []) {
    const value = raw?.[key];
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      metadata[key] = value;
    } else if (
      Array.isArray(value) &&
      value.every((v) => typeof v === "string")
    ) {
      metadata[key] = Object.freeze([...value]);
    }
  }
  const roleCode = str(row.effective_role_code);
  const targetType = str(row.target_type);
  return Object.freeze({
    id: String(row.id),
    occurredAt:
      row.occurred_at instanceof Date
        ? row.occurred_at
        : new Date(String(row.occurred_at)),
    eventName: String(row.event_name),
    category: String(row.category),
    outcome: String(row.outcome),
    action: String(row.action),
    actor: Object.freeze({
      type: String(row.actor_type),
      ref: str(row.actor_user_id),
    }),
    authority: roleCode
      ? Object.freeze({ roleCode, scopeType: str(row.effective_scope_type) })
      : null,
    target: targetType
      ? Object.freeze({ type: targetType, ref: str(row.target_id) })
      : null,
    reasonCode: str(row.reason_code),
    correlationId: String(row.correlation_id),
    metadata: Object.freeze(metadata),
  });
}

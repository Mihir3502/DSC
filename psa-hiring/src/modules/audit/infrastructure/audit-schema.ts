import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  customType,
  foreignKey,
  index,
  integer,
  jsonb,
  pgSchema,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { user } from "../../identity-access/infrastructure/auth-schema";

// Append-only audit persistence (packet M1.6 §7, §8, §12, §17, ADR-0012).
//
// A dedicated `audit` schema owned by the migration role with NO default
// privileges for the runtime role, so no future table inherits write
// access. The runtime role may only EXECUTE the reviewed append functions
// and SELECT the projection columns of audit_event; it never receives
// INSERT, UPDATE, DELETE, TRUNCATE, or access to integrity columns or the
// chain head. Triggers reject UPDATE/DELETE/TRUNCATE for every role,
// including the owner (disabling them is an operational, audited act
// outside the application). The functions, triggers, and revocations are
// hand-written in drizzle/0004_audit_foundation.sql.
//
// No mutable updated_at, status, soft-delete, or deletion marker exists.
// Organization and candidacy references are opaque UUIDs until M2 creates
// those tables; actor/account references RESTRICT deletion of the account.

export const auditSchema = pgSchema("audit");

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => "bytea",
});

const ms = { withTimezone: true, precision: 3 } as const;

const closed = (column: string, values: readonly string[]) =>
  sql.raw(`${column} IN (${values.map((v) => `'${v}'`).join(", ")})`);

const integrityColumns = {
  chainPartition: varchar("chain_partition", { length: 48 }).notNull(),
  chainSequence: bigint("chain_sequence", { mode: "number" }).notNull(),
  previousHash: bytea("previous_hash").notNull(),
  integrityHash: bytea("integrity_hash").notNull(),
  integrityKeyVersion: varchar("integrity_key_version", {
    length: 8,
  }).notNull(),
  canonicalizationVersion: integer("canonicalization_version").notNull(),
};

const integrityChecks = (name: string) => [
  check(
    `${name}_partition_check`,
    sql.raw(
      `chain_partition ~ '^((IDENTITY|SECURITY):[0-9a-f]{2}|ORG:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$'`,
    ),
  ),
  check(`${name}_sequence_check`, sql.raw(`chain_sequence >= 1`)),
  check(
    `${name}_hash_check`,
    sql.raw(
      `octet_length(previous_hash) = 32 AND octet_length(integrity_hash) = 32`,
    ),
  ),
  check(
    `${name}_key_version_check`,
    sql.raw(`integrity_key_version ~ '^[tv][0-9]{1,4}$'`),
  ),
  check(
    `${name}_canonicalization_check`,
    sql.raw(`canonicalization_version = 1`),
  ),
  check(`${name}_schema_version_check`, sql.raw(`schema_version = 1`)),
  check(`${name}_event_version_check`, sql.raw(`event_version >= 1`)),
  check(
    `${name}_event_name_check`,
    sql.raw(`event_name ~ '^[a-z][a-z0-9_]{0,31}\\.[a-z][a-z0-9_]{0,62}$'`),
  ),
  check(
    `${name}_metadata_check`,
    sql.raw(
      `jsonb_typeof(metadata_json) = 'object' AND pg_column_size(metadata_json) <= 2048`,
    ),
  ),
  check(
    `${name}_time_check`,
    sql.raw(
      `occurred_at <= recorded_at + interval '5 seconds' AND occurred_at >= recorded_at - interval '10 minutes'`,
    ),
  ),
  check(
    `${name}_source_check`,
    closed("source", ["WEB", "API", "JOB", "PROVIDER", "SYSTEM", "LOCAL_TEST"]),
  ),
  check(
    `${name}_outcome_check`,
    closed("outcome", ["SUCCEEDED", "DENIED", "FAILED"]),
  ),
  check(
    `${name}_reference_check`,
    sql.raw(`correlation_id IS NOT NULL AND request_id IS NOT NULL`),
  ),
];

const uuidColumn = (name: string) => uuid(name);

export const auditEvent = auditSchema.table(
  "audit_event",
  {
    id: uuid("id").primaryKey(),
    schemaVersion: integer("schema_version").notNull(),
    eventName: varchar("event_name", { length: 96 }).notNull(),
    eventVersion: integer("event_version").notNull(),
    category: varchar("category", { length: 32 }).notNull(),
    outcome: varchar("outcome", { length: 16 }).notNull(),
    organizationId: uuidColumn("organization_id"),
    candidacyId: uuidColumn("candidacy_id"),
    actorType: varchar("actor_type", { length: 16 }).notNull(),
    actorUserId: uuidColumn("actor_user_id"),
    effectiveRoleCode: varchar("effective_role_code", { length: 64 }),
    effectiveAssignmentId: uuidColumn("effective_assignment_id"),
    effectiveScopeType: varchar("effective_scope_type", { length: 32 }),
    effectiveScopeReferenceId: uuidColumn("effective_scope_reference_id"),
    permissionCode: varchar("permission_code", { length: 100 }),
    action: varchar("action", { length: 64 }).notNull(),
    targetType: varchar("target_type", { length: 32 }),
    targetId: uuidColumn("target_id"),
    source: varchar("source", { length: 16 }).notNull(),
    reasonCode: varchar("reason_code", { length: 64 }),
    correlationId: uuid("correlation_id").notNull(),
    requestId: uuid("request_id").notNull(),
    idempotencyKey: varchar("idempotency_key", { length: 64 }),
    occurredAt: timestamp("occurred_at", ms).notNull(),
    recordedAt: timestamp("recorded_at", ms).notNull(),
    metadataJson: jsonb("metadata_json").notNull(),
    previousRecordVersion: bigint("previous_record_version", {
      mode: "number",
    }),
    newRecordVersion: bigint("new_record_version", { mode: "number" }),
    retentionClassCode: varchar("retention_class_code", {
      length: 32,
    }).notNull(),
    ...integrityColumns,
  },
  (table) => [
    foreignKey({
      name: "audit_event_actor_user_fk",
      columns: [table.actorUserId],
      foreignColumns: [user.id],
    })
      .onDelete("restrict")
      .onUpdate("restrict"),
    unique("audit_event_chain_unique").on(
      table.chainPartition,
      table.chainSequence,
    ),
    uniqueIndex("audit_event_idempotency_unique")
      .on(table.eventName, table.idempotencyKey)
      .where(sql`${table.idempotencyKey} IS NOT NULL`),
    index("audit_event_occurred_idx").on(table.occurredAt, table.id),
    index("audit_event_target_idx").on(
      table.targetType,
      table.targetId,
      table.occurredAt,
    ),
    index("audit_event_actor_idx").on(table.actorUserId, table.occurredAt),
    index("audit_event_organization_idx")
      .on(table.organizationId, table.occurredAt, table.id)
      .where(sql`${table.organizationId} IS NOT NULL`),
    index("audit_event_candidacy_idx")
      .on(table.candidacyId, table.occurredAt)
      .where(sql`${table.candidacyId} IS NOT NULL`),
    index("audit_event_category_idx").on(table.category, table.occurredAt),
    index("audit_event_correlation_idx").on(table.correlationId),
    ...integrityChecks("audit_event"),
    check(
      "audit_event_category_check",
      closed("category", [
        "IDENTITY",
        "ACCESS_CONTROL",
        "SECURITY",
        "RESTRICTED_ACCESS",
        "CONFIGURATION",
        "AUDIT_ACCESS",
      ]),
    ),
    check(
      "audit_event_actor_check",
      sql.raw(
        `(actor_type = 'USER' AND actor_user_id IS NOT NULL) OR (actor_type IN ('SERVICE', 'SYSTEM', 'ANONYMOUS') AND actor_user_id IS NULL)`,
      ),
    ),
    check(
      "audit_event_scope_check",
      sql.raw(
        `(effective_scope_type IS NULL) = (effective_scope_reference_id IS NULL) AND (effective_scope_type IS NULL OR effective_scope_type IN ('ASSIGNED_RECORDS', 'TEAM', 'BRANCH', 'ORGANIZATION', 'AUDIT_ASSIGNMENT')) AND (effective_role_code IS NOT NULL OR (effective_scope_type IS NULL AND effective_assignment_id IS NULL)) AND (effective_role_code IS NULL OR actor_type = 'USER')`,
      ),
    ),
    check(
      "audit_event_target_check",
      sql.raw(
        `(target_type IS NOT NULL OR target_id IS NULL) AND (target_type IS NULL OR target_type IN ('USER_ACCOUNT', 'STAFF_INVITATION', 'STAFF_RECOVERY_CASE', 'ROLE_ASSIGNMENT', 'AUTHORIZATION_CATALOG', 'PROTECTED_RESOURCE', 'AUDIT_LOG')) AND (target_id IS NOT NULL OR target_type IS NULL OR target_type IN ('AUTHORIZATION_CATALOG', 'AUDIT_LOG'))`,
      ),
    ),
    check(
      "audit_event_version_check",
      sql.raw(
        `(previous_record_version IS NULL OR previous_record_version >= 0) AND (new_record_version IS NULL OR new_record_version >= 1) AND (previous_record_version IS NULL OR new_record_version = previous_record_version + 1)`,
      ),
    ),
    check(
      "audit_event_code_check",
      sql.raw(
        `action ~ '^[A-Z][A-Z0-9_]{0,63}$' AND (reason_code IS NULL OR reason_code ~ '^[A-Z][A-Z0-9_]{0,63}$') AND (effective_role_code IS NULL OR effective_role_code ~ '^[A-Z][A-Z0-9_]{0,63}$') AND (permission_code IS NULL OR permission_code ~ '^[a-z][a-z0-9_.]{0,99}$') AND (idempotency_key IS NULL OR idempotency_key ~ '^[0-9a-f-]{36}:[0-9]{1,19}$')`,
      ),
    ),
    check(
      "audit_event_retention_check",
      sql.raw(`retention_class_code = 'AUDIT_STANDARD_UNSET'`),
    ),
  ],
);

export const securityEvent = auditSchema.table(
  "security_event",
  {
    id: uuid("id").primaryKey(),
    schemaVersion: integer("schema_version").notNull(),
    eventName: varchar("event_name", { length: 96 }).notNull(),
    eventVersion: integer("event_version").notNull(),
    outcome: varchar("outcome", { length: 16 }).notNull(),
    accountId: uuidColumn("account_id"),
    riskCode: varchar("risk_code", { length: 64 }),
    source: varchar("source", { length: 16 }).notNull(),
    correlationId: uuid("correlation_id").notNull(),
    requestId: uuid("request_id").notNull(),
    occurredAt: timestamp("occurred_at", ms).notNull(),
    recordedAt: timestamp("recorded_at", ms).notNull(),
    metadataJson: jsonb("metadata_json").notNull(),
    retentionClassCode: varchar("retention_class_code", {
      length: 32,
    }).notNull(),
    ...integrityColumns,
  },
  (table) => [
    foreignKey({
      name: "security_event_account_fk",
      columns: [table.accountId],
      foreignColumns: [user.id],
    })
      .onDelete("restrict")
      .onUpdate("restrict"),
    unique("security_event_chain_unique").on(
      table.chainPartition,
      table.chainSequence,
    ),
    index("security_event_occurred_idx").on(table.occurredAt, table.id),
    index("security_event_account_idx").on(table.accountId, table.occurredAt),
    index("security_event_name_idx").on(table.eventName, table.occurredAt),
    ...integrityChecks("security_event"),
    check(
      "security_event_code_check",
      sql.raw(`risk_code IS NULL OR risk_code ~ '^[A-Z][A-Z0-9_]{0,63}$'`),
    ),
    check(
      "security_event_retention_check",
      sql.raw(`retention_class_code = 'SECURITY_STANDARD_UNSET'`),
    ),
  ],
);

/**
 * Locked per-partition chain head. Technical state only: the runtime role
 * has no privilege on it and reaches it solely through the reviewed
 * SECURITY DEFINER functions; a trigger allows only +1 advances.
 */
export const chainHead = auditSchema.table(
  "chain_head",
  {
    chainPartition: varchar("chain_partition", { length: 48 }).primaryKey(),
    lastSequence: bigint("last_sequence", { mode: "number" }).notNull(),
    lastHash: bytea("last_hash").notNull(),
    updatedAt: timestamp("updated_at", ms).notNull(),
  },
  () => [
    check("chain_head_sequence_check", sql.raw(`last_sequence >= 0`)),
    check("chain_head_hash_check", sql.raw(`octet_length(last_hash) = 32`)),
    check(
      "chain_head_partition_check",
      sql.raw(
        `chain_partition ~ '^((IDENTITY|SECURITY):[0-9a-f]{2}|ORG:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$'`,
      ),
    ),
  ],
);

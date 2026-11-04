import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { appSchema } from "../../../shared/database/schema/app";
import { user } from "../../identity-access/infrastructure/auth-schema";
import { hiringCycle } from "../../organization/infrastructure/organization-schema";

// Person, candidacy, stage history, duplicate match, merge record, and
// command receipts (packet M2.2 §7–§15, §21–§22; DATA_MODEL §6).
//
// - person is the canonical human; candidate_account_id is the one-to-one
//   ownership link (unique; a trigger requires a verified CANDIDATE).
// - candidacy is one person pursuing one hiring cycle; its organization,
//   position, branch, and team are copied from the cycle and kept
//   coherent by a composite foreign key plus a team trigger. At most one
//   ACTIVE candidacy exists per person and hiring cycle.
// - History, merge records, and receipts are append-only; no table is
//   ever deleted from, and no foreign key cascades.

const tz = { withTimezone: true } as const;

const timestamps = {
  createdAt: timestamp("created_at", tz).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", tz)
    .defaultNow()
    .$onUpdate(() => new Date())
    .notNull(),
};

const bounded = (column: unknown, max: number) =>
  sql`char_length(${column}) BETWEEN 1 AND ${sql.raw(String(max))}`;
const optionalBounded = (column: unknown, max: number) =>
  sql`${column} IS NULL OR char_length(${column}) BETWEEN 1 AND ${sql.raw(String(max))}`;
const codeList = (column: unknown) =>
  sql`cardinality(${column}) BETWEEN 1 AND 8 AND array_position(${column}, NULL) IS NULL`;

export const person = appSchema.table(
  "person",
  {
    id: uuid("id")
      .default(sql`pg_catalog.gen_random_uuid()`)
      .primaryKey(),
    legalFirstName: varchar("legal_first_name", { length: 100 }).notNull(),
    legalMiddleName: varchar("legal_middle_name", { length: 100 }),
    legalLastName: varchar("legal_last_name", { length: 100 }).notNull(),
    preferredName: varchar("preferred_name", { length: 100 }),
    emailDisplay: varchar("email_display", { length: 254 }).notNull(),
    emailNormalized: varchar("email_normalized", { length: 254 }).notNull(),
    phoneDisplay: varchar("phone_display", { length: 40 }),
    phoneE164: varchar("phone_e164", { length: 16 }),
    normalizationVersion: varchar("normalization_version", {
      length: 16,
    }).notNull(),
    candidateAccountId: uuid("candidate_account_id"),
    status: varchar("status", { length: 16 }).default("ACTIVE").notNull(),
    mergedIntoPersonId: uuid("merged_into_person_id"),
    mergedAt: timestamp("merged_at", tz),
    version: integer("version").default(1).notNull(),
    createdByAccountId: uuid("created_by_account_id").notNull(),
    updatedByAccountId: uuid("updated_by_account_id").notNull(),
    ...timestamps,
  },
  (table) => [
    // One person per candidate account (and, by the column, one account
    // per person).
    uniqueIndex("person_candidate_account_unique")
      .on(table.candidateAccountId)
      .where(sql`${table.candidateAccountId} IS NOT NULL`),
    foreignKey({
      name: "person_candidate_account_fk",
      columns: [table.candidateAccountId],
      foreignColumns: [user.id],
    }),
    foreignKey({
      name: "person_merged_into_fk",
      columns: [table.mergedIntoPersonId],
      foreignColumns: [table.id],
    }),
    foreignKey({
      name: "person_created_by_fk",
      columns: [table.createdByAccountId],
      foreignColumns: [user.id],
    }),
    foreignKey({
      name: "person_updated_by_fk",
      columns: [table.updatedByAccountId],
      foreignColumns: [user.id],
    }),
    check("person_first_name_check", bounded(table.legalFirstName, 100)),
    check(
      "person_middle_name_check",
      optionalBounded(table.legalMiddleName, 100),
    ),
    check("person_last_name_check", bounded(table.legalLastName, 100)),
    check(
      "person_preferred_name_check",
      optionalBounded(table.preferredName, 100),
    ),
    check(
      "person_email_check",
      sql`${bounded(table.emailDisplay, 254)} AND ${table.emailNormalized} = lower(${table.emailNormalized}) AND ${table.emailNormalized} LIKE '%_@_%'`,
    ),
    check(
      "person_phone_check",
      sql`(${table.phoneE164} IS NULL OR ${table.phoneE164} ~ '^\\+[1-9][0-9]{7,14}$') AND (${table.phoneE164} IS NULL OR ${table.phoneDisplay} IS NOT NULL)`,
    ),
    check(
      "person_normalization_check",
      sql`${table.normalizationVersion} ~ '^NORM-[0-9]{1,3}$'`,
    ),
    check(
      "person_status_check",
      sql`${table.status} IN ('ACTIVE', 'MERGED', 'ARCHIVED')`,
    ),
    check(
      "person_merge_check",
      sql`((${table.status} = 'MERGED') = (${table.mergedIntoPersonId} IS NOT NULL)) AND ((${table.mergedIntoPersonId} IS NULL) = (${table.mergedAt} IS NULL)) AND (${table.mergedIntoPersonId} IS NULL OR ${table.mergedIntoPersonId} <> ${table.id}) AND (${table.status} <> 'MERGED' OR ${table.candidateAccountId} IS NULL)`,
    ),
    check("person_version_check", sql`${table.version} >= 1`),
    // Exact authorized lookups only; no trigram or full-text indexes.
    index("person_email_idx").on(table.emailNormalized),
    index("person_phone_idx")
      .on(table.phoneE164)
      .where(sql`${table.phoneE164} IS NOT NULL`),
  ],
);

export const candidacy = appSchema.table(
  "candidacy",
  {
    id: uuid("id")
      .default(sql`pg_catalog.gen_random_uuid()`)
      .primaryKey(),
    publicId: varchar("public_id", { length: 12 }).notNull(),
    candidateReference: varchar("candidate_reference", {
      length: 10,
    }).notNull(),
    personId: uuid("person_id").notNull(),
    hiringCycleId: uuid("hiring_cycle_id").notNull(),
    organizationId: uuid("organization_id").notNull(),
    positionId: uuid("position_id").notNull(),
    branchId: uuid("branch_id").notNull(),
    teamId: uuid("team_id"),
    sourceCode: varchar("source_code", { length: 32 }).notNull(),
    currentStage: varchar("current_stage", { length: 32 }).notNull(),
    status: varchar("status", { length: 16 }).default("ACTIVE").notNull(),
    candidateVisibleStatus: varchar("candidate_visible_status", {
      length: 32,
    }).notNull(),
    ownerAccountId: uuid("owner_account_id"),
    proposedWorkerPath: varchar("proposed_worker_path", { length: 16 })
      .default("UNDECIDED")
      .notNull(),
    startedAt: timestamp("started_at", tz),
    closedAt: timestamp("closed_at", tz),
    closureReasonCode: varchar("closure_reason_code", { length: 64 }),
    version: integer("version").default(1).notNull(),
    createdByAccountId: uuid("created_by_account_id").notNull(),
    updatedByAccountId: uuid("updated_by_account_id").notNull(),
    ...timestamps,
  },
  (table) => [
    unique("candidacy_public_id_unique").on(table.publicId),
    unique("candidacy_reference_unique").on(table.candidateReference),
    // At most one current (ACTIVE) candidacy per person and hiring cycle.
    uniqueIndex("candidacy_current_unique")
      .on(table.personId, table.hiringCycleId)
      .where(sql`${table.status} = 'ACTIVE'`),
    foreignKey({
      name: "candidacy_person_fk",
      columns: [table.personId],
      foreignColumns: [person.id],
    }),
    foreignKey({
      name: "candidacy_hiring_cycle_fk",
      columns: [
        table.hiringCycleId,
        table.organizationId,
        table.positionId,
        table.branchId,
      ],
      foreignColumns: [
        hiringCycle.id,
        hiringCycle.organizationId,
        hiringCycle.positionId,
        hiringCycle.branchId,
      ],
    }),
    foreignKey({
      name: "candidacy_owner_fk",
      columns: [table.ownerAccountId],
      foreignColumns: [user.id],
    }),
    foreignKey({
      name: "candidacy_created_by_fk",
      columns: [table.createdByAccountId],
      foreignColumns: [user.id],
    }),
    foreignKey({
      name: "candidacy_updated_by_fk",
      columns: [table.updatedByAccountId],
      foreignColumns: [user.id],
    }),
    check(
      "candidacy_public_id_check",
      sql`${table.publicId} ~ '^[0-9a-hjkmnp-tv-z]{12}$'`,
    ),
    check(
      "candidacy_reference_check",
      sql`${table.candidateReference} ~ '^C-[0-9A-HJKMNP-TV-Z]{8}$'`,
    ),
    check(
      "candidacy_source_check",
      sql`${table.sourceCode} IN ('CANDIDATE_SELF_SERVICE', 'STAFF_ENTERED')`,
    ),
    check(
      "candidacy_stage_check",
      sql`${table.currentStage} IN ('PROSPECT', 'APPLICATION_INCOMPLETE', 'APPLICATION_SUBMITTED')`,
    ),
    check(
      "candidacy_status_check",
      sql`${table.status} IN ('ACTIVE', 'TERMINAL', 'ARCHIVED')`,
    ),
    check(
      "candidacy_visible_status_check",
      sql`${table.candidateVisibleStatus} = CASE WHEN ${table.status} <> 'ACTIVE' THEN 'CLOSED' WHEN ${table.currentStage} = 'APPLICATION_INCOMPLETE' THEN 'APPLICATION_STARTED' WHEN ${table.currentStage} = 'APPLICATION_SUBMITTED' THEN 'APPLICATION_SUBMITTED' ELSE 'NOT_STARTED' END`,
    ),
    check(
      "candidacy_worker_path_check",
      sql`${table.proposedWorkerPath} IN ('UNDECIDED', 'W2', 'CONTRACTOR')`,
    ),
    check(
      "candidacy_lifecycle_check",
      sql`((${table.currentStage} <> 'PROSPECT') = (${table.startedAt} IS NOT NULL)) AND ((${table.status} = 'TERMINAL') = (${table.closedAt} IS NOT NULL)) AND ((${table.closedAt} IS NULL) = (${table.closureReasonCode} IS NULL)) AND (${table.closureReasonCode} IS NULL OR ${table.closureReasonCode} ~ '^[A-Z][A-Z0-9_]{1,63}$')`,
    ),
    check("candidacy_version_check", sql`${table.version} >= 1`),
    index("candidacy_scope_idx").on(
      table.organizationId,
      table.branchId,
      table.teamId,
      table.currentStage,
      table.status,
    ),
    index("candidacy_person_idx").on(table.personId, table.status),
    index("candidacy_owner_idx")
      .on(table.ownerAccountId, table.currentStage)
      .where(sql`${table.ownerAccountId} IS NOT NULL`),
    // M3.1 work-queue paging over active records only.
    index("candidacy_work_queue_idx")
      .on(table.createdAt, table.publicId)
      .where(sql`${table.status} = 'ACTIVE'`),
  ],
);

export const candidacyStageHistory = appSchema.table(
  "candidacy_stage_history",
  {
    id: uuid("id")
      .default(sql`pg_catalog.gen_random_uuid()`)
      .primaryKey(),
    candidacyId: uuid("candidacy_id").notNull(),
    fromStage: varchar("from_stage", { length: 32 }),
    toStage: varchar("to_stage", { length: 32 }).notNull(),
    fromStatus: varchar("from_status", { length: 16 }),
    toStatus: varchar("to_status", { length: 16 }).notNull(),
    commandCode: varchar("command_code", { length: 64 }).notNull(),
    actorAccountId: uuid("actor_account_id"),
    systemActor: varchar("system_actor", { length: 32 }),
    reasonCode: varchar("reason_code", { length: 64 }),
    versionBefore: integer("version_before"),
    versionAfter: integer("version_after").notNull(),
    correlationId: uuid("correlation_id"),
    occurredAt: timestamp("occurred_at", tz).notNull(),
  },
  (table) => [
    foreignKey({
      name: "candidacy_stage_history_candidacy_fk",
      columns: [table.candidacyId],
      foreignColumns: [candidacy.id],
    }),
    foreignKey({
      name: "candidacy_stage_history_actor_fk",
      columns: [table.actorAccountId],
      foreignColumns: [user.id],
    }),
    check(
      "candidacy_stage_history_actor_check",
      sql`(${table.actorAccountId} IS NULL) <> (${table.systemActor} IS NULL)`,
    ),
    check(
      "candidacy_stage_history_command_check",
      sql`${table.commandCode} IN ('create_prospect', 'start_application', 'start_application_from_prospect', 'close_prospect', 'submit_application', 'return_application')`,
    ),
    check(
      "candidacy_stage_history_version_check",
      sql`${table.versionAfter} >= 1 AND (${table.versionBefore} IS NULL OR ${table.versionAfter} = ${table.versionBefore} + 1)`,
    ),
    index("candidacy_stage_history_candidacy_idx").on(
      table.candidacyId,
      table.occurredAt,
    ),
  ],
);

export const duplicateCandidateMatch = appSchema.table(
  "duplicate_candidate_match",
  {
    id: uuid("id")
      .default(sql`pg_catalog.gen_random_uuid()`)
      .primaryKey(),
    publicId: varchar("public_id", { length: 12 }).notNull(),
    organizationId: uuid("organization_id").notNull(),
    personAId: uuid("person_a_id").notNull(),
    personBId: uuid("person_b_id").notNull(),
    rulesetVersion: varchar("ruleset_version", { length: 16 }).notNull(),
    signalCodes: text("signal_codes").array().notNull(),
    confidenceTier: varchar("confidence_tier", { length: 8 }).notNull(),
    status: varchar("status", { length: 24 }).default("PENDING").notNull(),
    reviewedByAccountId: uuid("reviewed_by_account_id"),
    reviewedAt: timestamp("reviewed_at", tz),
    reasonCode: varchar("reason_code", { length: 64 }),
    mergeRecordId: uuid("merge_record_id"),
    version: integer("version").default(1).notNull(),
    ...timestamps,
  },
  (table) => [
    unique("duplicate_candidate_match_public_id_unique").on(table.publicId),
    // One unresolved case per canonical pair and ruleset.
    uniqueIndex("duplicate_candidate_match_open_unique")
      .on(table.personAId, table.personBId, table.rulesetVersion)
      .where(sql`${table.status} IN ('PENDING', 'CONFIRMED_DUPLICATE')`),
    foreignKey({
      name: "duplicate_candidate_match_a_fk",
      columns: [table.personAId],
      foreignColumns: [person.id],
    }),
    foreignKey({
      name: "duplicate_candidate_match_b_fk",
      columns: [table.personBId],
      foreignColumns: [person.id],
    }),
    foreignKey({
      name: "duplicate_candidate_match_reviewer_fk",
      columns: [table.reviewedByAccountId],
      foreignColumns: [user.id],
    }),
    check(
      "duplicate_candidate_match_public_id_check",
      sql`${table.publicId} ~ '^[0-9a-hjkmnp-tv-z]{12}$'`,
    ),
    check(
      "duplicate_candidate_match_pair_check",
      sql`${table.personAId} < ${table.personBId}`,
    ),
    check(
      "duplicate_candidate_match_ruleset_check",
      sql`${table.rulesetVersion} ~ '^DUP-[0-9]{1,3}$'`,
    ),
    check(
      "duplicate_candidate_match_signals_check",
      sql`${codeList(table.signalCodes)} AND ${table.signalCodes} <@ ARRAY['EXACT_EMAIL', 'EXACT_PHONE']::text[]`,
    ),
    check(
      "duplicate_candidate_match_tier_check",
      sql`${table.confidenceTier} IN ('HIGH', 'MEDIUM')`,
    ),
    check(
      "duplicate_candidate_match_status_check",
      sql`${table.status} IN ('PENDING', 'CONFIRMED_DUPLICATE', 'NOT_DUPLICATE', 'MERGED')`,
    ),
    check(
      "duplicate_candidate_match_review_check",
      sql`((${table.status} = 'PENDING') = (${table.reviewedAt} IS NULL)) AND ((${table.reviewedAt} IS NULL) = (${table.reviewedByAccountId} IS NULL)) AND ((${table.reviewedAt} IS NULL) = (${table.reasonCode} IS NULL)) AND ((${table.status} = 'MERGED') = (${table.mergeRecordId} IS NOT NULL))`,
    ),
    check(
      "duplicate_candidate_match_version_check",
      sql`${table.version} >= 1`,
    ),
    index("duplicate_candidate_match_review_idx")
      .on(table.organizationId, table.status, table.createdAt)
      .where(sql`${table.status} IN ('PENDING', 'CONFIRMED_DUPLICATE')`),
  ],
);

export const personMergeRecord = appSchema.table(
  "person_merge_record",
  {
    id: uuid("id")
      .default(sql`pg_catalog.gen_random_uuid()`)
      .primaryKey(),
    survivingPersonId: uuid("surviving_person_id").notNull(),
    mergedPersonId: uuid("merged_person_id").notNull(),
    matchId: uuid("match_id").notNull(),
    fieldResolutionCodes: text("field_resolution_codes").array().notNull(),
    reasonCode: varchar("reason_code", { length: 64 }).notNull(),
    executedByAccountId: uuid("executed_by_account_id").notNull(),
    occurredAt: timestamp("occurred_at", tz).notNull(),
  },
  (table) => [
    // A person is merged at most once.
    unique("person_merge_record_merged_unique").on(table.mergedPersonId),
    foreignKey({
      name: "person_merge_record_survivor_fk",
      columns: [table.survivingPersonId],
      foreignColumns: [person.id],
    }),
    foreignKey({
      name: "person_merge_record_merged_fk",
      columns: [table.mergedPersonId],
      foreignColumns: [person.id],
    }),
    foreignKey({
      name: "person_merge_record_match_fk",
      columns: [table.matchId],
      foreignColumns: [duplicateCandidateMatch.id],
    }),
    foreignKey({
      name: "person_merge_record_actor_fk",
      columns: [table.executedByAccountId],
      foreignColumns: [user.id],
    }),
    check(
      "person_merge_record_distinct_check",
      sql`${table.survivingPersonId} <> ${table.mergedPersonId}`,
    ),
    check(
      "person_merge_record_codes_check",
      sql`cardinality(${table.fieldResolutionCodes}) BETWEEN 1 AND 12 AND array_position(${table.fieldResolutionCodes}, NULL) IS NULL`,
    ),
    check(
      "person_merge_record_reason_check",
      sql`${table.reasonCode} ~ '^[A-Z][A-Z0-9_]{1,63}$'`,
    ),
  ],
);

/** One row per accepted candidate-module command key (idempotency). */
export const candidateCommandReceipt = appSchema.table(
  "candidate_command_receipt",
  {
    id: uuid("id")
      .default(sql`pg_catalog.gen_random_uuid()`)
      .primaryKey(),
    actorAccountId: uuid("actor_account_id").notNull(),
    commandKey: uuid("command_key").notNull(),
    commandName: varchar("command_name", { length: 64 }).notNull(),
    requestFingerprint: varchar("request_fingerprint", {
      length: 64,
    }).notNull(),
    targetId: uuid("target_id").notNull(),
    resultVersion: integer("result_version").notNull(),
    outcomeCode: varchar("outcome_code", { length: 32 }).notNull(),
    createdAt: timestamp("created_at", tz).defaultNow().notNull(),
  },
  (table) => [
    unique("candidate_command_receipt_key_unique").on(
      table.actorAccountId,
      table.commandKey,
    ),
    foreignKey({
      name: "candidate_command_receipt_actor_fk",
      columns: [table.actorAccountId],
      foreignColumns: [user.id],
    }),
    check(
      "candidate_command_receipt_name_check",
      sql`${table.commandName} ~ '^[a-z][a-z_]{1,63}$'`,
    ),
    check(
      "candidate_command_receipt_fingerprint_check",
      sql`${table.requestFingerprint} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "candidate_command_receipt_outcome_check",
      sql`${table.outcomeCode} ~ '^[A-Z][A-Z_]{1,31}$'`,
    ),
  ],
);

// A candidate or staff task (packet M2.3 §10; DATA_MODEL §17.1). It only
// coordinates action and never decides candidacy state. It stores no text or
// URL: wording and routes come from the code-owned work-type registry.
// Candidate ownership comes from candidacy -> person -> account.
export const workItem = appSchema.table(
  "work_item",
  {
    id: uuid("id")
      .default(sql`pg_catalog.gen_random_uuid()`)
      .primaryKey(),
    candidacyId: uuid("candidacy_id").notNull(),
    workTypeCode: varchar("work_type_code", { length: 64 }).notNull(),
    targetRecordType: varchar("target_record_type", { length: 32 }).notNull(),
    targetRecordId: uuid("target_record_id").notNull(),
    candidateActionRequired: boolean("candidate_action_required").notNull(),
    status: varchar("status", { length: 16 }).default("OPEN").notNull(),
    priority: varchar("priority", { length: 16 }).default("NORMAL").notNull(),
    dueAt: timestamp("due_at", tz),
    completedAt: timestamp("completed_at", tz),
    sourceCode: varchar("source_code", { length: 32 }).notNull(),
    version: integer("version").default(1).notNull(),
    ...timestamps,
  },
  (table) => [
    foreignKey({
      name: "work_item_candidacy_fk",
      columns: [table.candidacyId],
      foreignColumns: [candidacy.id],
    }),
    unique("work_item_id_candidacy_unique").on(table.id, table.candidacyId),
    uniqueIndex("work_item_active_unique")
      .on(
        table.candidacyId,
        table.workTypeCode,
        table.targetRecordType,
        table.targetRecordId,
      )
      .where(sql`${table.status} IN ('OPEN', 'IN_PROGRESS', 'BLOCKED')`),
    index("work_item_candidate_task_idx").on(
      table.candidacyId,
      table.candidateActionRequired,
      table.status,
      table.dueAt,
      table.priority,
      table.createdAt,
      table.id,
    ),
    index("work_item_source_idx").on(table.sourceCode, table.workTypeCode),
    // M3.1: open staff work, by candidacy and due date.
    index("work_item_staff_queue_idx")
      .on(table.candidacyId, table.dueAt)
      .where(
        sql`${table.candidateActionRequired} = false AND ${table.status} IN ('OPEN', 'IN_PROGRESS', 'BLOCKED')`,
      ),
    check(
      "work_item_type_check",
      sql`${table.workTypeCode} IN ('COMPLETE_APPLICATION', 'CORRECT_APPLICATION', 'REVIEW_SUBMITTED_APPLICATION')`,
    ),
    check(
      "work_item_target_check",
      sql`${table.targetRecordType} = 'CANDIDACY' AND ${table.targetRecordId} = ${table.candidacyId} AND ${table.candidateActionRequired} = (${table.workTypeCode} IN ('COMPLETE_APPLICATION', 'CORRECT_APPLICATION'))`,
    ),
    check(
      "work_item_status_check",
      sql`${table.status} IN ('OPEN', 'IN_PROGRESS', 'BLOCKED', 'COMPLETED', 'CANCELED')`,
    ),
    check(
      "work_item_priority_check",
      sql`${table.priority} IN ('NORMAL', 'HIGH')`,
    ),
    check(
      "work_item_completed_check",
      sql`(${table.status} = 'COMPLETED') = (${table.completedAt} IS NOT NULL)`,
    ),
    check(
      "work_item_source_check",
      sql`${table.sourceCode} IN ('CANDIDACY_TRANSITION', 'BACKFILL', 'RECONCILIATION')`,
    ),
    check("work_item_version_check", sql`${table.version} >= 1`),
    // Due dates belong to staff work; a candidate task never carries one.
    check(
      "work_item_due_staff_check",
      sql`${table.dueAt} IS NULL OR ${table.candidateActionRequired} = false`,
    ),
  ],
);

// Who became responsible, and which due date applied, over time (packet M3.1
// §6). Append-only: a change adds a row, and the runtime role can't alter one.
export const workResponsibilityHistory = appSchema.table(
  "work_responsibility_history",
  {
    id: uuid("id")
      .default(sql`pg_catalog.gen_random_uuid()`)
      .primaryKey(),
    candidacyId: uuid("candidacy_id").notNull(),
    workItemId: uuid("work_item_id"),
    changeCode: varchar("change_code", { length: 32 }).notNull(),
    previousOwnerAccountId: uuid("previous_owner_account_id"),
    newOwnerAccountId: uuid("new_owner_account_id"),
    previousDueAt: timestamp("previous_due_at", tz),
    newDueAt: timestamp("new_due_at", tz),
    reasonCode: varchar("reason_code", { length: 64 }),
    actorAccountId: uuid("actor_account_id").notNull(),
    occurredAt: timestamp("occurred_at", tz).notNull(),
  },
  (table) => [
    foreignKey({
      name: "work_responsibility_history_candidacy_fk",
      columns: [table.candidacyId],
      foreignColumns: [candidacy.id],
    }),
    foreignKey({
      name: "work_responsibility_history_item_fk",
      columns: [table.workItemId, table.candidacyId],
      foreignColumns: [workItem.id, workItem.candidacyId],
    }),
    foreignKey({
      name: "work_responsibility_history_previous_owner_fk",
      columns: [table.previousOwnerAccountId],
      foreignColumns: [user.id],
    }),
    foreignKey({
      name: "work_responsibility_history_new_owner_fk",
      columns: [table.newOwnerAccountId],
      foreignColumns: [user.id],
    }),
    foreignKey({
      name: "work_responsibility_history_actor_fk",
      columns: [table.actorAccountId],
      foreignColumns: [user.id],
    }),
    check(
      "work_responsibility_history_change_check",
      sql`CASE ${table.changeCode}
        WHEN 'OWNER_ASSIGNED' THEN ${table.workItemId} IS NULL AND ${table.previousOwnerAccountId} IS NULL AND ${table.newOwnerAccountId} IS NOT NULL AND ${table.newDueAt} IS NULL AND ${table.previousDueAt} IS NULL
        WHEN 'OWNER_REASSIGNED' THEN ${table.workItemId} IS NULL AND ${table.previousOwnerAccountId} IS NOT NULL AND ${table.newOwnerAccountId} IS NOT NULL AND ${table.previousOwnerAccountId} <> ${table.newOwnerAccountId} AND ${table.newDueAt} IS NULL AND ${table.previousDueAt} IS NULL
        WHEN 'OWNER_RELEASED' THEN ${table.workItemId} IS NULL AND ${table.previousOwnerAccountId} IS NOT NULL AND ${table.newOwnerAccountId} IS NULL AND ${table.newDueAt} IS NULL AND ${table.previousDueAt} IS NULL
        WHEN 'DUE_DATE_SET' THEN ${table.workItemId} IS NOT NULL AND ${table.previousOwnerAccountId} IS NULL AND ${table.newOwnerAccountId} IS NULL AND ${table.newDueAt} IS NOT NULL AND ${table.previousDueAt} IS DISTINCT FROM ${table.newDueAt}
        WHEN 'DUE_DATE_CLEARED' THEN ${table.workItemId} IS NOT NULL AND ${table.previousOwnerAccountId} IS NULL AND ${table.newOwnerAccountId} IS NULL AND ${table.newDueAt} IS NULL AND ${table.previousDueAt} IS NOT NULL
        ELSE false END`,
    ),
    check(
      "work_responsibility_history_reason_check",
      sql`${table.reasonCode} IS NULL OR ${table.reasonCode} ~ '^[A-Z][A-Z0-9_]{1,63}$'`,
    ),
    index("work_responsibility_history_candidacy_idx").on(
      table.candidacyId,
      table.occurredAt,
    ),
  ],
);

import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  primaryKey,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { appSchema } from "../../../shared/database/schema/app";
import { candidacy } from "../../candidates/infrastructure/candidates-schema";
import { documentVersion } from "../../documents/infrastructure/documents-schema";
import { user } from "../../identity-access/infrastructure/auth-schema";

// Application templates and drafts (packet M2.4; DATA_MODEL §7).
//
// - A published template version is immutable, and a draft stays pinned to
//   the version it started on.
// - One candidacy has at most one DRAFT application version. RETURNED and
//   SUPERSEDED arrive with M2.7.
// - Answers are stored per section, so two sections never conflict; each
//   section row carries its own optimistic version.
// - Nothing is ever deleted, and no foreign key cascades.

const tz = { withTimezone: true } as const;

export const applicationTemplate = appSchema.table(
  "application_template",
  {
    id: uuid("id")
      .default(sql`pg_catalog.gen_random_uuid()`)
      .primaryKey(),
    code: varchar("code", { length: 64 }).notNull(),
    name: varchar("name", { length: 200 }).notNull(),
    createdAt: timestamp("created_at", tz).defaultNow().notNull(),
  },
  (table) => [
    unique("application_template_code_unique").on(table.code),
    check(
      "application_template_code_check",
      sql`${table.code} ~ '^[A-Z][A-Z0-9_]{1,63}$'`,
    ),
  ],
);

export const applicationTemplateVersion = appSchema.table(
  "application_template_version",
  {
    id: uuid("id")
      .default(sql`pg_catalog.gen_random_uuid()`)
      .primaryKey(),
    applicationTemplateId: uuid("application_template_id").notNull(),
    versionNumber: integer("version_number").notNull(),
    schemaJson: jsonb("schema_json").notNull(),
    publishedAt: timestamp("published_at", tz).notNull(),
    effectiveFrom: timestamp("effective_from", tz).notNull(),
    effectiveTo: timestamp("effective_to", tz),
    createdAt: timestamp("created_at", tz).defaultNow().notNull(),
  },
  (table) => [
    unique("application_template_version_number_unique").on(
      table.applicationTemplateId,
      table.versionNumber,
    ),
    foreignKey({
      name: "application_template_version_template_fk",
      columns: [table.applicationTemplateId],
      foreignColumns: [applicationTemplate.id],
    }),
    check(
      "application_template_version_number_check",
      sql`${table.versionNumber} >= 1`,
    ),
    check(
      "application_template_version_schema_check",
      sql`jsonb_typeof(${table.schemaJson}) = 'object'`,
    ),
    check(
      "application_template_version_window_check",
      sql`${table.effectiveTo} IS NULL OR ${table.effectiveTo} > ${table.effectiveFrom}`,
    ),
  ],
);

export const applicationVersion = appSchema.table(
  "application_version",
  {
    id: uuid("id")
      .default(sql`pg_catalog.gen_random_uuid()`)
      .primaryKey(),
    candidacyId: uuid("candidacy_id").notNull(),
    templateVersionId: uuid("template_version_id").notNull(),
    versionNumber: integer("version_number").notNull(),
    status: varchar("status", { length: 16 }).notNull(),
    createdByAccountId: uuid("created_by_account_id").notNull(),
    createdAt: timestamp("created_at", tz).notNull(),
  },
  (table) => [
    unique("application_version_number_unique").on(
      table.candidacyId,
      table.versionNumber,
    ),
    uniqueIndex("application_version_one_draft_unique")
      .on(table.candidacyId)
      .where(sql`${table.status} = 'DRAFT'`),
    foreignKey({
      name: "application_version_candidacy_fk",
      columns: [table.candidacyId],
      foreignColumns: [candidacy.id],
    }),
    foreignKey({
      name: "application_version_template_fk",
      columns: [table.templateVersionId],
      foreignColumns: [applicationTemplateVersion.id],
    }),
    foreignKey({
      name: "application_version_created_by_fk",
      columns: [table.createdByAccountId],
      foreignColumns: [user.id],
    }),
    check("application_version_number_check", sql`${table.versionNumber} >= 1`),
    check(
      "application_version_status_check",
      sql`${table.status} IN ('DRAFT', 'SUBMITTED')`,
    ),
    index("application_version_template_idx").on(table.templateVersionId),
  ],
);

export const applicationDraftSection = appSchema.table(
  "application_draft_section",
  {
    id: uuid("id")
      .default(sql`pg_catalog.gen_random_uuid()`)
      .primaryKey(),
    applicationVersionId: uuid("application_version_id").notNull(),
    sectionCode: varchar("section_code", { length: 40 }).notNull(),
    answers: jsonb("answers").notNull(),
    completionStatus: varchar("completion_status", { length: 16 }).notNull(),
    version: integer("version").notNull(),
    savedByAccountId: uuid("saved_by_account_id").notNull(),
    savedByKind: varchar("saved_by_kind", { length: 16 }).notNull(),
    assistReasonCode: varchar("assist_reason_code", { length: 64 }),
    savedAt: timestamp("saved_at", tz).notNull(),
    createdAt: timestamp("created_at", tz).notNull(),
  },
  (table) => [
    unique("application_draft_section_unique").on(
      table.applicationVersionId,
      table.sectionCode,
    ),
    foreignKey({
      name: "application_draft_section_version_fk",
      columns: [table.applicationVersionId],
      foreignColumns: [applicationVersion.id],
    }),
    foreignKey({
      name: "application_draft_section_saved_by_fk",
      columns: [table.savedByAccountId],
      foreignColumns: [user.id],
    }),
    check(
      "application_draft_section_code_check",
      sql`${table.sectionCode} ~ '^[a-z][a-z_]{1,39}$'`,
    ),
    check(
      "application_draft_section_answers_check",
      sql`jsonb_typeof(${table.answers}) = 'object' AND pg_column_size(${table.answers}) <= 65536`,
    ),
    check(
      "application_draft_section_completion_check",
      sql`${table.completionStatus} IN ('IN_PROGRESS', 'COMPLETE')`,
    ),
    check(
      "application_draft_section_version_check",
      sql`${table.version} >= 1`,
    ),
    check(
      "application_draft_section_assist_check",
      sql`(${table.savedByKind} = 'CANDIDATE' AND ${table.assistReasonCode} IS NULL) OR (${table.savedByKind} = 'STAFF_ASSIST' AND ${table.assistReasonCode} IS NOT NULL)`,
    ),
  ],
);

// M2.6. The certification statement a candidate accepts. Versions are
// immutable; `review_status` records whether counsel has approved the wording.
export const applicationCertificationVersion = appSchema.table(
  "application_certification_version",
  {
    id: uuid("id")
      .default(sql`pg_catalog.gen_random_uuid()`)
      .primaryKey(),
    versionNumber: integer("version_number").notNull(),
    statement: varchar("statement", { length: 2000 }).notNull(),
    reviewStatus: varchar("review_status", { length: 32 }).notNull(),
    effectiveFrom: timestamp("effective_from", tz).notNull(),
    createdAt: timestamp("created_at", tz).defaultNow().notNull(),
  },
  (table) => [
    unique("application_certification_version_number_unique").on(
      table.versionNumber,
    ),
    check(
      "application_certification_version_number_check",
      sql`${table.versionNumber} >= 1`,
    ),
    check(
      "application_certification_review_check",
      sql`${table.reviewStatus} IN ('DRAFT_UNREVIEWED', 'APPROVED')`,
    ),
  ],
);

// The frozen record of one submission: everything needed to show later exactly
// what was submitted and certified. Append-only.
export const applicationSubmission = appSchema.table(
  "application_submission",
  {
    id: uuid("id")
      .default(sql`pg_catalog.gen_random_uuid()`)
      .primaryKey(),
    applicationVersionId: uuid("application_version_id").notNull(),
    candidacyId: uuid("candidacy_id").notNull(),
    templateVersionId: uuid("template_version_id").notNull(),
    certificationVersionId: uuid("certification_version_id").notNull(),
    answers: jsonb("answers").notNull(),
    contentHash: varchar("content_hash", { length: 64 }).notNull(),
    certifiedName: varchar("certified_name", { length: 200 }).notNull(),
    receiptNumber: varchar("receipt_number", { length: 10 }).notNull(),
    submittedByAccountId: uuid("submitted_by_account_id").notNull(),
    submittedAt: timestamp("submitted_at", tz).notNull(),
  },
  (table) => [
    unique("application_submission_version_unique").on(
      table.applicationVersionId,
    ),
    unique("application_submission_receipt_unique").on(table.receiptNumber),
    foreignKey({
      name: "application_submission_version_fk",
      columns: [table.applicationVersionId],
      foreignColumns: [applicationVersion.id],
    }),
    foreignKey({
      name: "application_submission_candidacy_fk",
      columns: [table.candidacyId],
      foreignColumns: [candidacy.id],
    }),
    foreignKey({
      name: "application_submission_template_fk",
      columns: [table.templateVersionId],
      foreignColumns: [applicationTemplateVersion.id],
    }),
    foreignKey({
      name: "application_submission_certification_fk",
      columns: [table.certificationVersionId],
      foreignColumns: [applicationCertificationVersion.id],
    }),
    foreignKey({
      name: "application_submission_actor_fk",
      columns: [table.submittedByAccountId],
      foreignColumns: [user.id],
    }),
    index("application_submission_candidacy_idx").on(table.candidacyId),
    check(
      "application_submission_answers_check",
      sql`jsonb_typeof(${table.answers}) = 'object'`,
    ),
    check(
      "application_submission_hash_check",
      sql`${table.contentHash} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "application_submission_receipt_check",
      sql`${table.receiptNumber} ~ '^R-[0-9A-HJKMNP-TV-Z]{8}$'`,
    ),
    check(
      "application_submission_name_check",
      sql`char_length(${table.certifiedName}) BETWEEN 1 AND 200`,
    ),
  ],
);

/** Exactly which attachment versions a submission froze. Append-only. */
export const applicationSubmissionAttachment = appSchema.table(
  "application_submission_attachment",
  {
    submissionId: uuid("submission_id").notNull(),
    documentVersionId: uuid("document_version_id").notNull(),
  },
  (table) => [
    primaryKey({
      name: "application_submission_attachment_pk",
      columns: [table.submissionId, table.documentVersionId],
    }),
    foreignKey({
      name: "application_submission_attachment_submission_fk",
      columns: [table.submissionId],
      foreignColumns: [applicationSubmission.id],
    }),
    foreignKey({
      name: "application_submission_attachment_version_fk",
      columns: [table.documentVersionId],
      foreignColumns: [documentVersion.id],
    }),
  ],
);

// Reliable delivery after commit (DATA_MODEL §19.3). The row commits with the
// business change; it holds no address or name, which are read when sending.
export const outboxEvent = appSchema.table(
  "outbox_event",
  {
    id: uuid("id")
      .default(sql`pg_catalog.gen_random_uuid()`)
      .primaryKey(),
    aggregateType: varchar("aggregate_type", { length: 32 }).notNull(),
    aggregateId: uuid("aggregate_id").notNull(),
    aggregateVersion: integer("aggregate_version").notNull(),
    eventType: varchar("event_type", { length: 64 }).notNull(),
    status: varchar("status", { length: 16 }).default("PENDING").notNull(),
    attemptCount: integer("attempt_count").default(0).notNull(),
    lastErrorCode: varchar("last_error_code", { length: 64 }),
    createdAt: timestamp("created_at", tz).notNull(),
    availableAt: timestamp("available_at", tz).notNull(),
    processedAt: timestamp("processed_at", tz),
  },
  (table) => [
    unique("outbox_event_source_unique").on(
      table.eventType,
      table.aggregateId,
      table.aggregateVersion,
    ),
    index("outbox_event_pending_idx")
      .on(table.availableAt)
      .where(sql`${table.status} = 'PENDING'`),
    check(
      "outbox_event_type_check",
      sql`${table.eventType} = 'APPLICATION_RECEIVED_EMAIL'`,
    ),
    check(
      "outbox_event_aggregate_check",
      sql`${table.aggregateType} = 'CANDIDACY'`,
    ),
    check(
      "outbox_event_status_check",
      sql`${table.status} IN ('PENDING', 'SENT', 'FAILED')`,
    ),
    check(
      "outbox_event_processed_check",
      sql`(${table.status} = 'PENDING') = (${table.processedAt} IS NULL)`,
    ),
    check("outbox_event_attempt_check", sql`${table.attemptCount} >= 0`),
  ],
);

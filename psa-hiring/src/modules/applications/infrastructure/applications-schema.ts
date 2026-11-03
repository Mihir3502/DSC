import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { appSchema } from "../../../shared/database/schema/app";
import { candidacy } from "../../candidates/infrastructure/candidates-schema";
import { user } from "../../identity-access/infrastructure/auth-schema";

// Application templates and drafts (packet M2.4; DATA_MODEL §7).
//
// - A published template version is immutable, and a draft stays pinned to
//   the version it started on.
// - One candidacy has at most one DRAFT application version. SUBMITTED,
//   RETURNED, and SUPERSEDED arrive with M2.6 and M2.7.
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
    check("application_version_status_check", sql`${table.status} = 'DRAFT'`),
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

import { sql, type SQL } from "drizzle-orm";
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

// Organization, branch, team, position, job-description version, and
// hiring-cycle persistence (packet M2.1 §7–§13, §22; DATA_MODEL.md §5).
//
// - Database-generated nonsequential UUIDs (ADR-0002); hiring cycles also
//   carry a random public reference, the only identifier used in URLs.
// - Codes are stored normalized (upper case), so uniqueness is
//   case-insensitive; uniqueness is scoped to the parent.
// - Composite foreign keys make cross-organization or cross-branch
//   references impossible; no foreign key cascades.
// - Hand-written triggers in the migration refuse DELETE/TRUNCATE,
//   reparenting, code changes after activation/publication, published
//   description edits, published-cycle snapshot edits, and backward cycle
//   transitions. The runtime role also has no DELETE privilege.

const tz = { withTimezone: true } as const;

const actor = (name: string) => uuid(name).notNull();

const audited = {
  version: integer("version").default(1).notNull(),
  createdAt: timestamp("created_at", tz).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", tz)
    .defaultNow()
    .$onUpdate(() => new Date())
    .notNull(),
  createdByAccountId: actor("created_by_account_id"),
  updatedByAccountId: actor("updated_by_account_id"),
};

const codeCheck = (column: SQL | unknown) =>
  sql`${column} ~ '^[A-Z0-9][A-Z0-9_-]{1,31}$'`;
const bounded = (column: unknown, max: number) =>
  sql`char_length(${column}) BETWEEN 1 AND ${sql.raw(String(max))}`;

const hierarchyStatuses = `'DRAFT', 'ACTIVE', 'INACTIVE', 'ARCHIVED'`;

export const organization = appSchema.table(
  "organization",
  {
    id: uuid("id")
      .default(sql`pg_catalog.gen_random_uuid()`)
      .primaryKey(),
    code: varchar("code", { length: 32 }).notNull(),
    legalName: varchar("legal_name", { length: 200 }).notNull(),
    displayName: varchar("display_name", { length: 120 }).notNull(),
    timezone: varchar("timezone", { length: 64 }).notNull(),
    status: varchar("status", { length: 16 }).default("DRAFT").notNull(),
    activatedAt: timestamp("activated_at", tz),
    inactivatedAt: timestamp("inactivated_at", tz),
    ...audited,
  },
  (table) => [
    unique("organization_code_unique").on(table.code),
    check("organization_code_check", codeCheck(table.code)),
    check("organization_legal_name_check", bounded(table.legalName, 200)),
    check("organization_display_name_check", bounded(table.displayName, 120)),
    check("organization_timezone_check", bounded(table.timezone, 64)),
    check(
      "organization_status_check",
      sql`${table.status} IN (${sql.raw(hierarchyStatuses)})`,
    ),
    check(
      "organization_lifecycle_check",
      sql`(${table.status} = 'DRAFT') = (${table.activatedAt} IS NULL)`,
    ),
    check("organization_version_check", sql`${table.version} >= 1`),
    foreignKey({
      name: "organization_created_by_fk",
      columns: [table.createdByAccountId],
      foreignColumns: [user.id],
    }),
    foreignKey({
      name: "organization_updated_by_fk",
      columns: [table.updatedByAccountId],
      foreignColumns: [user.id],
    }),
  ],
);

export const branch = appSchema.table(
  "branch",
  {
    id: uuid("id")
      .default(sql`pg_catalog.gen_random_uuid()`)
      .primaryKey(),
    organizationId: uuid("organization_id").notNull(),
    code: varchar("code", { length: 32 }).notNull(),
    name: varchar("name", { length: 120 }).notNull(),
    publicLocationLabel: varchar("public_location_label", {
      length: 120,
    }).notNull(),
    timezone: varchar("timezone", { length: 64 }).notNull(),
    status: varchar("status", { length: 16 }).default("DRAFT").notNull(),
    activatedAt: timestamp("activated_at", tz),
    inactivatedAt: timestamp("inactivated_at", tz),
    ...audited,
  },
  (table) => [
    foreignKey({
      name: "branch_organization_fk",
      columns: [table.organizationId],
      foreignColumns: [organization.id],
    }),
    // Composite-key targets: children name both parent IDs.
    unique("branch_organization_id_unique").on(table.organizationId, table.id),
    unique("branch_code_unique").on(table.organizationId, table.code),
    check("branch_code_check", codeCheck(table.code)),
    check("branch_name_check", bounded(table.name, 120)),
    check(
      "branch_public_location_label_check",
      bounded(table.publicLocationLabel, 120),
    ),
    check("branch_timezone_check", bounded(table.timezone, 64)),
    check(
      "branch_status_check",
      sql`${table.status} IN (${sql.raw(hierarchyStatuses)})`,
    ),
    check(
      "branch_lifecycle_check",
      sql`(${table.status} = 'DRAFT') = (${table.activatedAt} IS NULL)`,
    ),
    check("branch_version_check", sql`${table.version} >= 1`),
    index("branch_scope_idx").on(table.organizationId, table.status),
    foreignKey({
      name: "branch_created_by_fk",
      columns: [table.createdByAccountId],
      foreignColumns: [user.id],
    }),
    foreignKey({
      name: "branch_updated_by_fk",
      columns: [table.updatedByAccountId],
      foreignColumns: [user.id],
    }),
  ],
);

export const team = appSchema.table(
  "team",
  {
    id: uuid("id")
      .default(sql`pg_catalog.gen_random_uuid()`)
      .primaryKey(),
    organizationId: uuid("organization_id").notNull(),
    branchId: uuid("branch_id").notNull(),
    code: varchar("code", { length: 32 }).notNull(),
    name: varchar("name", { length: 120 }).notNull(),
    status: varchar("status", { length: 16 }).default("DRAFT").notNull(),
    activatedAt: timestamp("activated_at", tz),
    inactivatedAt: timestamp("inactivated_at", tz),
    ...audited,
  },
  (table) => [
    // The team's organization is its branch's organization.
    foreignKey({
      name: "team_branch_fk",
      columns: [table.organizationId, table.branchId],
      foreignColumns: [branch.organizationId, branch.id],
    }),
    unique("team_branch_id_unique").on(table.branchId, table.id),
    unique("team_code_unique").on(table.branchId, table.code),
    check("team_code_check", codeCheck(table.code)),
    check("team_name_check", bounded(table.name, 120)),
    check(
      "team_status_check",
      sql`${table.status} IN (${sql.raw(hierarchyStatuses)})`,
    ),
    check(
      "team_lifecycle_check",
      sql`(${table.status} = 'DRAFT') = (${table.activatedAt} IS NULL)`,
    ),
    check("team_version_check", sql`${table.version} >= 1`),
    index("team_scope_idx").on(
      table.organizationId,
      table.branchId,
      table.status,
    ),
    foreignKey({
      name: "team_created_by_fk",
      columns: [table.createdByAccountId],
      foreignColumns: [user.id],
    }),
    foreignKey({
      name: "team_updated_by_fk",
      columns: [table.updatedByAccountId],
      foreignColumns: [user.id],
    }),
  ],
);

export const position = appSchema.table(
  "position",
  {
    id: uuid("id")
      .default(sql`pg_catalog.gen_random_uuid()`)
      .primaryKey(),
    organizationId: uuid("organization_id").notNull(),
    code: varchar("code", { length: 32 }).notNull(),
    internalTitle: varchar("internal_title", { length: 120 }).notNull(),
    publicTitle: varchar("public_title", { length: 120 }).notNull(),
    workerPathsAllowed: varchar("worker_paths_allowed", {
      length: 32,
    }).notNull(),
    status: varchar("status", { length: 16 }).default("DRAFT").notNull(),
    activatedAt: timestamp("activated_at", tz),
    retiredAt: timestamp("retired_at", tz),
    ...audited,
  },
  (table) => [
    foreignKey({
      name: "position_organization_fk",
      columns: [table.organizationId],
      foreignColumns: [organization.id],
    }),
    unique("position_organization_id_unique").on(
      table.organizationId,
      table.id,
    ),
    unique("position_code_unique").on(table.organizationId, table.code),
    check("position_code_check", codeCheck(table.code)),
    check("position_internal_title_check", bounded(table.internalTitle, 120)),
    check("position_public_title_check", bounded(table.publicTitle, 120)),
    check(
      "position_worker_paths_check",
      sql`${table.workerPathsAllowed} IN ('W2_ONLY', 'CONTRACTOR_ELIGIBLE_ONLY', 'W2_AND_CONTRACTOR_ELIGIBLE')`,
    ),
    check(
      "position_status_check",
      sql`${table.status} IN ('DRAFT', 'ACTIVE', 'INACTIVE', 'RETIRED')`,
    ),
    check(
      "position_lifecycle_check",
      sql`(${table.status} <> 'DRAFT' OR ${table.activatedAt} IS NULL) AND (${table.status} NOT IN ('ACTIVE', 'INACTIVE') OR ${table.activatedAt} IS NOT NULL) AND ((${table.status} = 'RETIRED') = (${table.retiredAt} IS NOT NULL))`,
    ),
    check("position_version_check", sql`${table.version} >= 1`),
    index("position_scope_idx").on(
      table.organizationId,
      table.status,
      table.code,
    ),
    foreignKey({
      name: "position_created_by_fk",
      columns: [table.createdByAccountId],
      foreignColumns: [user.id],
    }),
    foreignKey({
      name: "position_updated_by_fk",
      columns: [table.updatedByAccountId],
      foreignColumns: [user.id],
    }),
  ],
);

export const jobDescriptionVersion = appSchema.table(
  "job_description_version",
  {
    id: uuid("id")
      .default(sql`pg_catalog.gen_random_uuid()`)
      .primaryKey(),
    organizationId: uuid("organization_id").notNull(),
    positionId: uuid("position_id").notNull(),
    versionNumber: integer("version_number").notNull(),
    publicTitle: varchar("public_title", { length: 120 }).notNull(),
    summary: varchar("summary", { length: 500 }).notNull(),
    body: text("body").notNull(),
    contentFormat: varchar("content_format", { length: 32 })
      .default("PLAIN_TEXT_V1")
      .notNull(),
    status: varchar("status", { length: 16 }).default("DRAFT").notNull(),
    publishedAt: timestamp("published_at", tz),
    publishedByAccountId: uuid("published_by_account_id"),
    supersededAt: timestamp("superseded_at", tz),
    ...audited,
  },
  (table) => [
    foreignKey({
      name: "job_description_version_position_fk",
      columns: [table.organizationId, table.positionId],
      foreignColumns: [position.organizationId, position.id],
    }),
    unique("job_description_version_position_id_unique").on(
      table.positionId,
      table.id,
    ),
    unique("job_description_version_number_unique").on(
      table.positionId,
      table.versionNumber,
    ),
    uniqueIndex("job_description_version_one_draft")
      .on(table.positionId)
      .where(sql`${table.status} = 'DRAFT'`),
    uniqueIndex("job_description_version_one_published")
      .on(table.positionId)
      .where(sql`${table.status} = 'PUBLISHED'`),
    check(
      "job_description_version_number_check",
      sql`${table.versionNumber} >= 1`,
    ),
    check(
      "job_description_version_public_title_check",
      bounded(table.publicTitle, 120),
    ),
    check("job_description_version_summary_check", bounded(table.summary, 500)),
    check("job_description_version_body_check", bounded(table.body, 8000)),
    check(
      "job_description_version_format_check",
      sql`${table.contentFormat} = 'PLAIN_TEXT_V1'`,
    ),
    check(
      "job_description_version_status_check",
      sql`${table.status} IN ('DRAFT', 'PUBLISHED', 'SUPERSEDED', 'RETIRED')`,
    ),
    check(
      "job_description_version_lifecycle_check",
      sql`((${table.status} IN ('PUBLISHED', 'SUPERSEDED')) = (${table.publishedAt} IS NOT NULL AND ${table.publishedByAccountId} IS NOT NULL)) AND ((${table.status} = 'SUPERSEDED') = (${table.supersededAt} IS NOT NULL))`,
    ),
    check("job_description_version_version_check", sql`${table.version} >= 1`),
    foreignKey({
      name: "job_description_version_published_by_fk",
      columns: [table.publishedByAccountId],
      foreignColumns: [user.id],
    }),
    foreignKey({
      name: "job_description_version_created_by_fk",
      columns: [table.createdByAccountId],
      foreignColumns: [user.id],
    }),
    foreignKey({
      name: "job_description_version_updated_by_fk",
      columns: [table.updatedByAccountId],
      foreignColumns: [user.id],
    }),
  ],
);

const cycleStatuses = `'DRAFT', 'PUBLISHED', 'OPEN', 'CLOSED', 'CANCELLED', 'ARCHIVED'`;

export const hiringCycle = appSchema.table(
  "hiring_cycle",
  {
    id: uuid("id")
      .default(sql`pg_catalog.gen_random_uuid()`)
      .primaryKey(),
    publicReference: varchar("public_reference", { length: 12 }).notNull(),
    organizationId: uuid("organization_id").notNull(),
    positionId: uuid("position_id").notNull(),
    branchId: uuid("branch_id").notNull(),
    teamId: uuid("team_id"),
    code: varchar("code", { length: 32 }).notNull(),
    internalLabel: varchar("internal_label", { length: 120 }).notNull(),
    publicLabel: varchar("public_label", { length: 120 }),
    status: varchar("status", { length: 16 }).default("DRAFT").notNull(),
    opensAt: timestamp("opens_at", tz).notNull(),
    closesAt: timestamp("closes_at", tz),
    openEnded: boolean("open_ended").default(false).notNull(),
    displayTimezone: varchar("display_timezone", { length: 64 }).notNull(),
    // Snapshot frozen at publication (DATA_MODEL §5.6).
    jobDescriptionVersionId: uuid("job_description_version_id"),
    workerPathsSnapshot: varchar("worker_paths_snapshot", { length: 32 }),
    publicTitleSnapshot: varchar("public_title_snapshot", { length: 120 }),
    locationLabelSnapshot: varchar("location_label_snapshot", {
      length: 120,
    }),
    publishedAt: timestamp("published_at", tz),
    publishedByAccountId: uuid("published_by_account_id"),
    openedAt: timestamp("opened_at", tz),
    openedByAccountId: uuid("opened_by_account_id"),
    closedAt: timestamp("closed_at", tz),
    closedByAccountId: uuid("closed_by_account_id"),
    cancelledAt: timestamp("cancelled_at", tz),
    cancelledByAccountId: uuid("cancelled_by_account_id"),
    archivedAt: timestamp("archived_at", tz),
    archivedByAccountId: uuid("archived_by_account_id"),
    endReasonCode: varchar("end_reason_code", { length: 64 }),
    ...audited,
  },
  (table) => [
    unique("hiring_cycle_public_reference_unique").on(table.publicReference),
    unique("hiring_cycle_code_unique").on(table.organizationId, table.code),
    foreignKey({
      name: "hiring_cycle_position_fk",
      columns: [table.organizationId, table.positionId],
      foreignColumns: [position.organizationId, position.id],
    }),
    foreignKey({
      name: "hiring_cycle_branch_fk",
      columns: [table.organizationId, table.branchId],
      foreignColumns: [branch.organizationId, branch.id],
    }),
    // MATCH SIMPLE: a null team skips the check; a set team must be in
    // the cycle's branch.
    foreignKey({
      name: "hiring_cycle_team_fk",
      columns: [table.branchId, table.teamId],
      foreignColumns: [team.branchId, team.id],
    }),
    foreignKey({
      name: "hiring_cycle_description_fk",
      columns: [table.positionId, table.jobDescriptionVersionId],
      foreignColumns: [
        jobDescriptionVersion.positionId,
        jobDescriptionVersion.id,
      ],
    }),
    check(
      "hiring_cycle_public_reference_check",
      sql`${table.publicReference} ~ '^[0-9a-hjkmnp-tv-z]{12}$'`,
    ),
    check("hiring_cycle_code_check", codeCheck(table.code)),
    check(
      "hiring_cycle_internal_label_check",
      bounded(table.internalLabel, 120),
    ),
    check(
      "hiring_cycle_public_label_check",
      sql`${table.publicLabel} IS NULL OR ${bounded(table.publicLabel, 120)}`,
    ),
    check(
      "hiring_cycle_status_check",
      sql`${table.status} IN (${sql.raw(cycleStatuses)})`,
    ),
    check(
      "hiring_cycle_window_check",
      sql`((${table.closesAt} IS NULL) = ${table.openEnded}) AND (${table.closesAt} IS NULL OR ${table.closesAt} > ${table.opensAt})`,
    ),
    check("hiring_cycle_timezone_check", bounded(table.displayTimezone, 64)),
    check(
      "hiring_cycle_worker_paths_check",
      sql`${table.workerPathsSnapshot} IS NULL OR ${table.workerPathsSnapshot} IN ('W2_ONLY', 'CONTRACTOR_ELIGIBLE_ONLY', 'W2_AND_CONTRACTOR_ELIGIBLE')`,
    ),
    // A published cycle carries its complete snapshot and publisher.
    check(
      "hiring_cycle_snapshot_check",
      sql`(${table.publishedAt} IS NULL) = (${table.publishedByAccountId} IS NULL) AND (${table.publishedAt} IS NULL OR (${table.jobDescriptionVersionId} IS NOT NULL AND ${table.workerPathsSnapshot} IS NOT NULL AND ${table.publicTitleSnapshot} IS NOT NULL AND ${table.locationLabelSnapshot} IS NOT NULL))`,
    ),
    check(
      "hiring_cycle_lifecycle_check",
      sql`(${table.status} <> 'DRAFT' OR (${table.publishedAt} IS NULL AND ${table.cancelledAt} IS NULL)) AND (${table.status} NOT IN ('PUBLISHED', 'OPEN', 'CLOSED') OR ${table.publishedAt} IS NOT NULL) AND ((${table.openedAt} IS NULL) = (${table.openedByAccountId} IS NULL)) AND (${table.status} <> 'OPEN' OR ${table.openedAt} IS NOT NULL) AND ((${table.closedAt} IS NULL) = (${table.closedByAccountId} IS NULL)) AND ((${table.status} = 'CLOSED') <= (${table.closedAt} IS NOT NULL)) AND ((${table.cancelledAt} IS NULL) = (${table.cancelledByAccountId} IS NULL)) AND ((${table.status} = 'CANCELLED') <= (${table.cancelledAt} IS NOT NULL)) AND ((${table.archivedAt} IS NULL) = (${table.archivedByAccountId} IS NULL)) AND ((${table.status} = 'ARCHIVED') = (${table.archivedAt} IS NOT NULL)) AND ((${table.closedAt} IS NOT NULL OR ${table.cancelledAt} IS NOT NULL) = (${table.endReasonCode} IS NOT NULL)) AND NOT (${table.closedAt} IS NOT NULL AND ${table.cancelledAt} IS NOT NULL)`,
    ),
    check(
      "hiring_cycle_reason_check",
      sql`${table.endReasonCode} IS NULL OR ${table.endReasonCode} ~ '^[A-Z][A-Z0-9_]{1,63}$'`,
    ),
    check("hiring_cycle_version_check", sql`${table.version} >= 1`),
    index("hiring_cycle_public_open_idx")
      .on(table.opensAt, table.closesAt, table.id)
      .where(sql`${table.status} = 'OPEN'`),
    index("hiring_cycle_scope_idx").on(
      table.organizationId,
      table.branchId,
      table.teamId,
      table.status,
    ),
    index("hiring_cycle_position_idx").on(
      table.positionId,
      table.branchId,
      table.status,
      table.opensAt,
    ),
    ...(
      [
        ["published_by", table.publishedByAccountId],
        ["opened_by", table.openedByAccountId],
        ["closed_by", table.closedByAccountId],
        ["cancelled_by", table.cancelledByAccountId],
        ["archived_by", table.archivedByAccountId],
        ["created_by", table.createdByAccountId],
        ["updated_by", table.updatedByAccountId],
      ] as const
    ).map(([name, column]) =>
      foreignKey({
        name: `hiring_cycle_${name}_fk`,
        columns: [column],
        foreignColumns: [user.id],
      }),
    ),
  ],
);

/**
 * One row per accepted configuration command key (ADR-0013). Append-only:
 * a retried key returns the recorded result instead of acting again.
 */
export const organizationCommandReceipt = appSchema.table(
  "organization_command_receipt",
  {
    id: uuid("id")
      .default(sql`pg_catalog.gen_random_uuid()`)
      .primaryKey(),
    actorAccountId: uuid("actor_account_id").notNull(),
    commandKey: uuid("command_key").notNull(),
    commandName: varchar("command_name", { length: 64 }).notNull(),
    targetId: uuid("target_id").notNull(),
    resultVersion: integer("result_version").notNull(),
    createdAt: timestamp("created_at", tz).defaultNow().notNull(),
  },
  (table) => [
    unique("organization_command_receipt_key_unique").on(
      table.actorAccountId,
      table.commandKey,
    ),
    check(
      "organization_command_receipt_name_check",
      sql`${table.commandName} ~ '^[a-z][a-z_]{1,63}$'`,
    ),
    check(
      "organization_command_receipt_version_check",
      sql`${table.resultVersion} >= 1`,
    ),
    foreignKey({
      name: "organization_command_receipt_actor_fk",
      columns: [table.actorAccountId],
      foreignColumns: [user.id],
    }),
  ],
);

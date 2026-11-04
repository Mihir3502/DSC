import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  foreignKey,
  index,
  integer,
  timestamp,
  unique,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { appSchema } from "../../../shared/database/schema/app";
import { candidacy } from "../../candidates/infrastructure/candidates-schema";
import { user } from "../../identity-access/infrastructure/auth-schema";

// Application attachments (packet M2.5; DATA_MODEL §12). A document is the
// logical identity on one candidacy, and each upload is an immutable version.
// `current_version_id` moves only to a version that passed its checks, so a
// replacement never hides the file it replaces. Nothing is ever deleted, no
// foreign key cascades, and audit records access.

const tz = { withTimezone: true } as const;

export const document = appSchema.table(
  "document",
  {
    id: uuid("id")
      .default(sql`pg_catalog.gen_random_uuid()`)
      .primaryKey(),
    publicId: varchar("public_id", { length: 12 }).notNull(),
    candidacyId: uuid("candidacy_id").notNull(),
    categoryCode: varchar("category_code", { length: 32 }).notNull(),
    dataClassification: varchar("data_classification", {
      length: 32,
    }).notNull(),
    retentionClassCode: varchar("retention_class_code", {
      length: 64,
    }).notNull(),
    currentVersionId: uuid("current_version_id"),
    status: varchar("status", { length: 16 }).default("ACTIVE").notNull(),
    version: integer("version").default(1).notNull(),
    createdByAccountId: uuid("created_by_account_id").notNull(),
    createdAt: timestamp("created_at", tz).notNull(),
    updatedAt: timestamp("updated_at", tz).notNull(),
  },
  (table) => [
    unique("document_public_id_unique").on(table.publicId),
    foreignKey({
      name: "document_candidacy_fk",
      columns: [table.candidacyId],
      foreignColumns: [candidacy.id],
    }),
    foreignKey({
      name: "document_created_by_fk",
      columns: [table.createdByAccountId],
      foreignColumns: [user.id],
    }),
    index("document_candidacy_idx").on(table.candidacyId, table.status),
    check(
      "document_public_id_check",
      sql`${table.publicId} ~ '^[0-9a-hjkmnp-tv-z]{12}$'`,
    ),
    check(
      "document_category_check",
      sql`${table.categoryCode} IN ('RESUME', 'CREDENTIAL')`,
    ),
    check(
      "document_classification_check",
      sql`${table.dataClassification} = 'CONFIDENTIAL_PERSONNEL'`,
    ),
    check(
      "document_retention_check",
      sql`${table.retentionClassCode} = 'APPLICATION_ATTACHMENT_UNSET'`,
    ),
    check(
      "document_status_check",
      sql`${table.status} IN ('ACTIVE', 'REMOVED')`,
    ),
    check("document_version_check", sql`${table.version} >= 1`),
  ],
);

export const documentVersion = appSchema.table(
  "document_version",
  {
    id: uuid("id")
      .default(sql`pg_catalog.gen_random_uuid()`)
      .primaryKey(),
    documentId: uuid("document_id").notNull(),
    versionNumber: integer("version_number").notNull(),
    storageProviderCode: varchar("storage_provider_code", {
      length: 32,
    }).notNull(),
    storageObjectKey: uuid("storage_object_key").notNull(),
    displayName: varchar("display_name", { length: 120 }).notNull(),
    mediaType: varchar("media_type", { length: 32 }).notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    contentHash: varchar("content_hash", { length: 64 }).notNull(),
    scanStatus: varchar("scan_status", { length: 16 })
      .default("PENDING")
      .notNull(),
    scannerCode: varchar("scanner_code", { length: 32 }),
    supersedesId: uuid("supersedes_id"),
    uploadedByAccountId: uuid("uploaded_by_account_id").notNull(),
    uploadedAt: timestamp("uploaded_at", tz).notNull(),
    finalizedAt: timestamp("finalized_at", tz),
  },
  (table) => [
    unique("document_version_number_unique").on(
      table.documentId,
      table.versionNumber,
    ),
    unique("document_version_key_unique").on(table.storageObjectKey),
    foreignKey({
      name: "document_version_document_fk",
      columns: [table.documentId],
      foreignColumns: [document.id],
    }),
    foreignKey({
      name: "document_version_supersedes_fk",
      columns: [table.supersedesId],
      foreignColumns: [table.id],
    }),
    foreignKey({
      name: "document_version_uploaded_by_fk",
      columns: [table.uploadedByAccountId],
      foreignColumns: [user.id],
    }),
    index("document_version_pending_idx")
      .on(table.scanStatus, table.uploadedAt)
      .where(sql`${table.scanStatus} = 'PENDING'`),
    check("document_version_number_check", sql`${table.versionNumber} >= 1`),
    check(
      "document_version_media_check",
      sql`${table.mediaType} IN ('application/pdf', 'image/jpeg', 'image/png')`,
    ),
    check(
      "document_version_size_check",
      sql`${table.sizeBytes} BETWEEN 1 AND 10485760`,
    ),
    check(
      "document_version_hash_check",
      sql`${table.contentHash} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "document_version_scan_check",
      sql`${table.scanStatus} IN ('PENDING', 'CLEAN', 'REJECTED', 'FAILED')`,
    ),
    check(
      "document_version_finalized_check",
      sql`(${table.scanStatus} = 'PENDING') = (${table.finalizedAt} IS NULL)`,
    ),
  ],
);

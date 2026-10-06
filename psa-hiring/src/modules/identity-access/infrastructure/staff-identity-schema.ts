import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { authSchema, user } from "./auth-schema";

// Application-owned staff identity tables (packet M1.3 §7, §14, ADR-0004).
// They live in the `auth` schema next to the account they protect so the
// runtime role receives SELECT/INSERT/UPDATE only: invitations and recovery
// cases are security evidence and are never deleted by the application.
// No organization, branch, team, role, permission, or scope columns exist
// here; those belong to M1.4 and later.

const tz = { withTimezone: true } as const;

/**
 * Versioned, email-bound staff invitation. Only a SHA-256 digest of the
 * random 256-bit capability is stored. At most one PENDING invitation per
 * normalized email exists (partial unique index); resend supersedes it.
 */
export const staffInvitation = authSchema.table(
  "staff_invitation",
  {
    id: uuid("id")
      .default(sql`pg_catalog.gen_random_uuid()`)
      .primaryKey(),
    email: text("email").notNull(),
    emailDisplay: varchar("email_display", { length: 320 }).notNull(),
    purpose: varchar("purpose", { length: 24 }).notNull(),
    status: varchar("status", { length: 16 }).notNull(),
    tokenDigest: varchar("token_digest", { length: 64 }).notNull().unique(),
    /** Issue number for this email: resend creates sequence + 1. */
    sequence: integer("sequence").default(1).notNull(),
    /** Bound account: set when activation starts, or at issue for reenrollment. */
    accountId: uuid("account_id").references(() => user.id),
    issuerAccountId: uuid("issuer_account_id").references(() => user.id),
    issuerReasonCode: varchar("issuer_reason_code", { length: 32 }).notNull(),
    recoveryCaseId: uuid("recovery_case_id").references(
      (): AnyPgColumn => staffRecoveryCase.id,
    ),
    issuedAt: timestamp("issued_at", tz).notNull(),
    expiresAt: timestamp("expires_at", tz).notNull(),
    acceptedAt: timestamp("accepted_at", tz),
    revokedAt: timestamp("revoked_at", tz),
    supersededAt: timestamp("superseded_at", tz),
    expiredAt: timestamp("expired_at", tz),
    supersededById: uuid("superseded_by_id").references(
      (): AnyPgColumn => staffInvitation.id,
    ),
    version: integer("version").default(1).notNull(),
    createdAt: timestamp("created_at", tz).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", tz)
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex("staff_invitation_one_pending_per_email")
      .on(table.email)
      .where(sql`${table.status} = 'PENDING'`),
    index("staff_invitation_account_idx").on(table.accountId),
    check(
      "staff_invitation_status_check",
      sql`${table.status} IN ('PENDING', 'ACCEPTED', 'REVOKED', 'EXPIRED', 'SUPERSEDED')`,
    ),
    check(
      "staff_invitation_purpose_check",
      sql`${table.purpose} IN ('STAFF_ACTIVATION', 'STAFF_REENROLLMENT')`,
    ),
    check(
      "staff_invitation_issuer_reason_check",
      sql`${table.issuerReasonCode} IN ('LOCAL_BOOTSTRAP', 'TEST_HARNESS', 'RECOVERY_REENROLLMENT')`,
    ),
    check(
      "staff_invitation_email_normalized_check",
      sql`${table.email} = lower(${table.email}) AND ${table.email} = btrim(${table.email}) AND char_length(${table.email}) BETWEEN 3 AND 254`,
    ),
    check(
      "staff_invitation_token_digest_check",
      sql`${table.tokenDigest} ~ '^[A-Za-z0-9_-]{43}$'`,
    ),
    check("staff_invitation_sequence_check", sql`${table.sequence} >= 1`),
    check("staff_invitation_version_check", sql`${table.version} >= 1`),
    check(
      "staff_invitation_expiry_check",
      sql`${table.expiresAt} > ${table.issuedAt}`,
    ),
    check(
      "staff_invitation_accepted_check",
      sql`(${table.status} = 'ACCEPTED') = (${table.acceptedAt} IS NOT NULL) AND (${table.status} <> 'ACCEPTED' OR (${table.accountId} IS NOT NULL AND ${table.acceptedAt} <= ${table.expiresAt}))`,
    ),
    check(
      "staff_invitation_revoked_check",
      sql`(${table.status} = 'REVOKED') = (${table.revokedAt} IS NOT NULL)`,
    ),
    check(
      "staff_invitation_superseded_check",
      sql`(${table.status} = 'SUPERSEDED') = (${table.supersededAt} IS NOT NULL)`,
    ),
    check(
      "staff_invitation_expired_check",
      sql`(${table.status} = 'EXPIRED') = (${table.expiredAt} IS NOT NULL)`,
    ),
    check(
      "staff_invitation_reenrollment_check",
      sql`${table.purpose} <> 'STAFF_REENROLLMENT' OR (${table.accountId} IS NOT NULL AND ${table.recoveryCaseId} IS NOT NULL)`,
    ),
  ],
);

/**
 * Administrative staff recovery/MFA-reset case. Holds references and safe
 * codes only: no identity evidence, government IDs, answers, free text, or
 * support communications. One open case per account.
 */
export const staffRecoveryCase = authSchema.table(
  "staff_recovery_case",
  {
    id: uuid("id")
      .default(sql`pg_catalog.gen_random_uuid()`)
      .primaryKey(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => user.id),
    status: varchar("status", { length: 32 }).notNull(),
    reasonCode: varchar("reason_code", { length: 32 }).notNull(),
    resolutionCode: varchar("resolution_code", { length: 32 }),
    requestedAt: timestamp("requested_at", tz).notNull(),
    expiresAt: timestamp("expires_at", tz).notNull(),
    verificationStartedAt: timestamp("verification_started_at", tz),
    identityVerifiedAt: timestamp("identity_verified_at", tz),
    approvedAt: timestamp("approved_at", tz),
    approvalExpiresAt: timestamp("approval_expires_at", tz),
    resolvedAt: timestamp("resolved_at", tz),
    verifierAccountId: uuid("verifier_account_id").references(() => user.id),
    approverAccountId: uuid("approver_account_id").references(() => user.id),
    completedByAccountId: uuid("completed_by_account_id").references(
      () => user.id,
    ),
    version: integer("version").default(1).notNull(),
    createdAt: timestamp("created_at", tz).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", tz)
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex("staff_recovery_case_one_open_per_account")
      .on(table.accountId)
      .where(
        sql`${table.status} IN ('REQUESTED', 'IDENTITY_VERIFICATION_PENDING', 'APPROVAL_PENDING', 'APPROVED')`,
      ),
    check(
      "staff_recovery_case_status_check",
      sql`${table.status} IN ('REQUESTED', 'IDENTITY_VERIFICATION_PENDING', 'APPROVAL_PENDING', 'APPROVED', 'COMPLETED', 'REJECTED', 'EXPIRED', 'CANCELLED')`,
    ),
    check(
      "staff_recovery_case_reason_check",
      sql`${table.reasonCode} IN ('LOST_AUTHENTICATOR', 'FORGOTTEN_PASSWORD', 'SUSPECTED_COMPROMISE', 'UNSPECIFIED')`,
    ),
    check(
      "staff_recovery_case_resolution_check",
      sql`(${table.status} IN ('COMPLETED', 'REJECTED', 'EXPIRED', 'CANCELLED')) = (${table.resolvedAt} IS NOT NULL AND ${table.resolutionCode} IS NOT NULL)`,
    ),
    check(
      "staff_recovery_case_resolution_code_check",
      sql`${table.resolutionCode} IS NULL OR ${table.resolutionCode} IN ('RESET_COMPLETED', 'IDENTITY_NOT_VERIFIED', 'APPROVAL_DENIED', 'REQUEST_CANCELLED', 'REQUEST_EXPIRED', 'APPROVAL_EXPIRED')`,
    ),
    check(
      "staff_recovery_case_expiry_check",
      sql`${table.expiresAt} > ${table.requestedAt}`,
    ),
    // Separation of duties: nobody verifies or approves their own reset,
    // and the approver is a different person from the verifier.
    check(
      "staff_recovery_case_separation_check",
      sql`(${table.verifierAccountId} IS NULL OR ${table.verifierAccountId} <> ${table.accountId}) AND (${table.approverAccountId} IS NULL OR (${table.approverAccountId} <> ${table.accountId} AND ${table.approverAccountId} IS DISTINCT FROM ${table.verifierAccountId}))`,
    ),
    check(
      "staff_recovery_case_approval_check",
      sql`(${table.approvedAt} IS NULL) = (${table.approverAccountId} IS NULL) AND (${table.approvedAt} IS NULL) = (${table.approvalExpiresAt} IS NULL)`,
    ),
    check("staff_recovery_case_version_check", sql`${table.version} >= 1`),
  ],
);

/**
 * Accepted TOTP codes per account until they leave the ±1-step window, so a
 * code is accepted only once (NIST SP 800-63B). Stores an HMAC digest, never
 * the code. Rows are pruned after expiry.
 */
export const totpReplayGuard = authSchema.table(
  "totp_replay_guard",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    codeDigest: varchar("code_digest", { length: 64 }).notNull(),
    expiresAt: timestamp("expires_at", tz).notNull(),
    createdAt: timestamp("created_at", tz).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({
      name: "totp_replay_guard_pk",
      columns: [table.userId, table.codeDigest],
    }),
    index("totp_replay_guard_expires_idx").on(table.expiresAt),
  ],
);

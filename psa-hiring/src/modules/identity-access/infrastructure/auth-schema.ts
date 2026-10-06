import { relations, sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  pgSchema,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

// Better Auth 1.7.7 core tables in the dedicated PostgreSQL `auth` schema.
// Generated from the pinned CLI (`auth generate`) and reviewed: library
// columns, indexes, unique constraints, and foreign keys are kept as
// generated; timestamps use `timestamptz` (DATA_MODEL §2.2); application-owned
// account fields and closed CHECK constraints are added on the single
// authoritative `auth.user` record (ADR-0002). M1.3 adds the two-factor
// plugin table and server-owned session assurance columns (ADR-0004).
// Validated by `pnpm auth:schema:check`.

export const authSchema = pgSchema("auth");

const tz = { withTimezone: true } as const;

export const user = authSchema.table(
  "user",
  {
    id: uuid("id")
      .default(sql`pg_catalog.gen_random_uuid()`)
      .primaryKey(),
    name: text("name").notNull(),
    // Normalized login email (normalizeLoginEmail); unique and lowercase.
    email: text("email").notNull().unique(),
    emailVerified: boolean("email_verified").default(false).notNull(),
    image: text("image"),
    createdAt: timestamp("created_at", tz).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", tz)
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
    // Application-owned, server-only fields (input: false, returned: false).
    emailDisplay: varchar("email_display", { length: 320 }),
    accountType: varchar("account_type", { length: 16 }).notNull(),
    status: varchar("status", { length: 16 }).notNull(),
    lastAuthenticatedAt: timestamp("last_authenticated_at", tz),
    disabledAt: timestamp("disabled_at", tz),
    disabledReasonCode: varchar("disabled_reason_code", { length: 40 }),
    version: integer("version").default(1).notNull(),
    // Two-factor plugin (M1.3). input:false in the plugin schema.
    twoFactorEnabled: boolean("two_factor_enabled").default(false).notNull(),
  },
  (table) => [
    check(
      "user_account_type_check",
      sql`${table.accountType} IN ('CANDIDATE', 'STAFF', 'SERVICE')`,
    ),
    check(
      "user_status_check",
      sql`${table.status} IN ('INVITED', 'ACTIVE', 'LOCKED', 'DISABLED', 'CLOSED')`,
    ),
    check(
      "user_disabled_reason_code_check",
      sql`${table.disabledReasonCode} IS NULL OR ${table.disabledReasonCode} IN ('SECURITY_LOCK', 'ADMINISTRATIVE_DISABLE', 'ACCOUNT_CLOSED')`,
    ),
    check(
      "user_restriction_metadata_check",
      sql`(${table.status} IN ('LOCKED', 'DISABLED', 'CLOSED')) = (${table.disabledAt} IS NOT NULL AND ${table.disabledReasonCode} IS NOT NULL)`,
    ),
    check(
      "user_email_normalized_check",
      sql`${table.email} = lower(${table.email}) AND ${table.email} = btrim(${table.email}) AND char_length(${table.email}) BETWEEN 3 AND 254`,
    ),
    check(
      "user_name_length_check",
      sql`char_length(${table.name}) BETWEEN 1 AND 200`,
    ),
    check("user_version_check", sql`${table.version} >= 1`),
  ],
);

export const session = authSchema.table(
  "session",
  {
    id: uuid("id")
      .default(sql`pg_catalog.gen_random_uuid()`)
      .primaryKey(),
    expiresAt: timestamp("expires_at", tz).notNull(),
    token: text("token").notNull().unique(),
    createdAt: timestamp("created_at", tz).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", tz)
      .$onUpdate(() => new Date())
      .notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    // Server-owned assurance evidence (M1.3, ADR-0004); input:false and
    // returned:false, written only by the session hook and reauth command.
    authPurpose: varchar("auth_purpose", { length: 24 }),
    authMethod: varchar("auth_method", { length: 32 }),
    primaryAuthenticatedAt: timestamp("primary_authenticated_at", tz),
    mfaAuthenticatedAt: timestamp("mfa_authenticated_at", tz),
    accountVersion: integer("account_version"),
    reauthenticatedAt: timestamp("reauthenticated_at", tz),
    reauthenticationMethod: varchar("reauthentication_method", {
      length: 32,
    }),
    reauthenticationPurpose: varchar("reauthentication_purpose", {
      length: 64,
    }),
  },
  (table) => [
    index("session_userId_idx").on(table.userId),
    check(
      "session_auth_purpose_check",
      sql`${table.authPurpose} IS NULL OR ${table.authPurpose} IN ('STANDARD', 'STAFF_FIRST_FACTOR', 'STAFF_ACTIVATION', 'STAFF')`,
    ),
    check(
      "session_auth_method_check",
      sql`${table.authMethod} IS NULL OR ${table.authMethod} IN ('PASSWORD', 'PASSWORD_TOTP', 'PASSWORD_BACKUP_CODE')`,
    ),
    check(
      "session_staff_assurance_check",
      sql`${table.authPurpose} IS DISTINCT FROM 'STAFF' OR (${table.authMethod} IN ('PASSWORD_TOTP', 'PASSWORD_BACKUP_CODE') AND ${table.primaryAuthenticatedAt} IS NOT NULL AND ${table.mfaAuthenticatedAt} IS NOT NULL AND ${table.accountVersion} IS NOT NULL)`,
    ),
    check(
      "session_reauthentication_check",
      sql`(${table.reauthenticatedAt} IS NULL AND ${table.reauthenticationMethod} IS NULL AND ${table.reauthenticationPurpose} IS NULL) OR (${table.reauthenticatedAt} IS NOT NULL AND ${table.reauthenticationMethod} = 'PASSWORD_TOTP' AND ${table.reauthenticationPurpose} ~ '^[A-Z_]{1,64}$')`,
    ),
  ],
);

export const account = authSchema.table(
  "account",
  {
    id: uuid("id")
      .default(sql`pg_catalog.gen_random_uuid()`)
      .primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", tz),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", tz),
    scope: text("scope"),
    // Better Auth password hash (credential provider). Never logged/returned.
    password: text("password"),
    createdAt: timestamp("created_at", tz).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", tz)
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [index("account_userId_idx").on(table.userId)],
);

export const verification = authSchema.table(
  "verification",
  {
    id: uuid("id")
      .default(sql`pg_catalog.gen_random_uuid()`)
      .primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at", tz).notNull(),
    createdAt: timestamp("created_at", tz).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", tz)
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [index("verification_identifier_idx").on(table.identifier)],
);

// Two-factor plugin table (M1.3). `secret` (TOTP seed) and `backup_codes`
// hold only Better Auth XChaCha20-Poly1305 ciphertext under the versioned
// auth secret; both are returned:false. One enrollment per account.
export const twoFactor = authSchema.table(
  "two_factor",
  {
    id: uuid("id")
      .default(sql`pg_catalog.gen_random_uuid()`)
      .primaryKey(),
    secret: text("secret").notNull(),
    backupCodes: text("backup_codes").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    verified: boolean("verified").default(true).notNull(),
    failedVerificationCount: integer("failed_verification_count")
      .default(0)
      .notNull(),
    lockedUntil: timestamp("locked_until", tz),
  },
  (table) => [
    index("twoFactor_secret_idx").on(table.secret),
    index("twoFactor_userId_idx").on(table.userId),
    unique("two_factor_user_id_unique").on(table.userId),
    check(
      "two_factor_failed_count_check",
      sql`${table.failedVerificationCount} >= 0`,
    ),
  ],
);

export const userRelations = relations(user, ({ many }) => ({
  sessions: many(session),
  accounts: many(account),
  twoFactors: many(twoFactor),
}));

export const twoFactorRelations = relations(twoFactor, ({ one }) => ({
  user: one(user, { fields: [twoFactor.userId], references: [user.id] }),
}));

export const sessionRelations = relations(session, ({ one }) => ({
  user: one(user, { fields: [session.userId], references: [user.id] }),
}));

export const accountRelations = relations(account, ({ one }) => ({
  user: one(user, { fields: [account.userId], references: [user.id] }),
}));

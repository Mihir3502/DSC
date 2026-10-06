import { relations, sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  pgSchema,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

// Better Auth 1.7.7 core tables in the dedicated PostgreSQL `auth` schema.
// Generated from the pinned CLI (`auth generate`) and reviewed: library
// columns, indexes, unique constraints, and foreign keys are kept as
// generated; timestamps use `timestamptz` (DATA_MODEL §2.2); application-owned
// account fields and closed CHECK constraints are added on the single
// authoritative `auth.user` record (ADR-0002). Validated by
// `pnpm auth:schema:check`.

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
  },
  (table) => [index("session_userId_idx").on(table.userId)],
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

export const userRelations = relations(user, ({ many }) => ({
  sessions: many(session),
  accounts: many(account),
}));

export const sessionRelations = relations(session, ({ one }) => ({
  user: one(user, { fields: [session.userId], references: [user.id] }),
}));

export const accountRelations = relations(account, ({ one }) => ({
  user: one(user, { fields: [account.userId], references: [user.id] }),
}));

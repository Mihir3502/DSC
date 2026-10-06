import { jsonb, timestamp, varchar } from "drizzle-orm/pg-core";
import { appSchema } from "./app";

/**
 * Non-secret technical metadata confirming the database was initialized and
 * seeded by the expected application foundation. Not for business settings,
 * feature flags, secrets, or personal data. `updated_at` is set explicitly by
 * writers; there is no trigger.
 */
export const systemMetadata = appSchema.table("system_metadata", {
  key: varchar("key", { length: 100 }).primaryKey(),
  value: jsonb("value").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

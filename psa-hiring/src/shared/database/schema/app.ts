import { pgSchema } from "drizzle-orm/pg-core";

/** PostgreSQL schema for all application-owned tables (never `public`). */
export const appSchema = pgSchema("app");

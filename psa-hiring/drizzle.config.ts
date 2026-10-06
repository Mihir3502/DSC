import { defineConfig } from "drizzle-kit";

// Code-first migrations: the TypeScript schema plus the committed SQL and
// snapshots in ./drizzle are the source of truth. `drizzle-kit push` is not
// used in this project. Generate with `pnpm db:generate --name=<change>`,
// review the SQL, then apply with `pnpm db:migrate`.
//
// Only the migration identity is used here. There is deliberately no
// fallback to DATABASE_URL (the least-privileged runtime role). `generate`
// compares snapshots and does not need a connection.
const migrationUrl = process.env.DATABASE_MIGRATION_URL;

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/shared/database/schema/*.ts",
  out: "./drizzle",
  // Only the application schema belongs to this project's model.
  schemaFilter: ["app"],
  migrations: {
    schema: "drizzle",
    table: "__drizzle_migrations",
  },
  // One statement per breakpoint so each statement is reviewed and applied
  // separately; strict/verbose keep any interactive Kit command explicit.
  breakpoints: true,
  strict: true,
  verbose: true,
  ...(migrationUrl ? { dbCredentials: { url: migrationUrl } } : {}),
});

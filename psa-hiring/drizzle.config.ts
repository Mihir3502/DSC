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
  // Shared technical tables plus tables owned by business modules.
  schema: [
    "./src/shared/database/schema/*.ts",
    "./src/modules/*/infrastructure/*-schema.ts",
  ],
  out: "./drizzle",
  // Application tables (app), Better Auth tables (auth, ADR-0002), and the
  // append-only audit tables (audit, ADR-0012).
  schemaFilter: ["app", "auth", "audit"],
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

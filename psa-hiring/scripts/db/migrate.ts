import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { parseMigrationEnv } from "../../src/config/env-schema";
import {
  appliedMigrationCount,
  migrationJournal,
  migrationsFolder,
} from "./lib/migrations";
import { connectTool, runScript } from "./lib/tooling";

// Applies committed migrations from ./drizzle using DATABASE_MIGRATION_URL
// only. Never seeds and never falls back to the runtime DATABASE_URL.

void runScript("db:migrate", async () => {
  const env = parseMigrationEnv(process.env);
  const client = await connectTool({
    url: env.DATABASE_MIGRATION_URL,
    applicationName: "psa-hiring-migrator",
    timeoutMs: env.DATABASE_CONNECTION_TIMEOUT_MS,
  });
  try {
    const before = await appliedMigrationCount(client);
    await migrate(drizzle({ client }), {
      migrationsFolder,
      ...migrationJournal,
    });
    const after = await appliedMigrationCount(client);
    console.log(
      after > before
        ? `Applied ${after - before} migration(s); ${after} total.`
        : `No pending migrations; ${after} applied.`,
    );
  } finally {
    await client.end();
  }
});

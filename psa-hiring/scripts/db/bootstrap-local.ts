import {
  databaseUrlParts,
  parseLocalBootstrapEnv,
} from "../../src/config/env-schema";
import { applyLocalDatabaseGrants, ensureLocalRoles } from "./lib/local-roles";
import { connectTool, runScript } from "./lib/tooling";

// Idempotently creates the local migrator/application roles and grants.
// Local/test only. Uses DATABASE_ADMIN_URL; never drops anything.

void runScript("db:bootstrap:local", async () => {
  const env = parseLocalBootstrapEnv(process.env);
  const database = databaseUrlParts(env.DATABASE_ADMIN_URL).database;
  const admin = await connectTool({
    url: env.DATABASE_ADMIN_URL,
    applicationName: "psa-hiring-bootstrap",
    timeoutMs: env.DATABASE_CONNECTION_TIMEOUT_MS,
  });
  try {
    const report = [
      ...(await ensureLocalRoles(admin, env)),
      ...(await applyLocalDatabaseGrants(admin, database)),
    ];
    console.log("Local database bootstrap complete:");
    for (const line of report) console.log(`  - ${line}`);
  } finally {
    await admin.end();
  }
});

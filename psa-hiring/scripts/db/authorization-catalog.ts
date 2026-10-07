import { parseMigrationEnv } from "../../src/config/env-schema";
import { LogSecurityEvents } from "../../src/modules/identity-access/infrastructure/security-events";
import {
  AUTHORIZATION_POLICY_VERSION,
  authorizationCatalog,
} from "../../src/modules/identity-access/policy/authorization-catalog";
import { getServerEnv } from "../../src/config/server-env";
import { getLogger } from "../../src/shared/logging";
import {
  applyPlan,
  describePlan,
  planCatalog,
  planChanges,
  type Query,
} from "./lib/authorization-catalog";
import { CheckFailure, connectTool, runScript } from "./lib/tooling";

// `pnpm db:catalog:apply` — reviewed deployment step, run after
//   `pnpm db:migrate` with DATABASE_MIGRATION_URL (the migration role).
//   Never runs at application startup; the runtime role cannot write the
//   catalog tables at all.
// `pnpm db:catalog:check` — read-only drift check through the runtime role
//   (DATABASE_URL); fails if the database differs from the manifest.
// Neither creates users, assignments, organizations, or sessions.

const mode = process.argv[2];

void runScript(`db:catalog:${mode ?? "?"}`, async () => {
  if (mode === "check") {
    const env = getServerEnv();
    const reader = await connectTool({
      url: env.DATABASE_URL,
      applicationName: "psa-hiring-catalog-check",
      timeoutMs: env.DATABASE_CONNECTION_TIMEOUT_MS,
    });
    try {
      const query: Query = async (text, params) =>
        (await reader.query(text, params as unknown[])).rows;
      const plan = await planCatalog(query);
      const changes = planChanges(plan);
      if (plan.problems.length > 0 || changes > 0) {
        for (const problem of plan.problems) console.error(`drift ${problem}`);
        throw new CheckFailure(
          `authorization catalog v${authorizationCatalog.version} drift: ${describePlan(plan)}`,
        );
      }
      console.log(
        `Authorization catalog v${authorizationCatalog.version} matches (${describePlan(plan)}).`,
      );
    } finally {
      await reader.end();
    }
    return;
  }
  if (mode !== "apply")
    throw new Error("usage: authorization-catalog.ts apply|check");

  const env = parseMigrationEnv(process.env);
  const client = await connectTool({
    url: env.DATABASE_MIGRATION_URL,
    applicationName: "psa-hiring-catalog",
    timeoutMs: env.DATABASE_CONNECTION_TIMEOUT_MS,
  });
  const query: Query = async (text, params) =>
    (await client.query(text, params as unknown[])).rows;
  try {
    await client.query("BEGIN");
    // Serialize concurrent applies before reading the current state.
    await client.query(
      "LOCK TABLE auth.role, auth.permission, auth.role_permission IN SHARE ROW EXCLUSIVE MODE",
    );
    const plan = await planCatalog(query);
    if (plan.problems.length > 0) {
      for (const problem of plan.problems) console.error(`refused ${problem}`);
      throw new CheckFailure("authorization catalog not applied");
    }
    await applyPlan(query, plan, authorizationCatalog.version);
    await client.query("COMMIT");
    console.log(
      `Authorization catalog v${authorizationCatalog.version} applied: ${describePlan(plan)}.`,
    );
    if (planChanges(plan) > 0) {
      new LogSecurityEvents(getLogger()).record({
        code: "authz.catalog_applied",
        policyVersion: AUTHORIZATION_POLICY_VERSION,
      });
    }
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
});

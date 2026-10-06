import { randomBytes } from "node:crypto";
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import {
  HARNESS_LABEL,
  POSTGRES_TEST_IMAGE,
  type HarnessContext,
} from "./harness";

// Starts one disposable PostgreSQL container owned by a test run (shared by
// the Vitest integration setup and the Playwright database runner). Nothing
// here reads DATABASE_URL, DATABASE_MIGRATION_URL, or DATABASE_ADMIN_URL,
// and nothing touches the Compose database or volume. Credentials are
// random, test-only, and never printed.

/**
 * Publishes PostgreSQL on a random port bound to 127.0.0.1 only, matching the
 * loopback-only rule for local services (Testcontainers defaults to all
 * interfaces).
 */
class LoopbackPostgreSqlContainer extends PostgreSqlContainer {
  override async start(): Promise<StartedPostgreSqlContainer> {
    this.hostConfig.PortBindings = {
      ...this.hostConfig.PortBindings,
      "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: "0" }],
    };
    return super.start();
  }
}

export type OwnedContainer = {
  context: HarnessContext;
  stop: () => Promise<void>;
};

export async function startOwnedPostgres(): Promise<OwnedContainer> {
  const runId = randomBytes(4).toString("hex");
  const adminUser = `psa_test_admin_${runId}`;
  const adminPassword = `TEST_${randomBytes(18).toString("hex")}`;

  let container: StartedPostgreSqlContainer;
  try {
    container = await new LoopbackPostgreSqlContainer(POSTGRES_TEST_IMAGE)
      .withDatabase(`psa_test_bootstrap_${runId}`)
      .withUsername(adminUser)
      .withPassword(adminPassword)
      .withLabels({ [HARNESS_LABEL]: runId })
      // The module's default health check embeds the password; pg_isready
      // does not need one.
      .withHealthCheck({
        test: [
          "CMD-SHELL",
          'pg_isready --host localhost --username "$POSTGRES_USER"',
        ],
        interval: 250,
        timeout: 1000,
        retries: 400,
      })
      .start();
  } catch (error) {
    const reason = String((error as Error)?.message ?? error)
      .split("\n")[0]
      .replace(/postgres(ql)?:\/\/\S+/gi, "<redacted-url>");
    throw new Error(
      `Database tests need a running Docker engine to start ${POSTGRES_TEST_IMAGE}. ` +
        `Start Docker Desktop and retry. (${reason})`,
    );
  }

  const host =
    container.getHost() === "localhost" ? "127.0.0.1" : container.getHost();
  const context: HarnessContext = {
    runId,
    containerId: container.getId(),
    host,
    port: container.getPort(),
    adminUser,
    adminPassword,
    appPassword: `TEST_${randomBytes(18).toString("hex")}`,
    migratorPassword: `TEST_${randomBytes(18).toString("hex")}`,
  };
  return {
    context,
    stop: async () => {
      await container.stop({ remove: true, removeVolumes: true });
    },
  };
}

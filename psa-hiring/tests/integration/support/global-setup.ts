import type { TestProject } from "vitest/node";
import { startOwnedPostgres } from "./container";
import { POSTGRES_TEST_IMAGE, type HarnessContext } from "./harness";

// Starts one disposable PostgreSQL container owned by this test run (see
// container.ts) and provides its context to the integration test files.

declare module "vitest" {
  export interface ProvidedContext {
    postgres: HarnessContext;
  }
}

export default async function setup(project: TestProject) {
  const { context, stop } = await startOwnedPostgres();
  project.provide("postgres", context);
  console.log(
    `[integration] owned PostgreSQL container ${context.containerId.slice(0, 12)} ` +
      `(${POSTGRES_TEST_IMAGE}) on ${context.host}:${context.port}, run ${context.runId}`,
  );

  return async () => {
    await stop();
    console.log(
      `[integration] stopped and removed container ${context.containerId.slice(0, 12)}`,
    );
  };
}

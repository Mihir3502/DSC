import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { promisify } from "node:util";
import { Client } from "pg";

// Test-scoped access to the disposable PostgreSQL container started by
// global-setup.ts. Every URL is built from the provided context; developer
// environment variables are never consulted. Only databases created through
// this module (psa_test_<run>_*) may be dropped.

/** Same major version and image family as compose.yaml. */
export const POSTGRES_TEST_IMAGE = "postgres:18.6-trixie";
export const HARNESS_LABEL = "psa-hiring.test-harness-run";

export type HarnessContext = {
  runId: string;
  containerId: string;
  host: string;
  port: number;
  adminUser: string;
  adminPassword: string;
  appPassword: string;
  migratorPassword: string;
};

export type OwnedDatabase = {
  name: string;
  urls: { admin: string; migrator: string; app: string };
};

const projectRoot = path.resolve(import.meta.dirname, "../../..");
const ownedNames = new Set<string>();

function url(ctx: HarnessContext, user: string, password: string, db: string) {
  const u = new URL("postgresql://placeholder");
  u.username = user;
  u.password = password;
  u.hostname = ctx.host;
  u.port = String(ctx.port);
  u.pathname = `/${db}`;
  return u.toString();
}

function ownedNamePattern(ctx: HarnessContext) {
  return new RegExp(`^psa_test_${ctx.runId}_[a-z0-9_]{1,30}$`);
}

/** Opens an admin connection to a database inside the owned container. */
export async function adminClient(ctx: HarnessContext, database: string) {
  const client = new Client({
    connectionString: url(ctx, ctx.adminUser, ctx.adminPassword, database),
    application_name: "psa-test-harness",
    connectionTimeoutMillis: 10_000,
  });
  await client.connect();
  return client;
}

/** Creates a fresh, empty database owned by this test run. */
export async function createOwnedDatabase(
  ctx: HarnessContext,
  label: string,
): Promise<OwnedDatabase> {
  const name = `psa_test_${ctx.runId}_${label}_${randomBytes(3).toString("hex")}`;
  if (!ownedNamePattern(ctx).test(name)) {
    throw new Error(
      "refusing to create a database outside the owned naming scheme",
    );
  }
  const admin = await adminClient(ctx, "postgres");
  try {
    await admin.query(`CREATE DATABASE "${name}"`);
    ownedNames.add(name);
  } finally {
    await admin.end();
  }
  return {
    name,
    urls: {
      admin: url(ctx, ctx.adminUser, ctx.adminPassword, name),
      migrator: url(ctx, "psa_migrator", ctx.migratorPassword, name),
      app: url(ctx, "psa_app", ctx.appPassword, name),
    },
  };
}

/** Drops a database only if this module created it in the current run. */
export async function dropOwnedDatabase(ctx: HarnessContext, name: string) {
  if (!ownedNames.has(name) || !ownedNamePattern(ctx).test(name)) {
    throw new Error("refusing to drop a database this harness did not create");
  }
  const admin = await adminClient(ctx, "postgres");
  try {
    await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
    ownedNames.delete(name);
  } finally {
    await admin.end();
  }
}

/**
 * Environment for the real scripts and the real runtime client. Built from
 * scratch: nothing is inherited from process.env except PATH and HOME.
 */
export function buildHarnessEnv(
  db: OwnedDatabase,
): NodeJS.ProcessEnv & Record<string, string> {
  return {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    NODE_ENV: "test",
    APP_ENV: "test",
    DATABASE_URL: db.urls.app,
    DATABASE_MIGRATION_URL: db.urls.migrator,
    DATABASE_ADMIN_URL: db.urls.admin,
    DATABASE_POOL_MAX: "2",
    DATABASE_CONNECTION_TIMEOUT_MS: "10000",
    DATABASE_IDLE_TIMEOUT_MS: "10000",
    SMTP_HOST: "127.0.0.1",
    SMTP_PORT: "1025",
    SMTP_FROM: "test-sender@example.test",
    DOCUMENT_STORAGE_ROOT: "./.local/test-documents",
    PROVIDER_MODE: "fake",
    NEXT_TELEMETRY_DISABLED: "1",
  };
}

export type ScriptResult = { code: number; output: string };

const run = promisify(execFile);
const scripts = {
  bootstrap: { file: "scripts/db/bootstrap-local.ts", serverOnly: false },
  migrate: { file: "scripts/db/migrate.ts", serverOnly: false },
  seed: { file: "scripts/db/seed.ts", serverOnly: true },
  check: { file: "scripts/db/check.ts", serverOnly: true },
} as const;

/**
 * Runs a real M0.3 database script (the same files the pnpm db:* commands
 * run) against the owned database, with an explicit environment.
 */
export async function runDbScript(
  name: keyof typeof scripts,
  env: NodeJS.ProcessEnv,
): Promise<ScriptResult> {
  const { file, serverOnly } = scripts[name];
  const args = [...(serverOnly ? ["--conditions=react-server"] : []), file];
  try {
    const { stdout, stderr } = await run(
      path.join(projectRoot, "node_modules/.bin/tsx"),
      args,
      { cwd: projectRoot, env, timeout: 60_000 },
    );
    return { code: 0, output: `${stdout}${stderr}` };
  } catch (error) {
    const e = error as { code?: number; stdout?: string; stderr?: string };
    return {
      code: typeof e.code === "number" ? e.code : 1,
      output: `${e.stdout ?? ""}${e.stderr ?? ""}`,
    };
  }
}

/** Throws if output contains any harness password or connection URL. */
export function assertNoSecrets(ctx: HarnessContext, output: string) {
  for (const secret of [
    ctx.adminPassword,
    ctx.appPassword,
    ctx.migratorPassword,
  ]) {
    if (output.includes(secret))
      throw new Error("output leaked a harness password");
  }
  if (/postgres(ql)?:\/\/[^\s<]*@/i.test(output)) {
    throw new Error("output leaked a connection URL");
  }
}

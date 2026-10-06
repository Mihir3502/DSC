import "server-only";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { getServerEnv } from "@/config/server-env";
import * as schema from "./schema";

export type Database = NodePgDatabase<typeof schema>;

type DatabaseState = { pool: Pool; db: Database };

// Kept on globalThis so Next.js development hot reload reuses one pool
// instead of opening a new pool for every module reload.
const globalForDatabase = globalThis as typeof globalThis & {
  __psaDatabase?: DatabaseState;
};

/**
 * Returns the Drizzle client for the least-privileged runtime role
 * (DATABASE_URL). The pool is created lazily on first call, never at import
 * time, so static builds and browser bundles never open connections.
 */
export function getDatabase(): Database {
  globalForDatabase.__psaDatabase ??= createDatabase();
  return globalForDatabase.__psaDatabase.db;
}

/** Drains the pool. Call from scripts, tests, and process shutdown. */
export async function closeDatabasePool(): Promise<void> {
  const state = globalForDatabase.__psaDatabase;
  globalForDatabase.__psaDatabase = undefined;
  await state?.pool.end();
}

function createDatabase(): DatabaseState {
  const env = getServerEnv();
  const pool = new Pool({
    connectionString: env.DATABASE_URL,
    max: env.DATABASE_POOL_MAX,
    connectionTimeoutMillis: env.DATABASE_CONNECTION_TIMEOUT_MS,
    idleTimeoutMillis: env.DATABASE_IDLE_TIMEOUT_MS,
    application_name: "psa-hiring-app",
    // Every session uses UTC regardless of the server default.
    options: "-c TimeZone=UTC",
  });

  // Idle-client errors would otherwise crash the process. Report only safe
  // context; never the connection string. (Structured logging is M0.5.)
  pool.on("error", (error: Error & { code?: string }) => {
    console.error(
      `[database] idle client error${error.code ? ` (${error.code})` : ""}`,
    );
  });

  return { pool, db: drizzle({ client: pool, schema }) };
}

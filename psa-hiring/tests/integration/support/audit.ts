import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";
import {
  parseAuditKeyRing,
  verifyAuditIntegrity,
  type AuditKeyRing,
  type IntegrityReport,
} from "@/modules/audit";
import type { OwnedDatabase } from "./harness";

// Shared M1.6 audit test support (packet M1.6 §24, §26, ADR-0012).
// Synthetic data only. Helpers never print hashes, keys, or metadata.

/** The synthetic test key ring (APP_ENV=test, no configured keys). */
export const testKeys = (): AuditKeyRing =>
  parseAuditKeyRing({ APP_ENV: "test" });

/** A key ring whose signing always fails (forced audit-append failure). */
export function failingKeys(): AuditKeyRing {
  const keys = testKeys();
  return {
    ...keys,
    sign() {
      throw new Error("TEST forced integrity failure");
    },
  };
}

export async function connect(url: string): Promise<Client> {
  const client = new Client({
    connectionString: url,
    application_name: "psa-test-audit",
    connectionTimeoutMillis: 10_000,
  });
  client.on("error", () => undefined);
  await client.connect();
  return client;
}

/** Runs the read-only verifier as the migration identity. */
export async function verify(
  db: OwnedDatabase,
  keys: AuditKeyRing = testKeys(),
): Promise<IntegrityReport> {
  const client = await connect(db.urls.migrator);
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ, READ ONLY");
    const report = await verifyAuditIntegrity(drizzle({ client }), keys);
    await client.query("COMMIT");
    return report;
  } finally {
    await client.end();
  }
}

export async function waitForLockWait(
  admin: Client,
  minimum = 1,
): Promise<void> {
  for (let i = 0; i < 400; i += 1) {
    await admin.query("SELECT pg_stat_clear_snapshot()");
    const { rows } = await admin.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()",
    );
    if (rows[0]!.n >= minimum) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("competitor never blocked on the chain head");
}

export type AuditRow = Record<string, unknown> & {
  event_name: string;
  chain_partition: string;
  chain_sequence: string;
};

/** Audit rows touching an account as actor or target. */
export async function auditRowsFor(
  admin: Client,
  accountId: string,
): Promise<AuditRow[]> {
  const { rows } = await admin.query<AuditRow>(
    `SELECT * FROM audit.audit_event
     WHERE actor_user_id = $1 OR target_id = $1
     ORDER BY occurred_at, chain_sequence`,
    [accountId],
  );
  return rows;
}

export async function securityRowsFor(
  admin: Client,
  accountId: string,
): Promise<AuditRow[]> {
  const { rows } = await admin.query<AuditRow>(
    "SELECT * FROM audit.security_event WHERE account_id = $1 ORDER BY occurred_at, chain_sequence",
    [accountId],
  );
  return rows;
}

export async function countRows(
  admin: Client,
  table: "audit_event" | "security_event",
  where = "true",
  params: unknown[] = [],
): Promise<number> {
  const { rows } = await admin.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM audit.${table} WHERE ${where}`,
    params,
  );
  return rows[0]!.n;
}

/** Every audit/security row as text, for prohibited-data canary scans. */
export async function allAuditText(admin: Client): Promise<string> {
  const { rows } = await admin.query<{ t: string }>(
    `SELECT coalesce((SELECT string_agg(e::text, E'\\n') FROM audit.audit_event e), '')
         || coalesce((SELECT string_agg(s::text, E'\\n') FROM audit.security_event s), '') AS t`,
  );
  return rows[0]!.t;
}

export function sqlState(error: unknown): string | undefined {
  return (error as { code?: string } | undefined)?.code;
}

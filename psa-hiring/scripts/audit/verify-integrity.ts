import { drizzle } from "drizzle-orm/node-postgres";
import { parseMigrationEnv } from "../../src/config/env-schema";
import {
  createAuditRecorder,
  getAuditKeyRing,
  verifyAuditIntegrity,
  type IntegrityReport,
} from "../../src/modules/audit";
import { closeDatabasePool } from "../../src/shared/database";
import { getLogger } from "../../src/shared/logging";
import { connectTool, runScript } from "../db/lib/tooling";

// `pnpm audit:verify` — read-only audit integrity verification (packet
// M1.6 §12.3, ADR-0012). Reads every chain through the migration identity
// inside a READ ONLY, REPEATABLE READ transaction (the runtime role cannot
// see integrity columns by design) and checks sequence continuity,
// previous-hash links, keyed HMACs under each stored key version, and
// chain-head agreement.
//
// It never repairs, rewrites, rehashes, deletes, or prints metadata,
// hashes, or keys. Output: counts and, on failure, the first failing
// partition/sequence with a closed reason code. A failure exits nonzero,
// raises a high-severity alert, and appends one security event through
// the runtime append path (never touching existing rows).

void runScript("audit:verify", async () => {
  const env = parseMigrationEnv(process.env);
  const keys = getAuditKeyRing();
  const client = await connectTool({
    url: env.DATABASE_MIGRATION_URL,
    applicationName: "psa-hiring-audit-verify",
    timeoutMs: env.DATABASE_CONNECTION_TIMEOUT_MS,
  });
  let report: IntegrityReport;
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ, READ ONLY");
    report = await verifyAuditIntegrity(drizzle({ client }), keys);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }

  console.log(
    `audit:verify checked ${report.partitionsChecked} partition(s), ${report.rowsChecked} row(s).`,
  );
  if (report.ok) {
    console.log("audit:verify passed (integrity chains intact).");
    return;
  }
  const failure = report.failure!;
  console.error(
    `audit:verify FAILED: ${failure.reason} in ${failure.stream} partition ${failure.partition}` +
      (failure.sequence === null ? "" : ` at sequence ${failure.sequence}`),
  );
  getLogger().error("audit.integrity_verification_failed", {
    module: "audit",
    errorCode: "INTERNAL.UNEXPECTED",
    reasonCode: failure.reason,
  });
  try {
    await createAuditRecorder({ source: "SYSTEM" }).record({
      code: "audit.integrity_verification_failed",
      reasonCode: failure.reason,
    });
  } finally {
    await closeDatabasePool();
  }
  process.exitCode = 1;
});

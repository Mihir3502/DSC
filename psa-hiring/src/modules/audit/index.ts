// Public API of the audit module (ARCHITECTURE §6, §12; ADR-0012). Other
// modules and scripts import only from here. Server-only.
//
// There is deliberately no update, delete, repair, rehash, export, or
// generic append(name, payload) operation in this API.
import "server-only";
import { getDatabase, type Database } from "@/shared/database";
import { getLogger, type AppLogger } from "@/shared/logging";
import type { EventSource } from "./domain/vocabulary";
import { AuditRecorder } from "./application/audit-recorder";
import { checkAuditReadiness } from "./infrastructure/audit-readiness";
import {
  getAuditKeyRing,
  type AuditKeyRing,
} from "./infrastructure/hmac-key-ring";

export {
  AuditRecorder,
  AuditWriteError,
  withAuditedTransaction,
  inAuditedTransaction,
  requireRecorded,
  type AuditedTransactionDependencies,
  type EventRecorder,
  type TransactionAudit,
} from "./application/audit-recorder";
export {
  methodCategories,
  securityCategories,
  systemActors,
  type AuditFacts,
  type EffectiveAuthority,
  type MethodCategory,
  type SecurityCategory,
  type SystemActor,
} from "./application/audit-facts";
export {
  catalogEventNames,
  eventCatalog,
  findEventDefinition,
  type CatalogEventName,
  type EventDefinition,
} from "./application/event-catalog";
export {
  auditQueryPermissionFor,
  noRecordGroups,
  queryAuditEvents,
  type AuditQueryAuthorization,
  type AuditQueryAuthorizer,
  type AuditQueryDependencies,
  type AuditQueryInput,
  type AuditQueryPrincipal,
  type AuditQueryResult,
  type AuditQueryScope,
  type AuditRecordGroupResolver,
} from "./application/query-audit-events";
export {
  verifyAuditIntegrity,
  type IntegrityReport,
} from "./application/verify-audit-integrity";
export { type AuditEventView } from "./presentation/audit-event-view-model";
export {
  getAuditKeyRing,
  parseAuditKeyRing,
  type AuditKeyRing,
} from "./infrastructure/hmac-key-ring";
export { checkAuditReadiness };
export type { SqlExecutor } from "./infrastructure/audit-store";

/** The event source for this process: LOCAL_TEST under APP_ENV=test. */
export function defaultEventSource(appEnv: string | undefined): EventSource {
  return appEnv === "test" ? "LOCAL_TEST" : "WEB";
}

export function createAuditRecorder(
  options: {
    db?: Database;
    logger?: AppLogger;
    keys?: AuditKeyRing;
    source?: EventSource;
  } = {},
): AuditRecorder {
  return new AuditRecorder({
    db: options.db ?? getDatabase(),
    logger: options.logger ?? getLogger(),
    keys: options.keys ?? getAuditKeyRing(),
    source: options.source ?? defaultEventSource(process.env.APP_ENV),
  });
}

/**
 * Production-like startup gate (packet M1.6 §19, AC-M1.6-14): refuses to
 * start without a valid integrity key ring, or when the runtime identity
 * owns audit objects, holds write privileges on them, or append-only
 * triggers are missing or disabled. Errors carry closed codes only.
 */
export async function assertAuditReadiness(
  db: Database = getDatabase(),
  logger: AppLogger = getLogger(),
): Promise<void> {
  try {
    getAuditKeyRing();
  } catch (error) {
    logger.error("audit.config_rejected", {
      module: "audit",
      errorCode: "DEPENDENCY.UNAVAILABLE",
      reasonCode: "INTEGRITY_KEYS_INVALID",
    });
    throw error;
  }
  const problems = await checkAuditReadiness(db);
  if (problems.length > 0) {
    for (const problem of problems) {
      logger.error("audit.config_rejected", {
        module: "audit",
        errorCode: "DEPENDENCY.UNAVAILABLE",
        reasonCode: problem,
      });
    }
    throw new Error(`audit readiness check failed: ${problems.join(", ")}`);
  }
}

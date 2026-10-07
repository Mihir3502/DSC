import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Database } from "@/shared/database";
import { pgErrorCode } from "@/shared/database/errors";
import { DependencyError } from "@/shared/errors";
import type { AppLogger } from "@/shared/logging";
import { canonicalize, type ChainLink } from "../domain/envelope";
import { chainPartitionFor } from "../domain/integrity-chain";
import {
  CANONICALIZATION_VERSION,
  type EventSource,
} from "../domain/vocabulary";
import {
  appendAuditRow,
  appendSecurityRow,
  claimChainHead,
  type SqlExecutor,
} from "../infrastructure/audit-store";
import type { AuditKeyRing } from "../infrastructure/hmac-key-ring";
import { findEventDefinition } from "./event-catalog";
import {
  AuditValidationError,
  prepareEvent,
  type AuditFacts,
  type PreparedEvent,
} from "./audit-facts";

// Durable event recorder and the one shared audited-transaction boundary
// (packet M1.6 §13, §14, ADR-0012).
//
// - recordInTransaction: validate → lock the partition head → HMAC → append
//   through the reviewed function, all on the caller's transaction. Any
//   failure throws AuditWriteError, so the caller's mutation rolls back.
// - record: a bounded standalone transaction for required denials,
//   failures, reads, and provider-committed changes. It never throws; it
//   returns false (and raises a safe alert) when a required append failed,
//   so callers can withhold success. A denial stays a denial either way.
// - Inside withAuditedTransaction, standalone records are deferred until
//   the transaction settles: a denial raised during a rolled-back command
//   is still recorded, never commits into the business transaction, and
//   can never wait on a chain head the same command already holds.
//
// No payload is ever written to logs as a fallback, and nothing is
// buffered beyond the current command.

export interface EventRecorder {
  record(facts: AuditFacts): Promise<boolean>;
  recordInTransaction(tx: SqlExecutor, facts: AuditFacts): Promise<void>;
}

/** Required audit evidence could not be written; the command must fail. */
export class AuditWriteError extends DependencyError {
  constructor(readonly reason: string) {
    super();
    this.name = "AuditWriteError";
  }
}

export type AuditRecorderDependencies = Readonly<{
  db: Database;
  logger: AppLogger;
  keys: AuditKeyRing;
  source: EventSource;
}>;

type Scope = { deferred: (() => Promise<unknown>)[] };
const transactionScope = new AsyncLocalStorage<Scope>();

const STANDALONE_LOCK_TIMEOUT = "2s";
const STANDALONE_STATEMENT_TIMEOUT = "5s";

export class AuditRecorder implements EventRecorder {
  private readonly logger: AppLogger;

  constructor(private readonly deps: AuditRecorderDependencies) {
    this.logger = deps.logger.child({ module: "audit" });
  }

  async recordInTransaction(tx: SqlExecutor, facts: AuditFacts): Promise<void> {
    const prepared = this.prepare(facts);
    if (!prepared) throw new AuditWriteError("INVALID_EVENT");
    if (prepared.kind === "TELEMETRY") return this.telemetry(facts);
    const { atomicity } = prepared.definition;
    if (atomicity !== "IN_TRANSACTION" && atomicity !== "PROVIDER_COMMITTED") {
      this.alert(facts.code, "WRONG_BOUNDARY");
      throw new AuditWriteError("WRONG_BOUNDARY");
    }
    try {
      await this.append(tx, prepared);
    } catch (error) {
      // Serialization failures and deadlocks propagate unchanged so the
      // enclosing withAuditedTransaction can retry the whole transaction.
      const code = pgErrorCode(error);
      if (code && retryable.has(code)) throw error;
      this.alert(facts.code, failureReason(error));
      throw new AuditWriteError(failureReason(error));
    }
  }

  async record(facts: AuditFacts): Promise<boolean> {
    const prepared = this.prepare(facts);
    if (!prepared) return false;
    if (prepared.kind === "TELEMETRY") {
      this.telemetry(facts);
      return true;
    }
    if (prepared.definition.atomicity === "IN_TRANSACTION") {
      // A state change's event must share its transaction.
      this.alert(facts.code, "WRONG_BOUNDARY");
      return false;
    }
    const scope = transactionScope.getStore();
    if (scope) {
      scope.deferred.push(() => this.appendStandalone(prepared, facts));
      return true;
    }
    return this.appendStandalone(prepared, facts);
  }

  private async appendStandalone(
    prepared: Exclude<PreparedEvent, { kind: "TELEMETRY" }>,
    facts: AuditFacts,
  ): Promise<boolean> {
    try {
      await this.deps.db.transaction(async (tx) => {
        await tx.execute(
          sql.raw(`SET LOCAL lock_timeout = '${STANDALONE_LOCK_TIMEOUT}'`),
        );
        await tx.execute(
          sql.raw(
            `SET LOCAL statement_timeout = '${STANDALONE_STATEMENT_TIMEOUT}'`,
          ),
        );
        await this.append(tx, prepared);
      });
      return true;
    } catch (error) {
      this.alert(facts.code, failureReason(error));
      return false;
    }
  }

  private async append(
    tx: SqlExecutor,
    prepared: Exclude<PreparedEvent, { kind: "TELEMETRY" }>,
  ): Promise<void> {
    const partition = chainPartitionFor(
      prepared.kind,
      prepared.kind === "AUDIT" ? prepared.envelope.organizationId : null,
      prepared.subjectId,
    );
    const head = await claimChainHead(tx, partition);
    const link: ChainLink = {
      chainPartition: partition,
      chainSequence: head.nextSequence,
      previousHash: head.previousHash,
      integrityKeyVersion: this.deps.keys.activeVersion,
      canonicalizationVersion: CANONICALIZATION_VERSION,
    };
    if (prepared.kind === "AUDIT") {
      const envelope = { ...prepared.envelope, occurredAt: head.occurredAt };
      const hash = this.deps.keys.sign(
        link.integrityKeyVersion,
        canonicalize("AUDIT", envelope, link),
      );
      await appendAuditRow(tx, envelope, link, hash);
    } else {
      const envelope = { ...prepared.envelope, occurredAt: head.occurredAt };
      const hash = this.deps.keys.sign(
        link.integrityKeyVersion,
        canonicalize("SECURITY", envelope, link),
      );
      await appendSecurityRow(tx, envelope, link, hash);
    }
  }

  private prepare(facts: AuditFacts): PreparedEvent | null {
    try {
      return prepareEvent(facts, {
        source: this.deps.source,
        requestId: randomUUID(),
        eventId: randomUUID(),
      });
    } catch (error) {
      this.alert(
        typeof facts?.code === "string" ? facts.code : undefined,
        error instanceof AuditValidationError ? error.reason : "INVALID_EVENT",
      );
      return null;
    }
  }

  /** Approved routine signal: one allowlisted log line, never durable. */
  private telemetry(facts: AuditFacts): void {
    this.logger.info(facts.code, {
      eventCode: facts.code,
      resultCode: facts.category ?? "ok",
      actorRef: facts.accountRef?.replaceAll("-", ""),
      recordRef: facts.recordRef?.replaceAll("-", ""),
      action: facts.permissionCode,
      reasonCode: facts.reasonCode,
      policyVersion: facts.policyVersion,
      correlationId: facts.correlationId,
    });
  }

  /** High-severity safe operational signal: codes only, never payloads. */
  private alert(eventName: string | undefined, reason: string): void {
    this.logger.error("audit.write_failed", {
      // Only a registered name is echoed; unknown input never reaches logs.
      action:
        eventName && findEventDefinition(eventName) ? eventName : undefined,
      errorCode: "DEPENDENCY.UNAVAILABLE",
      reasonCode: reason,
    });
  }
}

function failureReason(error: unknown): string {
  if (error instanceof AuditValidationError) return error.reason;
  const code = pgErrorCode(error);
  if (code === "AU001") return "CHAIN_HEAD_MISMATCH";
  if (code === "55P03" || code === "57014") return "TIMEOUT";
  if (code?.startsWith("23")) return "CONSTRAINT_REJECTED";
  if (code === "42501") return "PRIVILEGE_DENIED";
  return code ? "DATABASE_FAILURE" : "WRITE_FAILURE";
}

/**
 * Records an event whose state change a provider (Better Auth) has already
 * committed outside any application transaction (catalog atomicity
 * PROVIDER_COMMITTED; ADR-0012 §5). This is NOT atomic. If the durable
 * append fails, the optional compensation runs (for example deleting the
 * session a sign-in just created), and AuditWriteError is thrown so the
 * caller reports a generic failure instead of success.
 */
export async function requireRecorded(
  events: EventRecorder,
  facts: AuditFacts,
  compensate?: () => Promise<unknown>,
): Promise<void> {
  if (await events.record(facts)) return;
  if (compensate) await compensate().catch(() => undefined);
  throw new AuditWriteError("PROVIDER_COMMITTED_UNRECORDED");
}

// ---------------------------------------------------------------------

export type TransactionAudit = Readonly<{
  /** Appends a required event inside this transaction. */
  append(facts: AuditFacts): Promise<void>;
}>;

export type AuditedTransactionDependencies = Readonly<{
  db: Database;
  events: EventRecorder;
}>;

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

const MAX_ATTEMPTS = 3;
const retryable = new Set(["40001", "40P01"]);

/**
 * The single transaction boundary for compliance-significant mutations:
 *
 *   withAuditedTransaction(deps, async (tx, audit) => {
 *     recheck authorization on tx; mutate on tx; await audit.append(...);
 *     return safeResult;
 *   })
 *
 * Every repository and the audit append share `tx`. The result is returned
 * only after the transaction commits; if the mutation, the audit append,
 * or the commit fails, both roll back and the error propagates. Only
 * serialization failures and deadlocks are retried, at most twice, around
 * the complete transaction (authorization and version checks rerun).
 */
export async function withAuditedTransaction<T>(
  deps: AuditedTransactionDependencies,
  body: (tx: Transaction, audit: TransactionAudit) => Promise<T>,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    const scope: Scope = { deferred: [] };
    try {
      const result = await transactionScope.run(scope, () =>
        deps.db.transaction((tx) =>
          body(tx, {
            append: (facts) => deps.events.recordInTransaction(tx, facts),
          }),
        ),
      );
      await flushDeferred(scope);
      return result;
    } catch (error) {
      await flushDeferred(scope);
      const code = pgErrorCode(error);
      if (code && retryable.has(code) && attempt < MAX_ATTEMPTS) continue;
      throw error;
    }
  }
}

/** Appends, in order, the standalone events deferred by this command. */
async function flushDeferred(scope: Scope) {
  for (const append of scope.deferred.splice(0)) await append();
}

/** True while running inside withAuditedTransaction (tests, diagnostics). */
export function inAuditedTransaction(): boolean {
  return transactionScope.getStore() !== undefined;
}

import "server-only";
import {
  createAuditRecorder,
  withAuditedTransaction,
  type EventRecorder,
} from "@/modules/audit";
import { getDatabase, type Database } from "@/shared/database";
import { ConflictError, NotFoundError } from "@/shared/errors";
import { getLogger, getRequestContext, type AppLogger } from "@/shared/logging";
import { decideRestriction } from "../domain/account-policy";
import { reasonCodeFor, type RestrictedStatus } from "../domain/account-types";
import {
  applyRestriction,
  deleteAllSessions,
  deleteOwnedSession,
  lockAccountForUpdate,
} from "../infrastructure/account-repository";

// Server-side revocation and restriction primitives (packet M1.1 §11). No
// route or UI exposes them yet; caller authorization arrives in M1.4/M1.5.
//
// Atomicity: the status change and session deletion run in one PostgreSQL
// transaction on the runtime connection, with the account row locked
// (SELECT … FOR UPDATE). Better Auth stores sessions only in the database
// (no secondary storage, no cookie cache), so a committed restriction is
// authoritative for every later session lookup.
//
// Audit (M1.6, ADR-0012): each applied restriction or revocation appends
// its event inside the same transaction, with a SYSTEM actor until an
// authorized administration surface exists.

export type RestrictionResult = Readonly<{
  resultCode:
    | "SESSION_REVOKED"
    | "SESSION_NOT_FOUND"
    | "SESSIONS_REVOKED"
    | "ACCOUNT_RESTRICTED"
    | "ALREADY_RESTRICTED";
  /** Opaque account reference for future audit; never an email. */
  accountRef: string;
  status?: RestrictedStatus;
  sessionsRevoked: number;
}>;

export type RestrictionDependencies = {
  db: Database;
  logger: AppLogger;
  /** Durable recorder; defaults to one bound to `db`. */
  events?: EventRecorder;
};

function defaults(): RestrictionDependencies {
  return { db: getDatabase(), logger: getLogger() };
}

function audited(deps: RestrictionDependencies) {
  return {
    db: deps.db,
    events:
      deps.events ?? createAuditRecorder({ db: deps.db, logger: deps.logger }),
  };
}

function logger(deps: RestrictionDependencies) {
  return deps.logger.child({
    module: "identity-access",
    correlationId: getRequestContext()?.correlationId,
  });
}

/** Revokes one session owned by the account. Idempotent. */
export async function revokeSession(
  accountId: string,
  sessionId: string,
  deps: RestrictionDependencies = defaults(),
): Promise<RestrictionResult> {
  const revoked = await withAuditedTransaction(
    audited(deps),
    async (tx, audit) => {
      const account = await lockAccountForUpdate(tx, accountId);
      if (!account) throw new NotFoundError();
      const count = await deleteOwnedSession(tx, accountId, sessionId);
      if (count > 0) {
        await audit.append({
          code: "account.sessions_revoked_by_system",
          accountRef: accountId,
          systemActor: "SYSTEM_PROCESS",
          count,
        });
      }
      return count;
    },
  );
  const result = Object.freeze({
    resultCode:
      revoked > 0
        ? ("SESSION_REVOKED" as const)
        : ("SESSION_NOT_FOUND" as const),
    accountRef: accountId,
    sessionsRevoked: revoked,
  });
  logger(deps).info("account.session_revoke", {
    recordRef: accountId,
    resultCode: result.resultCode.toLowerCase(),
  });
  return result;
}

/** Revokes every session of the account. Idempotent. */
export async function revokeAllSessions(
  accountId: string,
  deps: RestrictionDependencies = defaults(),
): Promise<RestrictionResult> {
  const revoked = await withAuditedTransaction(
    audited(deps),
    async (tx, audit) => {
      const account = await lockAccountForUpdate(tx, accountId);
      if (!account) throw new NotFoundError();
      const count = await deleteAllSessions(tx, accountId);
      await audit.append({
        code: "account.sessions_revoked_by_system",
        accountRef: accountId,
        systemActor: "SYSTEM_PROCESS",
        count,
      });
      return count;
    },
  );
  logger(deps).info("account.sessions_revoke_all", {
    recordRef: accountId,
    resultCode: "sessions_revoked",
  });
  return Object.freeze({
    resultCode: "SESSIONS_REVOKED",
    accountRef: accountId,
    sessionsRevoked: revoked,
  });
}

async function restrict(
  accountId: string,
  target: RestrictedStatus,
  expectedVersion: number | undefined,
  deps: RestrictionDependencies,
): Promise<RestrictionResult> {
  const outcome = await withAuditedTransaction(
    audited(deps),
    async (tx, audit) => {
      const account = await lockAccountForUpdate(tx, accountId);
      if (!account) throw new NotFoundError();
      if (
        expectedVersion !== undefined &&
        account.version !== expectedVersion
      ) {
        throw new ConflictError();
      }
      const decision = decideRestriction(account.status, target);
      if (decision.kind === "not-allowed") throw new ConflictError();
      if (decision.kind === "apply") {
        await applyRestriction(
          tx,
          accountId,
          target,
          reasonCodeFor[target],
          new Date(),
        );
      }
      // Always clear sessions, so a retry also repairs any session created by
      // a racing request before the lock was taken.
      const revoked = await deleteAllSessions(tx, accountId);
      if (decision.kind === "apply") {
        await audit.append({
          code: "account.restricted",
          accountRef: accountId,
          systemActor: "SYSTEM_PROCESS",
          reasonCode: reasonCodeFor[target],
          previousVersion: account.version,
          newVersion: account.version + 1,
          count: revoked,
        });
      } else if (revoked > 0) {
        await audit.append({
          code: "account.sessions_revoked_by_system",
          accountRef: accountId,
          systemActor: "SYSTEM_PROCESS",
          count: revoked,
        });
      }
      return { applied: decision.kind === "apply", revoked };
    },
  );
  const result = Object.freeze({
    resultCode: outcome.applied
      ? ("ACCOUNT_RESTRICTED" as const)
      : ("ALREADY_RESTRICTED" as const),
    accountRef: accountId,
    status: target,
    sessionsRevoked: outcome.revoked,
  });
  logger(deps).warn("account.restricted", {
    recordRef: accountId,
    resultCode: `${target.toLowerCase()}_${outcome.applied ? "applied" : "unchanged"}`,
  });
  return result;
}

export const lockAccount = (
  accountId: string,
  expectedVersion?: number,
  deps = defaults(),
) => restrict(accountId, "LOCKED", expectedVersion, deps);

export const disableAccount = (
  accountId: string,
  expectedVersion?: number,
  deps = defaults(),
) => restrict(accountId, "DISABLED", expectedVersion, deps);

export const closeAccount = (
  accountId: string,
  expectedVersion?: number,
  deps = defaults(),
) => restrict(accountId, "CLOSED", expectedVersion, deps);

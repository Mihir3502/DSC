import "server-only";
import { and, eq, gt, sql } from "drizzle-orm";
import type { Database } from "@/shared/database";
import {
  isAccountStatus,
  isAccountType,
  type AccountStatus,
  type AccountType,
  type RestrictedStatus,
  type RestrictionReasonCode,
} from "../domain/account-types";
import { session, user } from "./auth-schema";

// Authoritative account/session data access for the identity-access module.
// Runs on the least-privileged runtime connection (DATABASE_URL). Returns
// only the minimal fields callers need; never credentials or tokens.

export type AccountRecord = Readonly<{
  id: string;
  accountType: AccountType;
  status: AccountStatus;
  emailVerified: boolean;
  version: number;
}>;

type Executor = Pick<Database, "select" | "update" | "delete">;

function toRecord(row: {
  id: string;
  accountType: string;
  status: string;
  emailVerified: boolean;
  version: number;
}): AccountRecord | null {
  // Database CHECK constraints make these always valid; fail closed anyway.
  if (!isAccountType(row.accountType) || !isAccountStatus(row.status))
    return null;
  return Object.freeze({
    id: row.id,
    accountType: row.accountType,
    status: row.status,
    emailVerified: row.emailVerified,
    version: row.version,
  });
}

const accountColumns = {
  id: user.id,
  accountType: user.accountType,
  status: user.status,
  emailVerified: user.emailVerified,
  version: user.version,
};

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Loads current account state, or null for unknown/malformed IDs. */
export async function findAccountById(
  db: Executor,
  accountId: string,
): Promise<AccountRecord | null> {
  if (!uuidPattern.test(accountId)) return null;
  const [row] = await db
    .select(accountColumns)
    .from(user)
    .where(eq(user.id, accountId))
    .limit(1);
  return row ? toRecord(row) : null;
}

/** Same as findAccountById but locks the row inside a transaction. */
export async function lockAccountForUpdate(
  tx: Executor,
  accountId: string,
): Promise<AccountRecord | null> {
  if (!uuidPattern.test(accountId)) return null;
  const [row] = await tx
    .select(accountColumns)
    .from(user)
    .where(eq(user.id, accountId))
    .for("update")
    .limit(1);
  return row ? toRecord(row) : null;
}

export async function recordAuthentication(
  db: Executor,
  accountId: string,
  at: Date,
) {
  await db
    .update(user)
    .set({ lastAuthenticatedAt: at })
    .where(eq(user.id, accountId));
}

export async function applyRestriction(
  tx: Executor,
  accountId: string,
  status: RestrictedStatus,
  reasonCode: RestrictionReasonCode,
  at: Date,
): Promise<void> {
  await tx
    .update(user)
    .set({
      status,
      disabledAt: at,
      disabledReasonCode: reasonCode,
      version: sql`${user.version} + 1`,
      updatedAt: at,
    })
    .where(eq(user.id, accountId));
}

/** Deletes every session of an account; returns how many were revoked. */
export async function deleteAllSessions(
  tx: Executor,
  accountId: string,
): Promise<number> {
  const deleted = await tx
    .delete(session)
    .where(eq(session.userId, accountId))
    .returning({ id: session.id });
  return deleted.length;
}

/** Deletes one session only if it belongs to the account. */
export async function deleteOwnedSession(
  tx: Executor,
  accountId: string,
  sessionId: string,
): Promise<number> {
  if (!uuidPattern.test(sessionId)) return 0;
  const deleted = await tx
    .delete(session)
    .where(and(eq(session.id, sessionId), eq(session.userId, accountId)))
    .returning({ id: session.id });
  return deleted.length;
}

/** Counts unexpired sessions for an account (diagnostics/tests). */
export async function countActiveSessions(
  db: Executor,
  accountId: string,
): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(session)
    .where(
      and(eq(session.userId, accountId), gt(session.expiresAt, new Date())),
    );
  return row?.n ?? 0;
}

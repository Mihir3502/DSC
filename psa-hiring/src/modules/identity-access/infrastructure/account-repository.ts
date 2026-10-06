import "server-only";
import { and, desc, eq, gt, inArray, ne, sql } from "drizzle-orm";
import type { Database } from "@/shared/database";
import {
  isAccountStatus,
  isAccountType,
  type AccountStatus,
  type AccountType,
  type RestrictedStatus,
  type RestrictionReasonCode,
} from "../domain/account-types";
import { account, session, user } from "./auth-schema";

// Authoritative account/session data access for the identity-access module.
// Runs on the least-privileged runtime connection (DATABASE_URL). Returns
// only the minimal fields callers need; never credentials or tokens.

export type AccountRecord = Readonly<{
  id: string;
  accountType: AccountType;
  status: AccountStatus;
  emailVerified: boolean;
  /** Better Auth two-factor flag (verified TOTP enrollment exists). */
  twoFactorEnabled: boolean;
  version: number;
}>;

type Executor = Pick<Database, "select" | "update" | "delete" | "insert">;

function toRecord(row: {
  id: string;
  accountType: string;
  status: string;
  emailVerified: boolean;
  twoFactorEnabled: boolean;
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
    twoFactorEnabled: row.twoFactorEnabled,
    version: row.version,
  });
}

const accountColumns = {
  id: user.id,
  accountType: user.accountType,
  status: user.status,
  emailVerified: user.emailVerified,
  twoFactorEnabled: user.twoFactorEnabled,
  version: user.version,
};

export const uuidPattern =
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

/** Loads current account state by normalized login email. */
export async function findAccountByEmail(
  db: Executor,
  normalizedEmail: string,
): Promise<AccountRecord | null> {
  const [row] = await db
    .select(accountColumns)
    .from(user)
    .where(eq(user.email, normalizedEmail))
    .limit(1);
  return row ? toRecord(row) : null;
}

/** The normalized login email of an account (owner-facing display only). */
export async function findAccountEmail(
  db: Executor,
  accountId: string,
): Promise<string | null> {
  if (!uuidPattern.test(accountId)) return null;
  const [row] = await db
    .select({ email: user.email })
    .from(user)
    .where(eq(user.id, accountId))
    .limit(1);
  return row?.email ?? null;
}

/**
 * Creates an INVITED, unverified CANDIDATE account and its credential in one
 * transaction (packet M1.2 §6.1). Type, status, and verification are fixed
 * here, never taken from input. The password hash comes from Better Auth's
 * maintained hasher. Returns null, without error, when the normalized email
 * already exists (including a concurrent insert), so callers can respond
 * generically.
 */
export async function createCandidateWithCredential(
  db: Database,
  input: { email: string; emailDisplay: string; passwordHash: string },
): Promise<string | null> {
  return db.transaction(async (tx) => {
    const now = new Date();
    const [created] = await tx
      .insert(user)
      .values({
        name: "Candidate",
        email: input.email,
        emailDisplay: input.emailDisplay,
        emailVerified: false,
        accountType: "CANDIDATE",
        status: "INVITED",
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing({ target: user.email })
      .returning({ id: user.id });
    if (!created) return null;
    await tx.insert(account).values({
      accountId: created.id,
      providerId: "credential",
      userId: created.id,
      password: input.passwordHash,
      createdAt: now,
      updatedAt: now,
    });
    return created.id;
  });
}

/**
 * The approved INVITED → ACTIVE transition for a candidate whose email is
 * verified. A single conditional UPDATE, so it can never overwrite a
 * concurrent restriction (LOCKED/DISABLED/CLOSED) and is idempotent.
 */
export async function activateVerifiedCandidate(
  db: Executor,
  accountId: string,
): Promise<boolean> {
  if (!uuidPattern.test(accountId)) return false;
  const updated = await db
    .update(user)
    .set({ status: "ACTIVE", version: sql`${user.version} + 1` })
    .where(
      and(
        eq(user.id, accountId),
        eq(user.accountType, "CANDIDATE"),
        eq(user.status, "INVITED"),
        eq(user.emailVerified, true),
      ),
    )
    .returning({ id: user.id });
  return updated.length === 1;
}

export type SessionSummaryRow = Readonly<{
  id: string;
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date;
  userAgent: string | null;
}>;

/** Unexpired sessions of one account, newest first; never tokens. */
export async function listActiveSessions(
  db: Executor,
  accountId: string,
): Promise<SessionSummaryRow[]> {
  if (!uuidPattern.test(accountId)) return [];
  return db
    .select({
      id: session.id,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      expiresAt: session.expiresAt,
      userAgent: session.userAgent,
    })
    .from(session)
    .where(
      and(eq(session.userId, accountId), gt(session.expiresAt, new Date())),
    )
    .orderBy(desc(session.createdAt));
}

/** Deletes every session of an account except one; returns the count. */
export async function deleteSessionsExcept(
  tx: Executor,
  accountId: string,
  keepSessionId: string,
): Promise<number> {
  const deleted = await tx
    .delete(session)
    .where(and(eq(session.userId, accountId), ne(session.id, keepSessionId)))
    .returning({ id: session.id });
  return deleted.length;
}

// ---------------------------------------------------------------------------
// Staff accounts (packet M1.3 §9, §14). Type, status, and verification are
// fixed here, never taken from input; password hashes come from Better
// Auth's maintained hasher.
// ---------------------------------------------------------------------------

/**
 * Creates the single INVITED STAFF account for an accepted invitation
 * proof (email ownership verified by the emailed capability) together with
 * its credential. Returns null when the normalized email already exists.
 */
export async function createInvitedStaffWithCredential(
  tx: Executor,
  input: { email: string; emailDisplay: string; passwordHash: string },
  now: Date,
): Promise<string | null> {
  const [created] = await tx
    .insert(user)
    .values({
      name: "Staff member",
      email: input.email,
      emailDisplay: input.emailDisplay,
      emailVerified: true,
      accountType: "STAFF",
      status: "INVITED",
      twoFactorEnabled: false,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing({ target: user.email })
    .returning({ id: user.id });
  if (!created) return null;
  await tx.insert(account).values({
    accountId: created.id,
    providerId: "credential",
    userId: created.id,
    password: input.passwordHash,
    createdAt: now,
    updatedAt: now,
  });
  return created.id;
}

/**
 * Replaces the credential of an INVITED staff account resuming activation
 * or reenrolling after an approved reset (creates it if missing).
 */
export async function replaceInvitedStaffCredential(
  tx: Executor,
  accountId: string,
  passwordHash: string,
  now: Date,
): Promise<void> {
  const updated = await tx
    .update(account)
    .set({ password: passwordHash, updatedAt: now })
    .where(
      and(eq(account.userId, accountId), eq(account.providerId, "credential")),
    )
    .returning({ id: account.id });
  if (updated.length === 0) {
    await tx.insert(account).values({
      accountId,
      providerId: "credential",
      userId: accountId,
      password: passwordHash,
      createdAt: now,
      updatedAt: now,
    });
  }
  await tx
    .update(user)
    .set({ emailVerified: true, updatedAt: now })
    .where(
      and(
        eq(user.id, accountId),
        eq(user.accountType, "STAFF"),
        eq(user.status, "INVITED"),
      ),
    );
}

/**
 * INVITED → ACTIVE for a staff account only after verified MFA enrollment.
 * A single conditional UPDATE: it can never overwrite a concurrent
 * restriction and succeeds at most once.
 */
export async function activateEnrolledStaff(
  tx: Executor,
  accountId: string,
  now: Date,
): Promise<boolean> {
  if (!uuidPattern.test(accountId)) return false;
  const updated = await tx
    .update(user)
    .set({
      status: "ACTIVE",
      version: sql`${user.version} + 1`,
      updatedAt: now,
    })
    .where(
      and(
        eq(user.id, accountId),
        eq(user.accountType, "STAFF"),
        eq(user.status, "INVITED"),
        eq(user.emailVerified, true),
        eq(user.twoFactorEnabled, true),
      ),
    )
    .returning({ id: user.id });
  return updated.length === 1;
}

/**
 * ACTIVE (or already INVITED) STAFF → INVITED for an approved MFA reset. The
 * version increment invalidates every assurance record issued before it.
 * Restricted accounts (LOCKED/DISABLED/CLOSED) are never reopened here.
 */
export async function returnStaffToInvited(
  tx: Executor,
  accountId: string,
  now: Date,
): Promise<boolean> {
  const updated = await tx
    .update(user)
    .set({
      status: "INVITED",
      version: sql`${user.version} + 1`,
      updatedAt: now,
    })
    .where(
      and(
        eq(user.id, accountId),
        eq(user.accountType, "STAFF"),
        inArray(user.status, ["ACTIVE", "INVITED"]),
      ),
    )
    .returning({ id: user.id });
  return updated.length === 1;
}

/** Increments the account version (invalidates issued assurance). */
export async function bumpAccountVersion(
  tx: Executor,
  accountId: string,
  now: Date,
): Promise<void> {
  await tx
    .update(user)
    .set({ version: sql`${user.version} + 1`, updatedAt: now })
    .where(eq(user.id, accountId));
}

/** Deletes an account's sessions with the given assurance purposes. */
export async function deleteSessionsByPurpose(
  tx: Executor,
  accountId: string,
  purposes: readonly string[],
): Promise<number> {
  if (!uuidPattern.test(accountId) || purposes.length === 0) return 0;
  const deleted = await tx
    .delete(session)
    .where(
      and(
        eq(session.userId, accountId),
        inArray(session.authPurpose, [...purposes]),
      ),
    )
    .returning({ id: session.id });
  return deleted.length;
}

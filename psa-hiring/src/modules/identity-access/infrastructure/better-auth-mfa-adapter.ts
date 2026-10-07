import "server-only";
import { createHash, createHmac } from "node:crypto";
import { and, eq, lt, or, sql } from "drizzle-orm";
import type { Database } from "@/shared/database";
import {
  authenticationMethods,
  type AssuranceEvidence,
  type AuthenticationMethod,
  type ReauthenticationPurpose,
} from "../domain/authentication-assurance";
import { uuidPattern } from "./account-repository";
import { session, twoFactor, user, verification } from "./auth-schema";
import { TOTP_PERIOD_SECONDS } from "./auth-options";
import { totpReplayGuard } from "./staff-identity-schema";

// Application-side glue around Better Auth's maintained two-factor plugin
// (packet M1.3 §10–§13, ADR-0004). Nothing here implements TOTP, backup
// codes, QR encoding, encryption, or password hashing: those stay in Better
// Auth. This module adds only what the plugin does not provide:
//
// - a TOTP replay guard (the plugin verifies ±1 step statelessly),
// - a server-side staff challenge record bound to the plugin's signed
//   challenge cookie (purpose, account, and first-factor time),
// - reading/writing server-owned session assurance evidence,
// - removing an enrollment for an approved administrative MFA reset.

type Executor = Pick<Database, "select" | "update" | "delete" | "insert">;

/** Accepted codes are remembered past the ±1-step verification window. */
const REPLAY_MEMORY_MS = TOTP_PERIOD_SECONDS * 4 * 1000;

/**
 * Claims a submitted TOTP code for one account before it is verified.
 * Returns false when the same code was already presented within the
 * window (replay or a concurrent duplicate). Only an HMAC digest is
 * stored. Wrong codes are harmlessly remembered too: a code cannot be
 * wrong now and right moments later in the same window.
 */
export async function claimTotpCode(
  db: Executor,
  key: string,
  accountId: string,
  code: string,
  now: Date = new Date(),
): Promise<boolean> {
  if (!uuidPattern.test(accountId)) return false;
  await db.delete(totpReplayGuard).where(lt(totpReplayGuard.expiresAt, now));
  const digest = createHmac("sha256", key)
    .update(`totp-replay.v1:${accountId}:${code}`)
    .digest("base64url");
  const inserted = await db
    .insert(totpReplayGuard)
    .values({
      userId: accountId,
      codeDigest: digest,
      expiresAt: new Date(now.getTime() + REPLAY_MEMORY_MS),
    })
    .onConflictDoNothing()
    .returning({ userId: totpReplayGuard.userId });
  return inserted.length === 1;
}

// ---------------------------------------------------------------------------
// Staff challenge record (between /staff/sign-in and /staff/mfa)
// ---------------------------------------------------------------------------

export const STAFF_CHALLENGE_NAMESPACE = "staff-mfa-challenge:";

/** The subset of Better Auth's internal adapter used for challenge records. */
export interface ChallengeStore {
  createVerificationValue(data: {
    identifier: string;
    value: string;
    expiresAt: Date;
  }): Promise<unknown>;
  findVerificationValue(
    identifier: string,
  ): Promise<{ value: string; expiresAt: Date } | null | undefined>;
  consumeVerificationValue(
    identifier: string,
  ): Promise<{ value: string } | null | undefined>;
}

export type StaffChallenge = Readonly<{
  accountId: string;
  primaryAuthenticatedAt: Date;
}>;

function challengeIdentifier(challengeCookie: string): string {
  // The plugin's signed cookie value is already a capability; only a
  // digest names the record (and Better Auth hashes identifiers again).
  return `${STAFF_CHALLENGE_NAMESPACE}${createHash("sha256")
    .update(challengeCookie)
    .digest("base64url")}`;
}

export async function recordStaffChallenge(
  store: ChallengeStore,
  challengeCookie: string,
  challenge: StaffChallenge,
  ttlSeconds: number,
): Promise<void> {
  await store.createVerificationValue({
    identifier: challengeIdentifier(challengeCookie),
    // value = "<accountId>|<ISO time>" so an MFA reset can find and remove
    // every pending challenge of an account by prefix.
    value: `${challenge.accountId}|${challenge.primaryAuthenticatedAt.toISOString()}`,
    expiresAt: new Date(
      challenge.primaryAuthenticatedAt.getTime() + ttlSeconds * 1000,
    ),
  });
}

function parseChallenge(value: string): StaffChallenge | null {
  const [accountId, at] = value.split("|");
  const time = new Date(at ?? "");
  if (
    !accountId ||
    !uuidPattern.test(accountId) ||
    Number.isNaN(time.getTime())
  )
    return null;
  return Object.freeze({ accountId, primaryAuthenticatedAt: time });
}

export async function findStaffChallenge(
  store: ChallengeStore,
  challengeCookie: string,
  now: Date = new Date(),
): Promise<StaffChallenge | null> {
  const row = await store.findVerificationValue(
    challengeIdentifier(challengeCookie),
  );
  if (!row || new Date(row.expiresAt).getTime() <= now.getTime()) return null;
  return parseChallenge(row.value);
}

export async function consumeStaffChallenge(
  store: ChallengeStore,
  challengeCookie: string,
): Promise<void> {
  await store.consumeVerificationValue(challengeIdentifier(challengeCookie));
}

/** Cookie names (secure variant on https/production-like origins). */
export function twoFactorCookieName(secure: boolean): string {
  return `${secure ? "__Secure-" : ""}psa.two_factor`;
}

export function trustDeviceCookieName(secure: boolean): string {
  return `${secure ? "__Secure-" : ""}psa.trust_device`;
}

/** Reads one cookie value from a Cookie header (never logged). */
export function readCookie(headers: Headers, name: string): string | null {
  const header = headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    if (part.slice(0, index).trim() !== name) continue;
    const raw = part.slice(index + 1).trim();
    try {
      return decodeURIComponent(raw);
    } catch {
      return null;
    }
  }
  return null;
}

/** Reads one cookie value from Set-Cookie headers (never logged). */
export function readSetCookie(
  setCookies: readonly string[],
  name: string,
): string | null {
  for (const header of setCookies) {
    const [pair] = header.split(";");
    const index = pair.indexOf("=");
    if (index < 0 || pair.slice(0, index).trim() !== name) continue;
    const raw = pair.slice(index + 1).trim();
    if (!raw) return null;
    try {
      return decodeURIComponent(raw);
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Copies request headers without the named cookies, so a client-held
 * trusted-device (or any other) cookie can never influence a staff
 * authentication call (packet M1.3 §6.3).
 */
export function withoutCookies(
  headers: Headers,
  names: readonly string[],
  extra?: string,
): Headers {
  const copy = new Headers(headers);
  const kept = (headers.get("cookie") ?? "")
    .split(";")
    .map((part) => part.trim())
    .filter(
      (part) =>
        part.length > 0 && !names.includes(part.split("=")[0]?.trim() ?? ""),
    );
  if (extra) kept.push(extra);
  if (kept.length > 0) copy.set("cookie", kept.join("; "));
  else copy.delete("cookie");
  return copy;
}

// ---------------------------------------------------------------------------
// Session assurance evidence
// ---------------------------------------------------------------------------

function asMethod(value: string | null): AuthenticationMethod | null {
  return value && (authenticationMethods as readonly string[]).includes(value)
    ? (value as AuthenticationMethod)
    : null;
}

/** Loads server-owned evidence for one session of one account. */
export async function readSessionAssurance(
  db: Executor,
  accountId: string,
  sessionId: string,
): Promise<AssuranceEvidence | null> {
  if (!uuidPattern.test(accountId) || !uuidPattern.test(sessionId)) return null;
  const [row] = await db
    .select({
      sessionId: session.id,
      accountId: session.userId,
      authPurpose: session.authPurpose,
      authMethod: session.authMethod,
      primaryAuthenticatedAt: session.primaryAuthenticatedAt,
      mfaAuthenticatedAt: session.mfaAuthenticatedAt,
      sessionAccountVersion: session.accountVersion,
      reauthenticatedAt: session.reauthenticatedAt,
      reauthenticationMethod: session.reauthenticationMethod,
      reauthenticationPurpose: session.reauthenticationPurpose,
      currentAccountVersion: user.version,
      expiresAt: session.expiresAt,
    })
    .from(session)
    .innerJoin(user, eq(user.id, session.userId))
    .where(and(eq(session.id, sessionId), eq(session.userId, accountId)))
    .limit(1);
  if (!row || row.expiresAt.getTime() <= Date.now()) return null;
  const reauthMethod = asMethod(row.reauthenticationMethod);
  return Object.freeze({
    accountId: row.accountId,
    sessionId: row.sessionId,
    sessionPurpose: row.authPurpose,
    method: asMethod(row.authMethod),
    primaryAuthenticatedAt: row.primaryAuthenticatedAt,
    mfaAuthenticatedAt: row.mfaAuthenticatedAt,
    sessionAccountVersion: row.sessionAccountVersion,
    currentAccountVersion: row.currentAccountVersion,
    reauthentication:
      row.reauthenticatedAt && reauthMethod && row.reauthenticationPurpose
        ? Object.freeze({
            at: row.reauthenticatedAt,
            method: reauthMethod,
            purpose: row.reauthenticationPurpose,
          })
        : null,
  });
}

/**
 * Records purpose-bound reauthentication evidence on the current staff
 * session only. It changes neither the session expiry nor its token.
 */
export async function recordReauthentication(
  db: Executor,
  accountId: string,
  sessionId: string,
  purpose: ReauthenticationPurpose,
  at: Date,
): Promise<boolean> {
  if (!uuidPattern.test(accountId) || !uuidPattern.test(sessionId)) {
    return false;
  }
  const updated = await db
    .update(session)
    .set({
      reauthenticatedAt: at,
      reauthenticationMethod: "PASSWORD_TOTP",
      reauthenticationPurpose: purpose,
    })
    .where(
      and(
        eq(session.id, sessionId),
        eq(session.userId, accountId),
        eq(session.authPurpose, "STAFF"),
      ),
    )
    .returning({ id: session.id });
  return updated.length === 1;
}

/** Reads the activation-session times for the final staff session. */
export async function readSessionTimes(
  db: Executor,
  accountId: string,
  sessionId: string,
): Promise<{
  purpose: string | null;
  primaryAuthenticatedAt: Date | null;
  mfaAuthenticatedAt: Date | null;
} | null> {
  if (!uuidPattern.test(accountId) || !uuidPattern.test(sessionId)) return null;
  const [row] = await db
    .select({
      purpose: session.authPurpose,
      primaryAuthenticatedAt: session.primaryAuthenticatedAt,
      mfaAuthenticatedAt: session.mfaAuthenticatedAt,
    })
    .from(session)
    .where(and(eq(session.id, sessionId), eq(session.userId, accountId)))
    .limit(1);
  return row ?? null;
}

// ---------------------------------------------------------------------------
// Enrollment state and administrative reset
// ---------------------------------------------------------------------------

export type EnrollmentState = Readonly<{
  enrolled: boolean;
  verified: boolean;
}>;

export async function readEnrollment(
  db: Executor,
  accountId: string,
): Promise<EnrollmentState> {
  if (!uuidPattern.test(accountId)) return { enrolled: false, verified: false };
  const [row] = await db
    .select({ verified: twoFactor.verified })
    .from(twoFactor)
    .where(eq(twoFactor.userId, accountId))
    .limit(1);
  return { enrolled: Boolean(row), verified: row?.verified === true };
}

/**
 * Removes the account's TOTP enrollment and every backup code (the same
 * row/flag effect as Better Auth's disableTwoFactor, which requires the
 * user's own fresh session and password), every pending two-factor or
 * staff challenge, any trusted-device record, and every replay marker.
 * Runs inside the caller's transaction.
 */
export async function removeTwoFactorEnrollment(
  tx: Executor,
  accountId: string,
): Promise<void> {
  await tx.delete(twoFactor).where(eq(twoFactor.userId, accountId));
  await tx
    .update(user)
    .set({ twoFactorEnabled: false })
    .where(eq(user.id, accountId));
  await removePendingStaffChallenges(tx, accountId);
  await tx.delete(totpReplayGuard).where(eq(totpReplayGuard.userId, accountId));
}

/**
 * Removes every pending first-factor challenge and trusted-device record of
 * an account, so a password verified before a credential change can never
 * complete into a session afterwards (M1.7 D4). Runs inside the caller's
 * transaction.
 */
export async function removePendingStaffChallenges(
  tx: Executor,
  accountId: string,
): Promise<void> {
  // Better Auth challenge/trusted-device records store the account ID as
  // their value; staff challenge records use "<accountId>|<time>".
  await tx
    .delete(verification)
    .where(
      or(
        eq(verification.value, accountId),
        sql`${verification.value} LIKE ${`${accountId}|%`}`,
      ),
    );
}

/** Better Auth error codes from a JSON error response (never logged). */
export async function authErrorCode(response: Response): Promise<string> {
  try {
    const body = (await response.clone().json()) as { code?: unknown };
    return typeof body.code === "string" ? body.code : "UNKNOWN";
  } catch {
    return "UNKNOWN";
  }
}

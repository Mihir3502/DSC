import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import {
  describeDevice,
  maskEmail,
} from "../domain/candidate-registration-policy";
import {
  deleteSessionsExcept,
  findAccountEmail,
  listActiveSessions,
  lockAccountForUpdate,
} from "../infrastructure/account-repository";
import { resolveCurrentAccount, type Principal } from "./current-account";
import {
  defaultDependencies,
  type CandidateAuthDependencies,
} from "./candidate-auth-support";
import { revokeAllSessions, revokeSession } from "./restrict-account";

// Candidate-owned session management for /candidate/security (packet M1.2
// §13, AC-M1.2-10). Candidates see opaque session references, never tokens
// or database IDs, full IPs, or full user agents. Every command re-resolves
// the current account and rechecks ownership at command time.

export type CandidateSessionSummary = Readonly<{
  /** HMAC-derived opaque reference, valid only for its owner. */
  ref: string;
  current: boolean;
  deviceLabel: string;
  createdAt: Date;
  lastActiveAt: Date;
  expiresAt: Date;
}>;

export type CandidateSecurityOverview = Readonly<{
  maskedEmail: string;
  emailVerified: boolean;
  sessions: readonly CandidateSessionSummary[];
}>;

/** The current principal only when it is an active, verified candidate. */
export async function resolveCurrentCandidate(
  headers: Headers,
  deps: CandidateAuthDependencies = defaultDependencies(),
): Promise<Principal | null> {
  const principal = await resolveCurrentAccount(headers, deps);
  if (
    !principal ||
    principal.accountType !== "CANDIDATE" ||
    !principal.emailVerified
  ) {
    return null;
  }
  return principal;
}

/** HMAC-derived opaque session reference (shared with staff, M1.3). */
export function sessionRef(deps: CandidateAuthDependencies, sessionId: string) {
  return createHmac("sha256", deps.env.BETTER_AUTH_SECRET)
    .update(`session-ref.v1:${sessionId}`)
    .digest("base64url")
    .slice(0, 32);
}

export function sameRef(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** Expires the session cookie in the browser (both cookie-name variants). */
export function expiredSessionCookies(
  deps: CandidateAuthDependencies,
): string[] {
  const secure = deps.env.secureCookies ? "; Secure" : "";
  const names = deps.env.secureCookies
    ? ["__Secure-psa.session_token"]
    : ["psa.session_token"];
  return names.map(
    (name) => `${name}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax${secure}`,
  );
}

export async function getCandidateSecurityOverview(
  headers: Headers,
  deps: CandidateAuthDependencies = defaultDependencies(),
): Promise<CandidateSecurityOverview | null> {
  const principal = await resolveCurrentCandidate(headers, deps);
  if (!principal) return null;
  const [email, rows] = await Promise.all([
    findAccountEmail(deps.db, principal.accountId),
    listActiveSessions(deps.db, principal.accountId),
  ]);
  return Object.freeze({
    maskedEmail: email ? maskEmail(email) : "•••",
    emailVerified: principal.emailVerified,
    sessions: rows.map((row) =>
      Object.freeze({
        ref: sessionRef(deps, row.id),
        current: row.id === principal.sessionId,
        deviceLabel: describeDevice(row.userAgent),
        createdAt: row.createdAt,
        lastActiveAt: row.updatedAt,
        expiresAt: row.expiresAt,
      }),
    ),
  });
}

export type SessionCommandResult =
  | Readonly<{
      kind: "REVOKED";
      /** True when the current session ended (caller must sign out). */
      endedCurrent: boolean;
      count: number;
      setCookies: readonly string[];
    }>
  /** Unknown, foreign, or already-revoked reference; non-enumerating. */
  | Readonly<{ kind: "NOT_FOUND" }>
  | Readonly<{ kind: "UNAUTHENTICATED" }>;

/** Revokes one of the candidate's own sessions by opaque reference. */
export async function revokeCandidateSession(
  headers: Headers,
  ref: unknown,
  deps: CandidateAuthDependencies = defaultDependencies(),
): Promise<SessionCommandResult> {
  const principal = await resolveCurrentCandidate(headers, deps);
  if (!principal) return { kind: "UNAUTHENTICATED" };
  if (typeof ref !== "string" || !/^[A-Za-z0-9_-]{32}$/.test(ref)) {
    return { kind: "NOT_FOUND" };
  }
  const rows = await listActiveSessions(deps.db, principal.accountId);
  const target = rows.find((row) => sameRef(sessionRef(deps, row.id), ref));
  if (!target) return { kind: "NOT_FOUND" };

  const result = await revokeSession(principal.accountId, target.id, deps);
  if (result.sessionsRevoked === 0) return { kind: "NOT_FOUND" };
  const endedCurrent = target.id === principal.sessionId;
  deps.events.record({
    code: "auth.session_revoked",
    accountRef: principal.accountId,
  });
  return {
    kind: "REVOKED",
    endedCurrent,
    count: 1,
    setCookies: endedCurrent ? expiredSessionCookies(deps) : [],
  };
}

/** Revokes every session except the current one. Idempotent. */
export async function revokeOtherCandidateSessions(
  headers: Headers,
  deps: CandidateAuthDependencies = defaultDependencies(),
): Promise<SessionCommandResult> {
  const principal = await resolveCurrentCandidate(headers, deps);
  if (!principal) return { kind: "UNAUTHENTICATED" };
  const count = await deps.db.transaction(async (tx) => {
    const account = await lockAccountForUpdate(tx, principal.accountId);
    if (!account) return 0;
    return deleteSessionsExcept(tx, principal.accountId, principal.sessionId);
  });
  deps.events.record({
    code: "auth.sessions_revoked",
    accountRef: principal.accountId,
  });
  return { kind: "REVOKED", endedCurrent: false, count, setCookies: [] };
}

/** Ends every session, including this one ("sign out everywhere"). */
export async function signOutCandidateEverywhere(
  headers: Headers,
  deps: CandidateAuthDependencies = defaultDependencies(),
): Promise<SessionCommandResult> {
  const principal = await resolveCurrentCandidate(headers, deps);
  if (!principal) {
    return {
      kind: "REVOKED",
      endedCurrent: true,
      count: 0,
      setCookies: expiredSessionCookies(deps),
    };
  }
  const result = await revokeAllSessions(principal.accountId, deps);
  deps.events.record({
    code: "auth.sessions_revoked",
    accountRef: principal.accountId,
  });
  return {
    kind: "REVOKED",
    endedCurrent: true,
    count: result.sessionsRevoked,
    setCookies: expiredSessionCookies(deps),
  };
}

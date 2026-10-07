import "server-only";
import { withAuditedTransaction } from "@/modules/audit";
import { createHmac, timingSafeEqual } from "node:crypto";
import {
  deleteAllSessions,
  deleteOwnedSession,
  deleteSessionsExcept,
  findAccountEmail,
  listActiveSessions,
} from "../infrastructure/account-repository";
import {
  candidateSecurityContract,
  type CandidateSecurityView,
} from "../presentation/security-view-models";
import { project } from "../presentation/authorized-projector";
import {
  authorizeAccountSelfService,
  authorizeAccountSelfServiceInTransaction,
  correlationOf,
  refusalOf,
  selfServiceAction,
  type SelfServiceRefusal,
} from "./authorize-self-service";
import { resolveCurrentAccount, type Principal } from "./current-account";
import {
  defaultDependencies,
  type CandidateAuthDependencies,
} from "./candidate-auth-support";

// Candidate-owned session management for /candidate/security (packet M1.2
// §13, AC-M1.2-10; M1.5 §9, §12.4). Every query and command:
//
// 1. resolves the current server-owned principal;
// 2. validates its bounded input;
// 3. calls the self-service authorization boundary (CANDIDATE_* policies),
//    which re-reads the account and session on every call;
// 4. reads only the principal's own rows (owner predicate in SQL);
// 5. rechecks authorization inside the command transaction;
// 6. returns an exact, projected view model or a closed result code.
//
// Candidates see opaque session references, never tokens, database IDs,
// full IPs, or full user agents.

export type CandidateSessionSummary = CandidateSecurityView["sessions"][number];
export type CandidateSecurityOverview = CandidateSecurityView;

export type CandidateSecurityQueryResult =
  Readonly<{ kind: "OK"; view: CandidateSecurityView }> | SelfServiceRefusal;

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

/** Bounded opaque-reference shape; anything else is "not found". */
export const sessionRefPattern = /^[A-Za-z0-9_-]{32}$/;

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

/** The candidate security page query (typed outcome for delivery). */
export async function queryCandidateSecurity(
  headers: Headers,
  deps: CandidateAuthDependencies = defaultDependencies(),
): Promise<CandidateSecurityQueryResult> {
  const correlationId = correlationOf(headers);
  const principal = await resolveCurrentAccount(headers, deps);
  const decision = await authorizeAccountSelfService(
    principal,
    "CANDIDATE_SECURITY_READ",
    deps,
    { correlationId },
  );
  if (decision.decision !== "ALLOW" || !principal) {
    return decision.decision === "DENY"
      ? refusalOf(decision)
      : { kind: "UNAUTHENTICATED" };
  }
  const [email, rows] = await Promise.all([
    findAccountEmail(deps.db, principal.accountId),
    listActiveSessions(deps.db, principal.accountId),
  ]);
  const projected = project(
    candidateSecurityContract,
    {
      email,
      emailVerified: principal.emailVerified,
      sessions: rows.map((row) => ({
        ref: sessionRef(deps, row.id),
        current: row.id === principal.sessionId,
        userAgent: row.userAgent,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        expiresAt: row.expiresAt,
      })),
    },
    { audience: "CANDIDATE", purpose: "SECURITY", allowed: new Set() },
  );
  if (projected.kind !== "PROJECTED") {
    deps.logger.error("authz.projection_refused", {
      module: "authz",
      action: selfServiceAction("CANDIDATE_SECURITY_READ"),
      reasonCode: projected.reason,
      correlationId,
    });
    return { kind: "NOT_PERMITTED" };
  }
  return { kind: "OK", view: projected.value };
}

/** Convenience form of queryCandidateSecurity: the view or null. */
export async function getCandidateSecurityOverview(
  headers: Headers,
  deps: CandidateAuthDependencies = defaultDependencies(),
): Promise<CandidateSecurityOverview | null> {
  const result = await queryCandidateSecurity(headers, deps);
  return result.kind === "OK" ? result.view : null;
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
  | SelfServiceRefusal;

/** Revokes one of the candidate's own sessions by opaque reference. */
export async function revokeCandidateSession(
  headers: Headers,
  ref: unknown,
  deps: CandidateAuthDependencies = defaultDependencies(),
): Promise<SessionCommandResult> {
  const correlationId = correlationOf(headers);
  const principal = await resolveCurrentAccount(headers, deps);
  const decision = await authorizeAccountSelfService(
    principal,
    "CANDIDATE_SESSION_REVOKE",
    deps,
    { correlationId },
  );
  if (decision.decision === "DENY") return refusalOf(decision);
  if (!principal) return { kind: "UNAUTHENTICATED" };
  if (typeof ref !== "string" || !sessionRefPattern.test(ref)) {
    return { kind: "NOT_FOUND" };
  }
  // Ownership is a SQL predicate: only the principal's own sessions are
  // ever loaded, then the opaque reference is matched in constant time.
  const rows = await listActiveSessions(deps.db, principal.accountId);
  const target = rows.find((row) => sameRef(sessionRef(deps, row.id), ref));
  if (!target) return { kind: "NOT_FOUND" };

  const outcome = await withAuditedTransaction(deps, async (tx, audit) => {
    const recheck = await authorizeAccountSelfServiceInTransaction(
      tx,
      principal,
      "CANDIDATE_SESSION_REVOKE",
      deps,
      { correlationId },
    );
    if (recheck.decision === "DENY") return recheck;
    const revoked = await deleteOwnedSession(
      tx,
      principal.accountId,
      target.id,
    );
    if (revoked > 0) {
      await audit.append({
        code: "auth.session_revoked",
        accountRef: principal.accountId,
        permissionCode: selfServiceAction("CANDIDATE_SESSION_REVOKE"),
        policyVersion: recheck.policyVersion,
        count: revoked,
        correlationId,
      });
    }
    return revoked;
  });
  if (typeof outcome !== "number") return refusalOf(outcome);
  if (outcome === 0) return { kind: "NOT_FOUND" };
  const endedCurrent = target.id === principal.sessionId;
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
  const correlationId = correlationOf(headers);
  const principal = await resolveCurrentAccount(headers, deps);
  const decision = await authorizeAccountSelfService(
    principal,
    "CANDIDATE_SESSIONS_REVOKE_OTHERS",
    deps,
    { correlationId },
  );
  if (decision.decision === "DENY") return refusalOf(decision);
  if (!principal) return { kind: "UNAUTHENTICATED" };
  const outcome = await withAuditedTransaction(deps, async (tx, audit) => {
    const recheck = await authorizeAccountSelfServiceInTransaction(
      tx,
      principal,
      "CANDIDATE_SESSIONS_REVOKE_OTHERS",
      deps,
      { correlationId },
    );
    if (recheck.decision === "DENY") return recheck;
    const revoked = await deleteSessionsExcept(
      tx,
      principal.accountId,
      principal.sessionId,
    );
    await audit.append({
      code: "auth.sessions_revoked",
      accountRef: principal.accountId,
      permissionCode: selfServiceAction("CANDIDATE_SESSIONS_REVOKE_OTHERS"),
      policyVersion: recheck.policyVersion,
      count: revoked,
      correlationId,
    });
    return revoked;
  });
  if (typeof outcome !== "number") return refusalOf(outcome);
  return {
    kind: "REVOKED",
    endedCurrent: false,
    count: outcome,
    setCookies: [],
  };
}

/**
 * Ends every session, including this one ("sign out everywhere"). Without
 * an eligible principal there is nothing to revoke: the browser's cookie is
 * still expired, so the command is safe to repeat.
 */
export async function signOutCandidateEverywhere(
  headers: Headers,
  deps: CandidateAuthDependencies = defaultDependencies(),
): Promise<SessionCommandResult> {
  const correlationId = correlationOf(headers);
  const signedOut = {
    kind: "REVOKED",
    endedCurrent: true,
    count: 0,
    setCookies: expiredSessionCookies(deps),
  } as const;
  const principal = await resolveCurrentAccount(headers, deps);
  if (!principal) return signedOut;
  const decision = await authorizeAccountSelfService(
    principal,
    "CANDIDATE_SESSIONS_END_ALL",
    deps,
    { correlationId },
  );
  if (decision.decision === "DENY") {
    const refusal = refusalOf(decision);
    return refusal.kind === "UNAUTHENTICATED" ? signedOut : refusal;
  }
  const outcome = await withAuditedTransaction(deps, async (tx, audit) => {
    const recheck = await authorizeAccountSelfServiceInTransaction(
      tx,
      principal,
      "CANDIDATE_SESSIONS_END_ALL",
      deps,
      { correlationId },
    );
    if (recheck.decision === "DENY") return recheck;
    const revoked = await deleteAllSessions(tx, principal.accountId);
    await audit.append({
      code: "auth.sessions_revoked",
      accountRef: principal.accountId,
      permissionCode: selfServiceAction("CANDIDATE_SESSIONS_END_ALL"),
      policyVersion: recheck.policyVersion,
      count: revoked,
      correlationId,
    });
    return revoked;
  });
  if (typeof outcome !== "number") {
    const refusal = refusalOf(outcome);
    return refusal.kind === "UNAUTHENTICATED" ? signedOut : refusal;
  }
  return { ...signedOut, count: outcome };
}

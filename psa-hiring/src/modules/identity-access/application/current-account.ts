import "server-only";
import { getDatabase, type Database } from "@/shared/database";
import { getLogger, getRequestContext, type AppLogger } from "@/shared/logging";
import { canResolvePrincipal } from "../domain/account-policy";
import type { AccountStatus, AccountType } from "../domain/account-types";
import { evaluateAssurance } from "../domain/authentication-assurance";
import { findAccountById } from "../infrastructure/account-repository";
import { readSessionAssurance } from "../infrastructure/better-auth-mfa-adapter";
import type { Auth } from "../infrastructure/auth";
import { getAuth } from "../infrastructure/runtime";

// Application-owned current-account resolver (packet M1.1 §10). Converts a
// Better Auth database session into the minimal principal later
// authorization work needs. Account status is always re-read from the
// authoritative record; only ACTIVE, non-service accounts resolve. A staff
// account additionally needs an MFA-complete STAFF session whose
// server-owned assurance predates no security change (packet M1.3 §6.1,
// AC-M1.3-04/08): password-only, first-factor, or enrollment sessions
// never resolve a staff principal.

export type Principal = Readonly<{
  accountId: string;
  accountType: AccountType;
  status: AccountStatus;
  emailVerified: boolean;
  sessionId: string;
  /** When the current session was established (authentication freshness). */
  authenticatedAt: Date;
}>;

export type ResolverDependencies = {
  auth: Auth;
  db: Database;
  logger: AppLogger;
};

function defaults(): ResolverDependencies {
  return { auth: getAuth(), db: getDatabase(), logger: getLogger() };
}

/**
 * Returns the principal for the request's session cookie, or null. Missing,
 * malformed, expired, revoked, and restricted sessions are indistinguishable
 * to the caller; the reason is logged as a safe code only.
 */
export async function resolveCurrentAccount(
  headers: Headers,
  deps: ResolverDependencies = defaults(),
): Promise<Principal | null> {
  const log = deps.logger.child({
    module: "auth",
    correlationId: getRequestContext()?.correlationId,
  });

  let result: Awaited<ReturnType<Auth["api"]["getSession"]>>;
  try {
    result = await deps.auth.api.getSession({
      headers,
      query: { disableRefresh: false },
    });
  } catch {
    log.warn("auth.principal_rejected", {
      resultCode: "session_lookup_failed",
    });
    return null;
  }
  if (!result) return null;

  const account = await findAccountById(deps.db, result.user.id);
  if (!account || !canResolvePrincipal(account)) {
    log.warn("auth.principal_rejected", { resultCode: "account_not_active" });
    return null;
  }

  const evidence = await readSessionAssurance(
    deps.db,
    account.id,
    result.session.id,
  );
  if (account.accountType === "STAFF") {
    const decision = evaluateAssurance(evidence, {
      policy: "NORMAL_STAFF_SESSION",
      accountId: account.id,
      sessionId: result.session.id,
      now: new Date(),
      recentWindowSeconds: 1,
    });
    if (decision.kind !== "ALLOW" || !account.twoFactorEnabled) {
      log.warn("auth.principal_rejected", { resultCode: "staff_mfa_missing" });
      return null;
    }
  } else if (
    evidence?.sessionPurpose != null &&
    evidence.sessionPurpose !== "STANDARD"
  ) {
    log.warn("auth.principal_rejected", { resultCode: "session_purpose" });
    return null;
  }

  return Object.freeze({
    accountId: account.id,
    accountType: account.accountType,
    status: account.status,
    emailVerified: account.emailVerified,
    sessionId: result.session.id,
    authenticatedAt: new Date(result.session.createdAt),
  });
}

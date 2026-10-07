import "server-only";
import type { PasswordProblem } from "../domain/candidate-registration-policy";
import {
  bumpAccountVersion,
  deleteAllSessions,
  deleteOwnedSession,
  deleteSessionsExcept,
  findAccountEmail,
  listActiveSessions,
  lockAccountForUpdate,
} from "../infrastructure/account-repository";
import { readSessionAssurance } from "../infrastructure/better-auth-mfa-adapter";
import { project } from "../presentation/authorized-projector";
import {
  staffSecurityContract,
  type StaffSecurityView,
} from "../presentation/security-view-models";
import {
  authorizeAccountSelfService,
  authorizeAccountSelfServiceInTransaction,
  correlationOf,
  refusalOf,
  selfServiceAction,
  type SelfServiceRefusal,
} from "./authorize-self-service";
import { formString, newPasswordProblems } from "./candidate-auth-support";
import { resolveCurrentAccount } from "./current-account";
import {
  sameRef,
  sessionRef,
  sessionRefPattern,
} from "./manage-candidate-sessions";
import {
  evaluateStaffAssurance,
  verifyStaffStepUp,
} from "./reauthenticate-staff";
import {
  defaultStaffDependencies,
  expiredStaffCookies,
  staffAuthHeaders,
  type StaffAuthDependencies,
} from "./staff-auth-support";

// The minimal /staff/security area (packet M1.3 §12, AC-M1.3-11; M1.5 §9,
// §12.4). Account, MFA, and session controls only: no roles, permissions,
// scopes, branch or team, candidate records, queues, dashboards, or
// administration. No TOTP secret or existing backup code is ever readable
// here (Better Auth's server-only viewBackupCodes is deliberately not
// connected to anything).
//
// Every query and command resolves the principal, calls the STAFF_*
// self-service policy (which re-reads the account and the session's MFA
// assurance), touches only the principal's own rows, rechecks inside the
// command transaction where a race matters, and returns an exact projected
// view or a closed result code.

export type StaffSessionSummary = StaffSecurityView["sessions"][number];
export type StaffSecurityOverview = StaffSecurityView;

export type StaffSecurityQueryResult =
  Readonly<{ kind: "OK"; view: StaffSecurityView }> | SelfServiceRefusal;

export async function queryStaffSecurity(
  headers: Headers,
  deps: StaffAuthDependencies = defaultStaffDependencies(),
): Promise<StaffSecurityQueryResult> {
  const correlationId = correlationOf(headers);
  const principal = await resolveCurrentAccount(headers, deps);
  const decision = await authorizeAccountSelfService(
    principal,
    "STAFF_SECURITY_READ",
    deps,
    { correlationId },
  );
  if (decision.decision === "DENY") return refusalOf(decision);
  if (!principal) return { kind: "UNAUTHENTICATED" };
  const [email, rows, evidence, recent, strong] = await Promise.all([
    findAccountEmail(deps.db, principal.accountId),
    listActiveSessions(deps.db, principal.accountId),
    readSessionAssurance(deps.db, principal.accountId, principal.sessionId),
    evaluateStaffAssurance(principal, "RECENT_STAFF_AUTH", {}, deps),
    evaluateStaffAssurance(principal, "RECENT_STRONG_AUTH", {}, deps),
  ]);
  const projected = project(
    staffSecurityContract,
    {
      email,
      signedInWith: evidence?.method ?? null,
      recent: recent.kind === "ALLOW",
      strong: strong.kind === "ALLOW",
      recentAt: recent.kind === "ALLOW" ? recent.at : null,
      windowSeconds: deps.env.AUTH_STAFF_RECENT_AUTH_SECONDS,
      // Transient first-factor/enrollment sessions are not "signed in".
      sessions: rows.map((row) => ({
        ref: sessionRef(deps, row.id),
        current: row.id === principal.sessionId,
        userAgent: row.userAgent,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        expiresAt: row.expiresAt,
      })),
    },
    { audience: "STAFF", purpose: "SECURITY", allowed: new Set() },
  );
  if (projected.kind !== "PROJECTED") {
    deps.logger.error("authz.projection_refused", {
      module: "authz",
      action: selfServiceAction("STAFF_SECURITY_READ"),
      reasonCode: projected.reason,
      correlationId,
    });
    return { kind: "NOT_PERMITTED" };
  }
  return { kind: "OK", view: projected.value };
}

/** Convenience form of queryStaffSecurity: the view or null. */
export async function getStaffSecurityOverview(
  headers: Headers,
  deps: StaffAuthDependencies = defaultStaffDependencies(),
): Promise<StaffSecurityOverview | null> {
  const result = await queryStaffSecurity(headers, deps);
  return result.kind === "OK" ? result.view : null;
}

export type StaffSessionCommandResult =
  | Readonly<{
      kind: "REVOKED";
      endedCurrent: boolean;
      count: number;
      setCookies: readonly string[];
    }>
  | Readonly<{ kind: "NOT_FOUND" }>
  | SelfServiceRefusal;

export async function revokeStaffSession(
  headers: Headers,
  ref: unknown,
  deps: StaffAuthDependencies = defaultStaffDependencies(),
): Promise<StaffSessionCommandResult> {
  const correlationId = correlationOf(headers);
  const principal = await resolveCurrentAccount(headers, deps);
  const decision = await authorizeAccountSelfService(
    principal,
    "STAFF_SESSION_REVOKE",
    deps,
    { correlationId },
  );
  if (decision.decision === "DENY") return refusalOf(decision);
  if (!principal) return { kind: "UNAUTHENTICATED" };
  if (typeof ref !== "string" || !sessionRefPattern.test(ref)) {
    return { kind: "NOT_FOUND" };
  }
  const rows = await listActiveSessions(deps.db, principal.accountId);
  const target = rows.find((row) => sameRef(sessionRef(deps, row.id), ref));
  if (!target) return { kind: "NOT_FOUND" };
  const outcome = await deps.db.transaction(async (tx) => {
    const recheck = await authorizeAccountSelfServiceInTransaction(
      tx,
      principal,
      "STAFF_SESSION_REVOKE",
      deps,
      { correlationId },
    );
    if (recheck.decision === "DENY") return recheck;
    return deleteOwnedSession(tx, principal.accountId, target.id);
  });
  if (typeof outcome !== "number") return refusalOf(outcome);
  if (outcome === 0) return { kind: "NOT_FOUND" };
  const endedCurrent = target.id === principal.sessionId;
  deps.events.record({
    code: "staff.session_revoked",
    accountRef: principal.accountId,
    permissionCode: selfServiceAction("STAFF_SESSION_REVOKE"),
    policyVersion: decision.policyVersion,
    correlationId,
  });
  return {
    kind: "REVOKED",
    endedCurrent,
    count: 1,
    setCookies: endedCurrent ? expiredStaffCookies(deps) : [],
  };
}

export async function revokeOtherStaffSessions(
  headers: Headers,
  deps: StaffAuthDependencies = defaultStaffDependencies(),
): Promise<StaffSessionCommandResult> {
  const correlationId = correlationOf(headers);
  const principal = await resolveCurrentAccount(headers, deps);
  const decision = await authorizeAccountSelfService(
    principal,
    "STAFF_SESSIONS_REVOKE_OTHERS",
    deps,
    { correlationId },
  );
  if (decision.decision === "DENY") return refusalOf(decision);
  if (!principal) return { kind: "UNAUTHENTICATED" };
  const outcome = await deps.db.transaction(async (tx) => {
    const recheck = await authorizeAccountSelfServiceInTransaction(
      tx,
      principal,
      "STAFF_SESSIONS_REVOKE_OTHERS",
      deps,
      { correlationId },
    );
    if (recheck.decision === "DENY") return recheck;
    return deleteSessionsExcept(tx, principal.accountId, principal.sessionId);
  });
  if (typeof outcome !== "number") return refusalOf(outcome);
  deps.events.record({
    code: "staff.sessions_revoked",
    accountRef: principal.accountId,
    permissionCode: selfServiceAction("STAFF_SESSIONS_REVOKE_OTHERS"),
    policyVersion: decision.policyVersion,
    correlationId,
  });
  return {
    kind: "REVOKED",
    endedCurrent: false,
    count: outcome,
    setCookies: [],
  };
}

/** Ends every session of the account and its assurance ("sign out everywhere"). */
export async function signOutStaffEverywhere(
  headers: Headers,
  deps: StaffAuthDependencies = defaultStaffDependencies(),
): Promise<StaffSessionCommandResult> {
  const correlationId = correlationOf(headers);
  const signedOut = {
    kind: "REVOKED",
    endedCurrent: true,
    count: 0,
    setCookies: expiredStaffCookies(deps),
  } as const;
  const principal = await resolveCurrentAccount(headers, deps);
  if (!principal) return signedOut;
  const decision = await authorizeAccountSelfService(
    principal,
    "STAFF_SESSIONS_END_ALL",
    deps,
    { correlationId },
  );
  if (decision.decision === "DENY") {
    const refusal = refusalOf(decision);
    return refusal.kind === "UNAUTHENTICATED" ? signedOut : refusal;
  }
  const outcome = await deps.db.transaction(async (tx) => {
    const recheck = await authorizeAccountSelfServiceInTransaction(
      tx,
      principal,
      "STAFF_SESSIONS_END_ALL",
      deps,
      { correlationId },
    );
    if (recheck.decision === "DENY") return recheck;
    return deleteAllSessions(tx, principal.accountId);
  });
  if (typeof outcome !== "number") {
    const refusal = refusalOf(outcome);
    return refusal.kind === "UNAUTHENTICATED" ? signedOut : refusal;
  }
  deps.events.record({
    code: "staff.sessions_revoked",
    accountRef: principal.accountId,
    permissionCode: selfServiceAction("STAFF_SESSIONS_END_ALL"),
    policyVersion: decision.policyVersion,
    correlationId,
  });
  return { ...signedOut, count: outcome };
}

export type ChangeStaffPasswordResult =
  /** Every session ended; the staff member signs in again with MFA. */
  | Readonly<{ kind: "CHANGED"; setCookies: readonly string[] }>
  | Readonly<{ kind: "INVALID_INPUT"; password: readonly PasswordProblem[] }>
  | Readonly<{ kind: "CURRENT_PASSWORD_INVALID" }>
  /** Recent authentication is required first (RECENT_STAFF_AUTH). */
  | SelfServiceRefusal
  | Readonly<{ kind: "RATE_LIMITED" }>;

/**
 * Password change for staff: the STAFF_PASSWORD_CHANGE policy requires
 * recent MFA authentication (RECENT_STAFF_AUTH) and the current password,
 * then every session ends and all issued assurance is invalidated
 * (account version increment).
 */
export async function changeStaffPassword(
  input: Readonly<{
    currentPassword: unknown;
    password: unknown;
    passwordConfirmation: unknown;
  }>,
  headers: Headers,
  deps: StaffAuthDependencies = defaultStaffDependencies(),
): Promise<ChangeStaffPasswordResult> {
  const correlationId = correlationOf(headers);
  const principal = await resolveCurrentAccount(headers, deps);
  const decision = await authorizeAccountSelfService(
    principal,
    "STAFF_PASSWORD_CHANGE",
    deps,
    { correlationId },
  );
  if (decision.decision === "DENY") {
    const refusal = refusalOf(decision);
    if (refusal.kind === "REAUTHENTICATION_REQUIRED" && principal) {
      deps.events.record({
        code: "staff.reauth_challenged",
        category: "challenge",
        accountRef: principal.accountId,
        correlationId,
      });
    }
    return refusal;
  }
  if (!principal) return { kind: "UNAUTHENTICATED" };
  if (
    !deps.limiter.consume("staffChangePasswordPerAccount", principal.accountId)
  ) {
    deps.events.record({ code: "auth.rate_limited", category: "rate_limited" });
    return { kind: "RATE_LIMITED" };
  }
  const problems = await newPasswordProblems(
    deps,
    input.password,
    input.passwordConfirmation,
  );
  if (problems.length > 0) return { kind: "INVALID_INPUT", password: problems };
  const currentPassword = formString(input.currentPassword, 4096);
  if (!currentPassword) return { kind: "CURRENT_PASSWORD_INVALID" };

  const response = await deps.auth.api.changePassword({
    body: {
      currentPassword,
      newPassword: input.password as string,
      // No replacement session: the staff member signs in again with MFA.
      revokeOtherSessions: false,
    },
    headers: staffAuthHeaders(deps, headers),
    asResponse: true,
  });
  if (!response.ok) {
    deps.events.record({
      code: "staff.password_change_failed",
      category: "invalid_credentials",
      accountRef: principal.accountId,
    });
    return { kind: "CURRENT_PASSWORD_INVALID" };
  }
  // The credential already changed: ending every session and invalidating
  // assurance is unconditional (no recheck can veto it).
  await deps.db.transaction(async (tx) => {
    await lockAccountForUpdate(tx, principal.accountId);
    await deleteAllSessions(tx, principal.accountId);
    await bumpAccountVersion(tx, principal.accountId, new Date());
  });
  const to = await findAccountEmail(deps.db, principal.accountId);
  if (to) {
    deps.email.enqueue({
      template: "STAFF_SECURITY_NOTICE",
      to,
      notice: "PASSWORD_CHANGED",
    });
  }
  deps.events.record({
    code: "staff.password_changed",
    accountRef: principal.accountId,
    permissionCode: selfServiceAction("STAFF_PASSWORD_CHANGE"),
    policyVersion: decision.policyVersion,
    correlationId,
  });
  return { kind: "CHANGED", setCookies: expiredStaffCookies(deps) };
}

export type RegenerateBackupCodesResult =
  | Readonly<{ kind: "REGENERATED"; backupCodes: readonly string[] }>
  /** One generic failure for a wrong password or code. */
  | Readonly<{ kind: "INVALID" }>
  | Readonly<{ kind: "UNAUTHENTICATED" }>
  | Readonly<{ kind: "NOT_PERMITTED" }>
  | Readonly<{ kind: "RATE_LIMITED" }>;

/**
 * Regenerates backup codes after an inline password + TOTP step-up bound to
 * this purpose (STAFF_BACKUP_CODES_REGENERATE: RECENT_STRONG_AUTH; a backup
 * code never qualifies). The step-up always runs, then the whole policy is
 * re-evaluated from current state before Better Auth replaces the stored
 * codes, so every earlier code stops working. The new codes are the only
 * one-time secret display in this area and are never retrievable later.
 */
export async function regenerateStaffBackupCodes(
  input: Readonly<{ password: unknown; code: unknown }>,
  headers: Headers,
  deps: StaffAuthDependencies = defaultStaffDependencies(),
): Promise<RegenerateBackupCodesResult> {
  const correlationId = correlationOf(headers);
  const principal = await resolveCurrentAccount(headers, deps);
  const entry = await authorizeAccountSelfService(
    principal,
    "STAFF_BACKUP_CODES_REGENERATE",
    deps,
    { correlationId },
  );
  const inlineStepUp =
    entry.decision === "DENY" &&
    entry.reasonCode === "RECENT_AUTH_REQUIRED" &&
    entry.stepUp?.kind === "INLINE";
  if (entry.decision === "DENY" && !inlineStepUp) {
    const refusal = refusalOf(entry);
    return refusal.kind === "REAUTHENTICATION_REQUIRED"
      ? { kind: "INVALID" }
      : refusal;
  }
  if (!principal) return { kind: "UNAUTHENTICATED" };
  const stepUp = await verifyStaffStepUp(
    principal,
    input,
    "REGENERATE_BACKUP_CODES",
    headers,
    deps,
  );
  if (stepUp === "RATE_LIMITED") return { kind: "RATE_LIMITED" };
  if (stepUp === "INVALID") return { kind: "INVALID" };
  // Never resume from the earlier result: re-run the full decision.
  const decision = await authorizeAccountSelfService(
    principal,
    "STAFF_BACKUP_CODES_REGENERATE",
    deps,
    { correlationId },
  );
  if (decision.decision === "DENY") {
    const refusal = refusalOf(decision);
    return refusal.kind === "REAUTHENTICATION_REQUIRED"
      ? { kind: "INVALID" }
      : refusal;
  }

  const response = await deps.auth.api.generateBackupCodes({
    body: { password: input.password as string },
    headers: staffAuthHeaders(deps, headers),
    asResponse: true,
  });
  const body = response.ok
    ? ((await response.json()) as { backupCodes?: unknown })
    : null;
  const codes = Array.isArray(body?.backupCodes)
    ? body.backupCodes.filter((c): c is string => typeof c === "string")
    : [];
  if (codes.length === 0) return { kind: "INVALID" };
  const to = await findAccountEmail(deps.db, principal.accountId);
  if (to) {
    deps.email.enqueue({
      template: "STAFF_SECURITY_NOTICE",
      to,
      notice: "BACKUP_CODES_REGENERATED",
    });
  }
  deps.events.record({
    code: "staff.backup_codes_regenerated",
    accountRef: principal.accountId,
    permissionCode: selfServiceAction("STAFF_BACKUP_CODES_REGENERATE"),
    policyVersion: decision.policyVersion,
    correlationId,
  });
  return { kind: "REGENERATED", backupCodes: Object.freeze(codes) };
}

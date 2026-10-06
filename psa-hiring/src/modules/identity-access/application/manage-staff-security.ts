import "server-only";
import type { AuthenticationMethod } from "../domain/authentication-assurance";
import {
  describeDevice,
  maskEmail,
  type PasswordProblem,
} from "../domain/candidate-registration-policy";
import {
  bumpAccountVersion,
  deleteAllSessions,
  deleteSessionsExcept,
  findAccountEmail,
  listActiveSessions,
  lockAccountForUpdate,
} from "../infrastructure/account-repository";
import { readSessionAssurance } from "../infrastructure/better-auth-mfa-adapter";
import { formString, newPasswordProblems } from "./candidate-auth-support";
import { sameRef, sessionRef } from "./manage-candidate-sessions";
import {
  evaluateStaffAssurance,
  resolveCurrentStaff,
  verifyStaffStepUp,
} from "./reauthenticate-staff";
import { revokeSession } from "./restrict-account";
import {
  defaultStaffDependencies,
  expiredStaffCookies,
  staffAuthHeaders,
  type StaffAuthDependencies,
} from "./staff-auth-support";

// The minimal /staff/security area (packet M1.3 §12, AC-M1.3-11). Account,
// MFA, and session controls only: no roles, permissions, scopes, branch or
// team, candidate records, queues, dashboards, or administration. No TOTP
// secret or existing backup code is ever readable here (Better Auth's
// server-only viewBackupCodes is deliberately not connected to anything).

export type StaffSessionSummary = Readonly<{
  ref: string;
  current: boolean;
  deviceLabel: string;
  createdAt: Date;
  lastActiveAt: Date;
  expiresAt: Date;
}>;

export type StaffSecurityOverview = Readonly<{
  maskedEmail: string;
  mfaMethod: "TOTP";
  signedInWith: AuthenticationMethod | null;
  /** Plain-language recent-authentication state for this session. */
  recentAuthentication: Readonly<{
    recent: boolean;
    strong: boolean;
    /** When the freshest qualifying authentication happened. */
    at: Date | null;
    windowSeconds: number;
  }>;
  sessions: readonly StaffSessionSummary[];
}>;

export async function getStaffSecurityOverview(
  headers: Headers,
  deps: StaffAuthDependencies = defaultStaffDependencies(),
): Promise<StaffSecurityOverview | null> {
  const principal = await resolveCurrentStaff(headers, deps);
  if (!principal) return null;
  const [email, rows, evidence, recent, strong] = await Promise.all([
    findAccountEmail(deps.db, principal.accountId),
    listActiveSessions(deps.db, principal.accountId),
    readSessionAssurance(deps.db, principal.accountId, principal.sessionId),
    evaluateStaffAssurance(principal, "RECENT_STAFF_AUTH", {}, deps),
    evaluateStaffAssurance(principal, "RECENT_STRONG_AUTH", {}, deps),
  ]);
  return Object.freeze({
    maskedEmail: email ? maskEmail(email) : "•••",
    mfaMethod: "TOTP",
    signedInWith: evidence?.method ?? null,
    recentAuthentication: Object.freeze({
      recent: recent.kind === "ALLOW",
      strong: strong.kind === "ALLOW",
      at: recent.kind === "ALLOW" ? recent.at : null,
      windowSeconds: deps.env.AUTH_STAFF_RECENT_AUTH_SECONDS,
    }),
    // Transient first-factor/enrollment sessions are not "signed in".
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

export type StaffSessionCommandResult =
  | Readonly<{
      kind: "REVOKED";
      endedCurrent: boolean;
      count: number;
      setCookies: readonly string[];
    }>
  | Readonly<{ kind: "NOT_FOUND" }>
  | Readonly<{ kind: "UNAUTHENTICATED" }>;

export async function revokeStaffSession(
  headers: Headers,
  ref: unknown,
  deps: StaffAuthDependencies = defaultStaffDependencies(),
): Promise<StaffSessionCommandResult> {
  const principal = await resolveCurrentStaff(headers, deps);
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
    code: "staff.session_revoked",
    accountRef: principal.accountId,
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
  const principal = await resolveCurrentStaff(headers, deps);
  if (!principal) return { kind: "UNAUTHENTICATED" };
  const count = await deps.db.transaction(async (tx) => {
    const account = await lockAccountForUpdate(tx, principal.accountId);
    if (!account) return 0;
    return deleteSessionsExcept(tx, principal.accountId, principal.sessionId);
  });
  deps.events.record({
    code: "staff.sessions_revoked",
    accountRef: principal.accountId,
  });
  return { kind: "REVOKED", endedCurrent: false, count, setCookies: [] };
}

/** Ends every session of the account and its assurance ("sign out everywhere"). */
export async function signOutStaffEverywhere(
  headers: Headers,
  deps: StaffAuthDependencies = defaultStaffDependencies(),
): Promise<StaffSessionCommandResult> {
  const principal = await resolveCurrentStaff(headers, deps);
  if (principal) {
    const count = await deps.db.transaction(async (tx) => {
      await lockAccountForUpdate(tx, principal.accountId);
      return deleteAllSessions(tx, principal.accountId);
    });
    deps.events.record({
      code: "staff.sessions_revoked",
      accountRef: principal.accountId,
    });
    return {
      kind: "REVOKED",
      endedCurrent: true,
      count,
      setCookies: expiredStaffCookies(deps),
    };
  }
  return {
    kind: "REVOKED",
    endedCurrent: true,
    count: 0,
    setCookies: expiredStaffCookies(deps),
  };
}

export type ChangeStaffPasswordResult =
  /** Every session ended; the staff member signs in again with MFA. */
  | Readonly<{ kind: "CHANGED"; setCookies: readonly string[] }>
  | Readonly<{ kind: "INVALID_INPUT"; password: readonly PasswordProblem[] }>
  | Readonly<{ kind: "CURRENT_PASSWORD_INVALID" }>
  /** Recent authentication is required first (RECENT_STAFF_AUTH). */
  | Readonly<{ kind: "REAUTHENTICATION_REQUIRED" }>
  | Readonly<{ kind: "UNAUTHENTICATED" }>
  | Readonly<{ kind: "RATE_LIMITED" }>;

/**
 * Password change for staff: requires recent MFA authentication
 * (RECENT_STAFF_AUTH) and the current password, then ends every session
 * and invalidates all issued assurance (account version increment).
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
  const principal = await resolveCurrentStaff(headers, deps);
  if (!principal) return { kind: "UNAUTHENTICATED" };
  const assurance = await evaluateStaffAssurance(
    principal,
    "RECENT_STAFF_AUTH",
    {},
    deps,
  );
  if (assurance.kind !== "ALLOW") {
    deps.events.record({
      code: "staff.reauth_challenged",
      category: "challenge",
      accountRef: principal.accountId,
    });
    return { kind: "REAUTHENTICATION_REQUIRED" };
  }
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
  });
  return { kind: "CHANGED", setCookies: expiredStaffCookies(deps) };
}

export type RegenerateBackupCodesResult =
  | Readonly<{ kind: "REGENERATED"; backupCodes: readonly string[] }>
  /** One generic failure for a wrong password or code. */
  | Readonly<{ kind: "INVALID" }>
  | Readonly<{ kind: "UNAUTHENTICATED" }>
  | Readonly<{ kind: "RATE_LIMITED" }>;

/**
 * Regenerates backup codes after an inline password + TOTP step-up bound to
 * this purpose (RECENT_STRONG_AUTH; a backup code never qualifies). Better
 * Auth replaces the stored codes, so every earlier code stops working.
 */
export async function regenerateStaffBackupCodes(
  input: Readonly<{ password: unknown; code: unknown }>,
  headers: Headers,
  deps: StaffAuthDependencies = defaultStaffDependencies(),
): Promise<RegenerateBackupCodesResult> {
  const principal = await resolveCurrentStaff(headers, deps);
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
  const assurance = await evaluateStaffAssurance(
    principal,
    "RECENT_STRONG_AUTH",
    { purpose: "REGENERATE_BACKUP_CODES" },
    deps,
  );
  if (assurance.kind !== "ALLOW") return { kind: "INVALID" };

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
  });
  return { kind: "REGENERATED", backupCodes: Object.freeze(codes) };
}

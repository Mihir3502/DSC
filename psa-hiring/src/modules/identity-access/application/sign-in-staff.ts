import "server-only";
import { clientKeyFrom } from "../infrastructure/action-rate-limiter";
import {
  findAccountByEmail,
  findAccountById,
} from "../infrastructure/account-repository";
import {
  authErrorCode,
  claimTotpCode,
  consumeStaffChallenge,
  findStaffChallenge,
  readCookie,
  readSetCookie,
  recordStaffChallenge,
} from "../infrastructure/better-auth-mfa-adapter";
import { withSessionIssuance } from "../infrastructure/session-issuance";
import {
  commandLogger,
  equalizePasswordWork,
  formString,
  setCookiesOf,
  tryNormalizeEmail,
} from "./candidate-auth-support";
import {
  challengeStore,
  clearTransientStaffSessions,
  defaultStaffDependencies,
  expiredStaffCookies,
  normalizeBackupCode,
  normalizeTotpCode,
  staffAuthHeaders,
  staffCookieNames,
  type StaffAuthDependencies,
} from "./staff-auth-support";

// Staff password-plus-MFA sign-in (packet M1.3 §11, AC-M1.3-05/08).
//
// First factor: one generic failure for unknown, candidate, service,
// invited, restricted, unenrolled, or wrong-password accounts. A valid
// password never yields a usable session: Better Auth's two-factor hook
// deletes the transient first-factor session and issues its signed,
// short-lived challenge cookie; the application records the challenge's
// account and first-factor time server-side.
//
// Second factor: TOTP or one backup code through Better Auth (per-challenge
// attempt limit and shared per-account lockout), plus an application TOTP
// replay guard. Trusted-device requests are never passed and a client-held
// trusted-device cookie is stripped. Success creates a new session stamped
// with server-owned assurance (method, first-factor and MFA times).

export type StaffSignInResult =
  | Readonly<{ kind: "MFA_REQUIRED"; setCookies: readonly string[] }>
  | Readonly<{ kind: "INVALID_CREDENTIALS" }>
  | Readonly<{ kind: "RATE_LIMITED" }>;

export async function signInStaff(
  input: Readonly<{ email: unknown; password: unknown }>,
  headers: Headers,
  deps: StaffAuthDependencies = defaultStaffDependencies(),
): Promise<StaffSignInResult> {
  const log = commandLogger(deps);
  const password = formString(input.password, 4096) ?? "";
  const email = tryNormalizeEmail(input.email);
  const client = clientKeyFrom(headers);
  if (
    !deps.limiter.consume("staffSignInPerClient", client) ||
    !deps.limiter.consume(
      "staffSignInPerClientEmail",
      client,
      email?.login ?? "invalid",
    )
  ) {
    deps.events.record({ code: "auth.rate_limited", category: "rate_limited" });
    return { kind: "RATE_LIMITED" };
  }

  const fail = (accountRef?: string): StaffSignInResult => {
    deps.events.record({
      code: "staff.sign_in_first_factor_failed",
      category: "invalid_credentials",
      accountRef,
    });
    log.info("staff.sign_in_rejected", { resultCode: "invalid_credentials" });
    return { kind: "INVALID_CREDENTIALS" };
  };

  if (!email || password.length === 0) {
    await equalizePasswordWork(deps, password || "-");
    return fail();
  }
  const account = await findAccountByEmail(deps.db, email.login);
  if (
    !account ||
    account.accountType !== "STAFF" ||
    account.status !== "ACTIVE" ||
    !account.emailVerified ||
    !account.twoFactorEnabled
  ) {
    await equalizePasswordWork(deps, password);
    return fail(account?.accountType === "STAFF" ? account.id : undefined);
  }

  const primaryAuthenticatedAt = new Date();
  const response = await withSessionIssuance(
    { kind: "STAFF_FIRST_FACTOR", accountId: account.id },
    () =>
      deps.auth.api.signInEmail({
        body: { email: email.login, password, rememberMe: true },
        headers: staffAuthHeaders(deps, headers),
        asResponse: true,
      }),
  );
  if (!response.ok) return fail(account.id);
  const body = (await response
    .clone()
    .json()
    .catch(() => null)) as {
    twoFactorRedirect?: unknown;
  } | null;
  const setCookies = setCookiesOf(response);
  const challengeCookie = readSetCookie(
    setCookies,
    staffCookieNames(deps).twoFactor,
  );
  if (body?.twoFactorRedirect !== true || !challengeCookie) {
    // Defense in depth: never let a staff password alone leave a session.
    await clearTransientStaffSessions(deps, account.id);
    log.warn("staff.sign_in_rejected", { resultCode: "challenge_missing" });
    return fail(account.id);
  }
  await recordStaffChallenge(
    await challengeStore(deps),
    challengeCookie,
    { accountId: account.id, primaryAuthenticatedAt },
    deps.env.AUTH_STAFF_MFA_CHALLENGE_SECONDS,
  );
  deps.events.record({
    code: "staff.sign_in_first_factor_succeeded",
    accountRef: account.id,
  });
  return { kind: "MFA_REQUIRED", setCookies };
}

export type StaffMfaResult =
  | Readonly<{
      kind: "SIGNED_IN";
      destination: "/staff/security";
      setCookies: readonly string[];
    }>
  | Readonly<{ kind: "INVALID_CODE" }>
  /** Temporary lockout (shared across TOTP and backup codes). */
  | Readonly<{ kind: "LOCKED" }>
  /** Missing, expired, exhausted, or foreign challenge: sign in again. */
  | Readonly<{ kind: "CHALLENGE_EXPIRED"; setCookies: readonly string[] }>
  | Readonly<{ kind: "RATE_LIMITED" }>;

export async function completeStaffMfa(
  input: Readonly<{ method: unknown; code: unknown }>,
  headers: Headers,
  deps: StaffAuthDependencies = defaultStaffDependencies(),
): Promise<StaffMfaResult> {
  if (!deps.limiter.consume("staffMfaPerClient", clientKeyFrom(headers))) {
    deps.events.record({ code: "auth.rate_limited", category: "rate_limited" });
    return { kind: "RATE_LIMITED" };
  }
  const expired = (): StaffMfaResult => ({
    kind: "CHALLENGE_EXPIRED",
    setCookies: expiredStaffCookies(deps),
  });
  const cookie = readCookie(headers, staffCookieNames(deps).twoFactor);
  if (!cookie) return expired();
  const store = await challengeStore(deps);
  const challenge = await findStaffChallenge(store, cookie);
  if (!challenge) return expired();
  const account = await findAccountById(deps.db, challenge.accountId);
  if (
    account?.accountType !== "STAFF" ||
    account.status !== "ACTIVE" ||
    !account.twoFactorEnabled
  ) {
    return expired();
  }

  const method = input.method === "backup" ? "backup" : "totp";
  const failure = (category: "invalid_code" | "replayed"): StaffMfaResult => {
    deps.events.record({
      code: "staff.mfa_challenge_failed",
      category,
      accountRef: account.id,
    });
    return { kind: "INVALID_CODE" };
  };
  const code =
    method === "totp"
      ? normalizeTotpCode(input.code)
      : normalizeBackupCode(input.code);
  if (!code) return failure("invalid_code");
  if (
    method === "totp" &&
    !(await claimTotpCode(
      deps.db,
      deps.env.BETTER_AUTH_SECRET,
      account.id,
      code,
    ))
  ) {
    return failure("replayed");
  }

  const issuance = {
    kind: "STAFF_MFA",
    accountId: account.id,
    method: method === "totp" ? "PASSWORD_TOTP" : "PASSWORD_BACKUP_CODE",
    primaryAuthenticatedAt: challenge.primaryAuthenticatedAt,
    mfaAuthenticatedAt: new Date(),
  } as const;
  const authHeaders = staffAuthHeaders(deps, headers);
  // Only the code is sent: trustDevice is never requested (packet §6.3).
  const response = await withSessionIssuance(issuance, () =>
    method === "totp"
      ? deps.auth.api.verifyTOTP({
          body: { code },
          headers: authHeaders,
          asResponse: true,
        })
      : deps.auth.api.verifyBackupCode({
          body: { code },
          headers: authHeaders,
          asResponse: true,
        }),
  );
  if (!response.ok) {
    const error = await authErrorCode(response);
    if (error === "ACCOUNT_TEMPORARILY_LOCKED") {
      deps.events.record({
        code: "staff.mfa_locked",
        category: "locked",
        accountRef: account.id,
      });
      return { kind: "LOCKED" };
    }
    if (
      error === "TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE" ||
      error === "INVALID_TWO_FACTOR_COOKIE"
    ) {
      await consumeStaffChallenge(store, cookie);
      deps.events.record({
        code: "staff.mfa_challenge_failed",
        category: "expired",
        accountRef: account.id,
      });
      return expired();
    }
    return failure("invalid_code");
  }

  await consumeStaffChallenge(store, cookie);
  if (method === "backup") {
    deps.events.record({
      code: "staff.backup_code_used",
      accountRef: account.id,
    });
  }
  deps.events.record({
    code: "staff.mfa_challenge_succeeded",
    accountRef: account.id,
  });
  return {
    kind: "SIGNED_IN",
    destination: "/staff/security",
    setCookies: setCookiesOf(response),
  };
}

/** True when the browser holds a staff challenge cookie (page gating only). */
export function hasStaffChallenge(
  headers: Headers,
  deps: StaffAuthDependencies = defaultStaffDependencies(),
): boolean {
  return readCookie(headers, staffCookieNames(deps).twoFactor) !== null;
}

export type StaffSignOutResult = Readonly<{ setCookies: readonly string[] }>;

/** Revokes the current session and clears every staff auth cookie. */
export async function signOutStaff(
  headers: Headers,
  deps: StaffAuthDependencies = defaultStaffDependencies(),
): Promise<StaffSignOutResult> {
  try {
    await deps.auth.api.signOut({ headers, asResponse: true });
  } catch {
    // No or invalid session: nothing to revoke.
  }
  deps.events.record({ code: "staff.sign_out" });
  return { setCookies: expiredStaffCookies(deps) };
}

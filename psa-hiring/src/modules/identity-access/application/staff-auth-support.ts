import "server-only";
import { deleteSessionsByPurpose } from "../infrastructure/account-repository";
import {
  trustDeviceCookieName,
  twoFactorCookieName,
  withoutCookies,
  type ChallengeStore,
} from "../infrastructure/better-auth-mfa-adapter";
import {
  defaultDependencies,
  type CandidateAuthDependencies,
} from "./candidate-auth-support";

// Shared helpers for staff authentication commands (packet M1.3).

export type StaffAuthDependencies = CandidateAuthDependencies;

export function defaultStaffDependencies(): StaffAuthDependencies {
  return defaultDependencies();
}

export function staffCookieNames(deps: StaffAuthDependencies) {
  const secure = deps.env.secureCookies;
  return {
    session: `${secure ? "__Secure-" : ""}psa.session_token`,
    twoFactor: twoFactorCookieName(secure),
    trustDevice: trustDeviceCookieName(secure),
  } as const;
}

/**
 * Request headers for a staff Better Auth call: a client-held trusted-device
 * cookie is always removed, so it can never skip the second factor
 * (packet M1.3 §6.3), and optionally a just-issued session cookie replaces
 * the incoming one within the same server action.
 */
export function staffAuthHeaders(
  deps: StaffAuthDependencies,
  headers: Headers,
  replaceSessionCookie?: string,
): Headers {
  const names = staffCookieNames(deps);
  const drop: string[] = [names.trustDevice];
  if (replaceSessionCookie) drop.push(names.session);
  return withoutCookies(headers, drop, replaceSessionCookie);
}

/** Expires every staff authentication cookie in the browser. */
export function expiredStaffCookies(deps: StaffAuthDependencies): string[] {
  const names = staffCookieNames(deps);
  const secure = deps.env.secureCookies ? "; Secure" : "";
  return [names.session, names.twoFactor, names.trustDevice].map(
    (name) => `${name}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax${secure}`,
  );
}

/** "name=value" for a Set-Cookie of the session cookie, for chained calls. */
export function sessionCookiePair(
  deps: StaffAuthDependencies,
  setCookies: readonly string[],
): string | undefined {
  const name = staffCookieNames(deps).session;
  const header = setCookies.find((c) => c.startsWith(`${name}=`));
  const pair = header?.split(";")[0];
  return pair && pair.length > name.length + 1 ? pair : undefined;
}

export async function challengeStore(
  deps: StaffAuthDependencies,
): Promise<ChallengeStore> {
  return (await deps.auth.$context).internalAdapter;
}

/** Removes transient first-factor/enrollment sessions of an account. */
export async function clearTransientStaffSessions(
  deps: StaffAuthDependencies,
  accountId: string,
): Promise<void> {
  await deleteSessionsByPurpose(deps.db, accountId, [
    "STAFF_FIRST_FACTOR",
    "STAFF_ACTIVATION",
  ]);
}

/** A TOTP code as typed: digits only, spaces removed. */
export function normalizeTotpCode(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 32) return null;
  const code = value.replace(/\s+/g, "");
  return /^\d{6}$/.test(code) ? code : null;
}

/**
 * A backup code as typed: surrounding/inner whitespace removed and the
 * hyphen restored when omitted. Case is preserved (codes are mixed case).
 */
export function normalizeBackupCode(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 64) return null;
  const compact = value.replace(/\s+/g, "");
  const withHyphen = /^[A-Za-z0-9]{10}$/.test(compact)
    ? `${compact.slice(0, 5)}-${compact.slice(5)}`
    : compact;
  return /^[A-Za-z0-9]{5}-[A-Za-z0-9]{5}$/.test(withHyphen) ? withHyphen : null;
}

import { canSignInInteractively } from "./account-policy";
import type { AccountStatus, AccountType } from "./account-types";
import type { AuthenticationMethod } from "./authentication-assurance";

// Which sessions may exist, and what assurance each carries (packet M1.3
// §6.1, §9, §11, AC-M1.3-04/08). Pure functions only (ESLint-enforced).
//
// Better Auth asks the session-creation hook before inserting any session.
// The hook passes the account and the *server-declared* issuance intent of
// the running application command to decideSessionIssuance. A staff
// account never receives a session outside an approved staff command, and
// only an MFA-complete STAFF session can later resolve a staff principal.

export const sessionPurposes = [
  /** Candidate session (M1.2). */
  "STANDARD",
  /** Transient: Better Auth's two-factor hook deletes it immediately. */
  "STAFF_FIRST_FACTOR",
  /** Invitation-bound enrollment context for an INVITED staff account. */
  "STAFF_ACTIVATION",
  /** MFA-complete staff session. */
  "STAFF",
] as const;
export type SessionPurpose = (typeof sessionPurposes)[number];

export type SessionIssuance =
  | Readonly<{ kind: "STAFF_FIRST_FACTOR"; accountId: string }>
  | Readonly<{
      kind: "STAFF_ACTIVATION";
      accountId: string;
      primaryAuthenticatedAt: Date;
      /** Set once the first TOTP code verified during enrollment. */
      mfaAuthenticatedAt?: Date;
    }>
  | Readonly<{
      kind: "STAFF_MFA";
      accountId: string;
      method: "PASSWORD_TOTP" | "PASSWORD_BACKUP_CODE";
      primaryAuthenticatedAt: Date;
      mfaAuthenticatedAt: Date;
    }>;

export type IssuanceAccount = Readonly<{
  id: string;
  accountType: AccountType;
  status: AccountStatus;
  emailVerified: boolean;
  twoFactorEnabled: boolean;
  version: number;
}>;

export type SessionStamp = Readonly<{
  authPurpose: SessionPurpose;
  authMethod: AuthenticationMethod;
  primaryAuthenticatedAt: Date;
  mfaAuthenticatedAt: Date | null;
  accountVersion: number;
}>;

/** Returns the assurance to stamp on the new session, or null to refuse it. */
export function decideSessionIssuance(
  account: IssuanceAccount | null,
  issuance: SessionIssuance | undefined,
  now: Date,
): SessionStamp | null {
  if (!account || account.accountType === "SERVICE") return null;

  if (!issuance) {
    // Candidate sign-in (M1.2) is the only path without a declared intent.
    if (account.accountType !== "CANDIDATE") return null;
    if (!canSignInInteractively(account)) return null;
    return {
      authPurpose: "STANDARD",
      authMethod: "PASSWORD",
      primaryAuthenticatedAt: now,
      mfaAuthenticatedAt: null,
      accountVersion: account.version,
    };
  }

  if (account.id !== issuance.accountId || account.accountType !== "STAFF") {
    return null;
  }
  if (!account.emailVerified) return null;

  switch (issuance.kind) {
    case "STAFF_FIRST_FACTOR":
      if (account.status !== "ACTIVE" || !account.twoFactorEnabled) return null;
      return {
        authPurpose: "STAFF_FIRST_FACTOR",
        authMethod: "PASSWORD",
        primaryAuthenticatedAt: now,
        mfaAuthenticatedAt: null,
        accountVersion: account.version,
      };
    case "STAFF_ACTIVATION":
      if (account.status !== "INVITED") return null;
      return {
        authPurpose: "STAFF_ACTIVATION",
        authMethod: issuance.mfaAuthenticatedAt ? "PASSWORD_TOTP" : "PASSWORD",
        primaryAuthenticatedAt: issuance.primaryAuthenticatedAt,
        mfaAuthenticatedAt: issuance.mfaAuthenticatedAt ?? null,
        accountVersion: account.version,
      };
    case "STAFF_MFA":
      if (account.status !== "ACTIVE" || !account.twoFactorEnabled) return null;
      return {
        authPurpose: "STAFF",
        authMethod: issuance.method,
        primaryAuthenticatedAt: issuance.primaryAuthenticatedAt,
        mfaAuthenticatedAt: issuance.mfaAuthenticatedAt,
        accountVersion: account.version,
      };
  }
}

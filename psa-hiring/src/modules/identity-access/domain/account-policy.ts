import type {
  AccountStatus,
  AccountType,
  RestrictedStatus,
} from "./account-types";

// Account-state policy (packet M1.1 §7.4–7.5). Pure functions only.

export type AccountState = Readonly<{
  accountType: AccountType;
  status: AccountStatus;
}>;

/**
 * Only ACTIVE, non-service accounts may hold or resolve an interactive
 * session. Email verification is a separate, independent condition.
 */
export function canResolvePrincipal(account: AccountState): boolean {
  return account.status === "ACTIVE" && account.accountType !== "SERVICE";
}

/** Interactive email/password sign-in follows the same rule. */
export function canSignInInteractively(account: AccountState): boolean {
  return canResolvePrincipal(account);
}

export type RestrictionDecision =
  { kind: "apply" } | { kind: "already-applied" } | { kind: "not-allowed" };

/**
 * Restriction transitions: any non-closed account may become LOCKED,
 * DISABLED, or CLOSED. CLOSED is terminal. Re-applying the current state is
 * idempotent.
 */
export function decideRestriction(
  current: AccountStatus,
  target: RestrictedStatus,
): RestrictionDecision {
  if (current === target) return { kind: "already-applied" };
  if (current === "CLOSED") return { kind: "not-allowed" };
  return { kind: "apply" };
}

/**
 * Verified email is independent of account status. Future sensitive
 * candidate actions require it (M1.2+); M1.1 exposes the check only.
 */
export function hasVerifiedEmail(principal: {
  emailVerified: boolean;
}): boolean {
  return principal.emailVerified === true;
}

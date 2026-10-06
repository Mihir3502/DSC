// Closed account vocabularies. Framework-neutral: no Better Auth, Next.js,
// Drizzle, HTTP, or logger imports (enforced by ESLint).

export const accountTypes = ["CANDIDATE", "STAFF", "SERVICE"] as const;
export type AccountType = (typeof accountTypes)[number];

export const accountStatuses = [
  "INVITED",
  "ACTIVE",
  "LOCKED",
  "DISABLED",
  "CLOSED",
] as const;
export type AccountStatus = (typeof accountStatuses)[number];

/** Statuses that carry restriction metadata (disabled_at + reason code). */
export const restrictedStatuses = ["LOCKED", "DISABLED", "CLOSED"] as const;
export type RestrictedStatus = (typeof restrictedStatuses)[number];

/** Initial closed set of safe restriction reason codes. */
export const restrictionReasonCodes = [
  "SECURITY_LOCK",
  "ADMINISTRATIVE_DISABLE",
  "ACCOUNT_CLOSED",
] as const;
export type RestrictionReasonCode = (typeof restrictionReasonCodes)[number];

export const reasonCodeFor: Readonly<
  Record<RestrictedStatus, RestrictionReasonCode>
> = Object.freeze({
  LOCKED: "SECURITY_LOCK",
  DISABLED: "ADMINISTRATIVE_DISABLE",
  CLOSED: "ACCOUNT_CLOSED",
});

export function isAccountType(value: unknown): value is AccountType {
  return (
    typeof value === "string" &&
    (accountTypes as readonly string[]).includes(value)
  );
}

export function isAccountStatus(value: unknown): value is AccountStatus {
  return (
    typeof value === "string" &&
    (accountStatuses as readonly string[]).includes(value)
  );
}

import type { AccountStatus, AccountType } from "./account-types";

// Staff invitation lifecycle policy (packet M1.3 §7, §9). Pure functions
// only: no Better Auth, Next.js, Drizzle, HTTP, or logger imports (enforced
// by ESLint). Persistence and concurrency live in the repository; these
// rules decide what a state change may do.

export const staffInvitationStatuses = [
  "PENDING",
  "ACCEPTED",
  "REVOKED",
  "EXPIRED",
  "SUPERSEDED",
] as const;
export type StaffInvitationStatus = (typeof staffInvitationStatuses)[number];

export const staffInvitationPurposes = [
  "STAFF_ACTIVATION",
  "STAFF_REENROLLMENT",
] as const;
export type StaffInvitationPurpose = (typeof staffInvitationPurposes)[number];

/**
 * Who issued an invitation. M1.3 has no authorized staff administrator yet
 * (roles arrive in M1.4), so only nonproduction bootstrap/test issuers and
 * the recovery reenrollment effect exist.
 */
export const invitationIssuerReasons = [
  "LOCAL_BOOTSTRAP",
  "TEST_HARNESS",
  "RECOVERY_REENROLLMENT",
] as const;
export type InvitationIssuerReason = (typeof invitationIssuerReasons)[number];

export type InvitationSnapshot = Readonly<{
  status: StaffInvitationStatus;
  purpose: StaffInvitationPurpose;
  expiresAt: Date;
  /** Bound account, once activation started or for reenrollment. */
  accountId: string | null;
}>;

export function isTerminalInvitation(status: StaffInvitationStatus): boolean {
  return status !== "PENDING";
}

/** A PENDING invitation stops being live exactly at its expiry instant. */
export function isLiveInvitation(
  invitation: InvitationSnapshot,
  now: Date,
): boolean {
  return (
    invitation.status === "PENDING" &&
    now.getTime() < invitation.expiresAt.getTime()
  );
}

export type InvitationTransition = "ACCEPT" | "REVOKE" | "SUPERSEDE" | "EXPIRE";

export type InvitationDecision =
  | Readonly<{ kind: "apply"; to: StaffInvitationStatus }>
  | Readonly<{ kind: "expired" }>
  | Readonly<{ kind: "not-allowed" }>;

/**
 * Terminal records never change. An expired PENDING invitation can only
 * become EXPIRED: accepting, revoking, or superseding it reports `expired`
 * so callers record the expiry instead.
 */
export function decideInvitationTransition(
  invitation: InvitationSnapshot,
  transition: InvitationTransition,
  now: Date,
): InvitationDecision {
  if (isTerminalInvitation(invitation.status)) return { kind: "not-allowed" };
  const live = isLiveInvitation(invitation, now);
  switch (transition) {
    case "EXPIRE":
      return live ? { kind: "not-allowed" } : { kind: "apply", to: "EXPIRED" };
    case "ACCEPT":
      return live ? { kind: "apply", to: "ACCEPTED" } : { kind: "expired" };
    case "REVOKE":
      return live ? { kind: "apply", to: "REVOKED" } : { kind: "expired" };
    case "SUPERSEDE":
      return live ? { kind: "apply", to: "SUPERSEDED" } : { kind: "expired" };
  }
}

export type ExistingAccount = Readonly<{
  id: string;
  accountType: AccountType;
  status: AccountStatus;
}>;

/**
 * Whether an invitation may be issued for the account (if any) that already
 * owns the normalized email. Candidate and service accounts are never
 * converted to staff, and active or restricted staff are never duplicated;
 * callers answer every refusal with the same nonenumerating outcome.
 */
export function canIssueStaffInvitation(
  existing: ExistingAccount | null,
  purpose: StaffInvitationPurpose,
): boolean {
  if (purpose === "STAFF_ACTIVATION") {
    return (
      existing === null ||
      (existing.accountType === "STAFF" && existing.status === "INVITED")
    );
  }
  return existing?.accountType === "STAFF" && existing.status === "INVITED";
}

export type ActivationDecision =
  | Readonly<{ kind: "CREATE" }>
  | Readonly<{ kind: "RESUME"; accountId: string }>
  | Readonly<{ kind: "NOT_ELIGIBLE" }>;

/**
 * How a live invitation may be used: create the single STAFF account, or
 * resume an INVITED staff account bound to this invitation (abandoned
 * activation or recovery reenrollment). Anything else is refused.
 */
export function decideActivation(
  invitation: InvitationSnapshot,
  existing: ExistingAccount | null,
): ActivationDecision {
  if (existing === null) {
    return invitation.purpose === "STAFF_ACTIVATION" &&
      invitation.accountId === null
      ? { kind: "CREATE" }
      : { kind: "NOT_ELIGIBLE" };
  }
  if (existing.accountType !== "STAFF" || existing.status !== "INVITED") {
    return { kind: "NOT_ELIGIBLE" };
  }
  if (invitation.accountId !== null && invitation.accountId !== existing.id) {
    return { kind: "NOT_ELIGIBLE" };
  }
  if (invitation.purpose === "STAFF_REENROLLMENT" && !invitation.accountId) {
    return { kind: "NOT_ELIGIBLE" };
  }
  return { kind: "RESUME", accountId: existing.id };
}

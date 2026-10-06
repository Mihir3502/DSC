// Staff recovery / MFA-reset case state machine (packet M1.3 §14). Pure
// functions only: no Better Auth, Next.js, Drizzle, HTTP, or logger imports
// (enforced by ESLint). Identity verification happens outside the
// application under approved policy; the case records only who verified,
// who approved, when, and safe codes.

export const staffRecoveryStatuses = [
  "REQUESTED",
  "IDENTITY_VERIFICATION_PENDING",
  "APPROVAL_PENDING",
  "APPROVED",
  "COMPLETED",
  "REJECTED",
  "EXPIRED",
  "CANCELLED",
] as const;
export type StaffRecoveryStatus = (typeof staffRecoveryStatuses)[number];

export const openRecoveryStatuses: readonly StaffRecoveryStatus[] = [
  "REQUESTED",
  "IDENTITY_VERIFICATION_PENDING",
  "APPROVAL_PENDING",
  "APPROVED",
];

export const recoveryReasonCodes = [
  "LOST_AUTHENTICATOR",
  "FORGOTTEN_PASSWORD",
  "SUSPECTED_COMPROMISE",
  "UNSPECIFIED",
] as const;
export type RecoveryReasonCode = (typeof recoveryReasonCodes)[number];

export function isRecoveryReasonCode(
  value: unknown,
): value is RecoveryReasonCode {
  return (
    typeof value === "string" &&
    (recoveryReasonCodes as readonly string[]).includes(value)
  );
}

export const recoveryResolutionCodes = [
  "RESET_COMPLETED",
  "IDENTITY_NOT_VERIFIED",
  "APPROVAL_DENIED",
  "REQUEST_CANCELLED",
  "REQUEST_EXPIRED",
  "APPROVAL_EXPIRED",
] as const;
export type RecoveryResolutionCode = (typeof recoveryResolutionCodes)[number];

export type RecoveryCaseSnapshot = Readonly<{
  status: StaffRecoveryStatus;
  /** The staff account being recovered. */
  accountId: string;
  expiresAt: Date;
  verifierAccountId: string | null;
  approverAccountId: string | null;
  approvalExpiresAt: Date | null;
}>;

export type RecoveryCommand = Readonly<{
  type:
    | "START_VERIFICATION"
    | "CONFIRM_IDENTITY"
    | "APPROVE"
    | "REJECT"
    | "CANCEL"
    | "COMPLETE";
  /** The authorized staff member performing the step. */
  actorAccountId: string;
}>;

export type RecoveryDenialReason =
  | "TERMINAL"
  | "INVALID_TRANSITION"
  | "SELF_ACTION"
  | "NOT_ASSIGNED_VERIFIER"
  | "VERIFIER_CANNOT_APPROVE";

export type RecoveryDecision =
  | Readonly<{
      kind: "apply";
      to: StaffRecoveryStatus;
      resolution?: RecoveryResolutionCode;
      /** Role the actor fills in this step (recorded on the case). */
      actorRole?: "VERIFIER" | "APPROVER" | "COMPLETER";
    }>
  /** The case lapsed; callers record EXPIRED with this resolution. */
  | Readonly<{ kind: "expired"; resolution: RecoveryResolutionCode }>
  | Readonly<{ kind: "denied"; reason: RecoveryDenialReason }>;

export function isOpenRecovery(status: StaffRecoveryStatus): boolean {
  return openRecoveryStatuses.includes(status);
}

/**
 * Decides one administrative step. Separation of duties is part of the
 * policy: nobody acts on their own case, only the assigned verifier
 * confirms identity, and the approver must differ from the verifier. An
 * approval itself expires if completion does not follow in time.
 */
export function decideRecoveryTransition(
  current: RecoveryCaseSnapshot,
  command: RecoveryCommand,
  now: Date,
): RecoveryDecision {
  if (!isOpenRecovery(current.status)) {
    return { kind: "denied", reason: "TERMINAL" };
  }
  if (now.getTime() >= current.expiresAt.getTime()) {
    return { kind: "expired", resolution: "REQUEST_EXPIRED" };
  }
  if (
    current.status === "APPROVED" &&
    current.approvalExpiresAt &&
    now.getTime() >= current.approvalExpiresAt.getTime()
  ) {
    return { kind: "expired", resolution: "APPROVAL_EXPIRED" };
  }
  if (command.actorAccountId === current.accountId) {
    return { kind: "denied", reason: "SELF_ACTION" };
  }

  switch (command.type) {
    case "START_VERIFICATION":
      return current.status === "REQUESTED"
        ? {
            kind: "apply",
            to: "IDENTITY_VERIFICATION_PENDING",
            actorRole: "VERIFIER",
          }
        : { kind: "denied", reason: "INVALID_TRANSITION" };
    case "CONFIRM_IDENTITY":
      if (current.status !== "IDENTITY_VERIFICATION_PENDING") {
        return { kind: "denied", reason: "INVALID_TRANSITION" };
      }
      return command.actorAccountId === current.verifierAccountId
        ? { kind: "apply", to: "APPROVAL_PENDING" }
        : { kind: "denied", reason: "NOT_ASSIGNED_VERIFIER" };
    case "APPROVE":
      if (current.status !== "APPROVAL_PENDING") {
        return { kind: "denied", reason: "INVALID_TRANSITION" };
      }
      return command.actorAccountId === current.verifierAccountId
        ? { kind: "denied", reason: "VERIFIER_CANNOT_APPROVE" }
        : { kind: "apply", to: "APPROVED", actorRole: "APPROVER" };
    case "REJECT":
      return {
        kind: "apply",
        to: "REJECTED",
        resolution:
          current.status === "APPROVAL_PENDING" || current.status === "APPROVED"
            ? "APPROVAL_DENIED"
            : "IDENTITY_NOT_VERIFIED",
      };
    case "CANCEL":
      return {
        kind: "apply",
        to: "CANCELLED",
        resolution: "REQUEST_CANCELLED",
      };
    case "COMPLETE":
      return current.status === "APPROVED"
        ? {
            kind: "apply",
            to: "COMPLETED",
            resolution: "RESET_COMPLETED",
            actorRole: "COMPLETER",
          }
        : { kind: "denied", reason: "INVALID_TRANSITION" };
  }
}

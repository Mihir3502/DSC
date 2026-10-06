import "server-only";
import {
  decideRecoveryTransition,
  isRecoveryReasonCode,
  type RecoveryCommand,
  type RecoveryDenialReason,
  type StaffRecoveryStatus,
} from "../domain/staff-recovery";
import { clientKeyFrom } from "../infrastructure/action-rate-limiter";
import {
  deleteAllSessions,
  findAccountByEmail,
  findAccountById,
  findAccountEmail,
  lockAccountForUpdate,
  returnStaffToInvited,
} from "../infrastructure/account-repository";
import { removeTwoFactorEnrollment } from "../infrastructure/better-auth-mfa-adapter";
import type { AuthEmailMessage } from "../infrastructure/auth-email";
import type {
  StaffAdministrationAction,
  StaffAdministrationActor,
} from "../infrastructure/staff-administration-gate";
import {
  findRecoveryCase,
  insertRecoveryCase,
  updateRecoveryCase,
} from "../infrastructure/staff-recovery-repository";
import { tryNormalizeEmail } from "./candidate-auth-support";
import { issueInvitationInTransaction } from "./issue-staff-invitation";
import {
  defaultStaffDependencies,
  type StaffAuthDependencies,
} from "./staff-auth-support";

// Controlled staff recovery / MFA reset (packet M1.3 §14, AC-M1.3-10).
//
// Staff never use candidate self-service recovery. A public request only
// opens a bounded case for an eligible staff account and always returns the
// same confirmation. Every later step (verification, approval, rejection,
// completion) requires an explicit actor and the staff administration
// gate, which refuses in the running application until M1.4–M1.6 add
// authorization, separation-of-duty adapters, and immutable audit. Only the
// local/test harness can drive cases today; there is no production route.

export type RequestStaffRecoveryResult =
  | Readonly<{ kind: "SUBMITTED" }>
  | Readonly<{ kind: "INVALID_INPUT" }>
  | Readonly<{ kind: "RATE_LIMITED" }>;

export async function requestStaffRecovery(
  input: Readonly<{ email: unknown; reason: unknown }>,
  headers: Headers,
  deps: StaffAuthDependencies = defaultStaffDependencies(),
): Promise<RequestStaffRecoveryResult> {
  if (!deps.limiter.consume("staffRecoveryPerClient", clientKeyFrom(headers))) {
    deps.events.record({ code: "auth.rate_limited", category: "rate_limited" });
    return { kind: "RATE_LIMITED" };
  }
  const email = tryNormalizeEmail(input.email);
  if (!email) return { kind: "INVALID_INPUT" };
  const reason = isRecoveryReasonCode(input.reason)
    ? input.reason
    : "UNSPECIFIED";
  // Silent cap: the response never changes, only case creation stops.
  if (!deps.limiter.consume("staffRecoveryPerEmail", email.login)) {
    return { kind: "SUBMITTED" };
  }
  const account = await findAccountByEmail(deps.db, email.login);
  if (account?.accountType === "STAFF" && account.status === "ACTIVE") {
    const now = new Date();
    const caseId = await deps.db.transaction((tx) =>
      insertRecoveryCase(tx, {
        accountId: account.id,
        reasonCode: reason,
        requestedAt: now,
        expiresAt: new Date(
          now.getTime() +
            deps.env.AUTH_STAFF_RECOVERY_EXPIRES_IN_SECONDS * 1000,
        ),
      }),
    );
    if (caseId) {
      deps.events.record({
        code: "staff.recovery_requested",
        accountRef: account.id,
        recordRef: caseId,
      });
    }
  } else {
    deps.events.record({
      code: "staff.recovery_requested",
      category: "not_eligible",
    });
  }
  return { kind: "SUBMITTED" };
}

const actionFor: Record<RecoveryCommand["type"], StaffAdministrationAction> = {
  START_VERIFICATION: "RECOVERY_START_VERIFICATION",
  CONFIRM_IDENTITY: "RECOVERY_CONFIRM_IDENTITY",
  APPROVE: "RECOVERY_APPROVE",
  REJECT: "RECOVERY_REJECT",
  CANCEL: "RECOVERY_CANCEL",
  COMPLETE: "RECOVERY_COMPLETE",
};

const eventFor = {
  IDENTITY_VERIFICATION_PENDING: "staff.recovery_verification_started",
  APPROVAL_PENDING: "staff.recovery_identity_verified",
  APPROVED: "staff.recovery_approved",
  REJECTED: "staff.recovery_rejected",
  CANCELLED: "staff.recovery_cancelled",
  COMPLETED: "staff.recovery_completed",
  EXPIRED: "staff.recovery_expired",
} as const;

export type AdvanceStaffRecoveryResult =
  | Readonly<{ kind: "UPDATED"; status: StaffRecoveryStatus }>
  | Readonly<{ kind: "EXPIRED" }>
  | Readonly<{
      kind: "DENIED";
      reason: RecoveryDenialReason | "ACCOUNT_NOT_ELIGIBLE";
    }>
  | Readonly<{ kind: "NOT_FOUND" }>
  | Readonly<{ kind: "NOT_AUTHORIZED" }>
  /** Lost a concurrent update; reload and retry. */
  | Readonly<{ kind: "CONFLICT" }>;

class Denied extends Error {
  constructor(readonly reason: "ACCOUNT_NOT_ELIGIBLE") {
    super(reason);
  }
}

/**
 * Applies one administrative step to a recovery case. Completion, in one
 * transaction: every session revoked; TOTP enrollment, backup codes, and
 * pending challenge/trusted-device records removed; the account returned
 * to INVITED (version incremented, so no earlier assurance remains valid);
 * and a short-lived single-use reenrollment invitation issued. Reenrollment
 * always sets a new password and requires fresh MFA before ACTIVE.
 */
export async function advanceStaffRecovery(
  input: Readonly<{
    caseId: string;
    actor: StaffAdministrationActor;
    command: RecoveryCommand["type"];
  }>,
  deps: StaffAuthDependencies = defaultStaffDependencies(),
): Promise<AdvanceStaffRecoveryResult> {
  const action = actionFor[input.command];
  if (
    !action ||
    input.actor.kind !== "ACCOUNT" ||
    !deps.staffAdmin.allows(input.actor, action)
  ) {
    deps.events.record({ code: "staff.recovery_denied", category: "denied" });
    return { kind: "NOT_AUTHORIZED" };
  }
  const actorId = input.actor.accountId;
  const actor = await findAccountById(deps.db, actorId);
  if (actor?.accountType !== "STAFF" || actor.status !== "ACTIVE") {
    deps.events.record({ code: "staff.recovery_denied", category: "denied" });
    return { kind: "NOT_AUTHORIZED" };
  }

  const now = new Date();
  let pendingEmail: AuthEmailMessage | null = null;
  let result: AdvanceStaffRecoveryResult;
  try {
    result = await deps.db.transaction(async (tx) => {
      const row = await findRecoveryCase(tx, input.caseId, true);
      if (!row) return { kind: "NOT_FOUND" } as const;
      const decision = decideRecoveryTransition(
        row,
        { type: input.command, actorAccountId: actorId },
        now,
      );
      if (decision.kind === "denied") {
        return { kind: "DENIED", reason: decision.reason } as const;
      }
      if (decision.kind === "expired") {
        await updateRecoveryCase(tx, row, {
          to: "EXPIRED",
          at: now,
          resolution: decision.resolution,
        });
        return { kind: "EXPIRED" } as const;
      }

      if (decision.to === "COMPLETED") {
        const target = await lockAccountForUpdate(tx, row.accountId);
        if (!target || !(await returnStaffToInvited(tx, row.accountId, now))) {
          throw new Denied("ACCOUNT_NOT_ELIGIBLE");
        }
        await deleteAllSessions(tx, row.accountId);
        await removeTwoFactorEnrollment(tx, row.accountId);
        const email = await findAccountEmail(tx, row.accountId);
        if (!email) throw new Denied("ACCOUNT_NOT_ELIGIBLE");
        const issued = await issueInvitationInTransaction(tx, deps, {
          email,
          emailDisplay: email,
          purpose: "STAFF_REENROLLMENT",
          issuerReasonCode: "RECOVERY_REENROLLMENT",
          accountId: row.accountId,
          recoveryCaseId: row.id,
          now,
        });
        if (!issued) throw new Denied("ACCOUNT_NOT_ELIGIBLE");
        pendingEmail = issued.email;
      }

      const applied = await updateRecoveryCase(tx, row, {
        to: decision.to,
        at: now,
        resolution: decision.resolution,
        ...(decision.actorRole === "VERIFIER"
          ? { verifierAccountId: actorId }
          : {}),
        ...(decision.actorRole === "APPROVER"
          ? {
              approverAccountId: actorId,
              approvalExpiresAt: new Date(
                now.getTime() +
                  deps.env.AUTH_STAFF_RECOVERY_APPROVAL_SECONDS * 1000,
              ),
            }
          : {}),
        ...(decision.actorRole === "COMPLETER"
          ? { completedByAccountId: actorId }
          : {}),
      });
      if (!applied) throw new Error("recovery case changed concurrently");
      return { kind: "UPDATED", status: decision.to } as const;
    });
  } catch (error) {
    if (error instanceof Denied) {
      result = { kind: "DENIED", reason: error.reason };
    } else if (
      error instanceof Error &&
      error.message === "recovery case changed concurrently"
    ) {
      result = { kind: "CONFLICT" };
    } else {
      throw error;
    }
  }

  if (pendingEmail) deps.email.enqueue(pendingEmail);
  const recordRef = /^[0-9a-f-]{36}$/i.test(input.caseId)
    ? input.caseId
    : undefined;
  if (result.kind === "UPDATED") {
    const code = eventFor[result.status as keyof typeof eventFor];
    if (code) deps.events.record({ code, accountRef: actorId, recordRef });
    if (result.status === "COMPLETED") {
      deps.events.record({ code: "staff.mfa_reset", recordRef });
    }
  } else if (result.kind === "EXPIRED") {
    deps.events.record({ code: "staff.recovery_expired", recordRef });
  } else {
    deps.events.record({
      code: "staff.recovery_denied",
      category: "denied",
      accountRef: actorId,
      recordRef,
    });
  }
  return result;
}

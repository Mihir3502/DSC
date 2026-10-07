import "server-only";
import {
  withAuditedTransaction,
  type SystemActor,
  type TransactionAudit,
} from "@/modules/audit";
import type { Database } from "@/shared/database";
import {
  canIssueStaffInvitation,
  decideInvitationTransition,
  type InvitationIssuerReason,
  type StaffInvitationPurpose,
} from "../domain/staff-invitation";
import {
  deleteAllSessions,
  findAccountByEmail,
  lockAccountForUpdate,
} from "../infrastructure/account-repository";
import type { AuthEmailMessage } from "../infrastructure/auth-email";
import type { StaffAdministrationActor } from "../infrastructure/staff-administration-gate";
import {
  digestInvitationToken,
  findInvitationById,
  insertInvitation,
  linkSupersededInvitation,
  lockInvitationEmail,
  lockPendingInvitationForEmail,
  newInvitationToken,
  transitionInvitation,
} from "../infrastructure/staff-invitation-repository";
import { tryNormalizeEmail } from "./candidate-auth-support";
import {
  defaultStaffDependencies,
  type StaffAuthDependencies,
} from "./staff-auth-support";

// Staff invitation lifecycle commands (packet M1.3 §7–§8, AC-M1.3-01/02/03).
// Every command requires an explicit actor and the staff administration
// gate. The running application uses the refusing gate until M1.4–M1.6
// authorization and audit exist, so issuance and revocation are reachable
// only from the local bootstrap script and tests. There is no route.

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

/** Who issued or revoked: an acting account, or a bounded system actor. */
export type InvitationActorFacts =
  Readonly<{ actorRef: string }> | Readonly<{ systemActor: SystemActor }>;

export function invitationActorFacts(
  actor: StaffAdministrationActor,
): InvitationActorFacts {
  if (actor.kind === "ACCOUNT") return { actorRef: actor.accountId };
  return {
    systemActor:
      actor.reason === "TEST_HARNESS" ? "TEST_HARNESS" : "SYSTEM_PROCESS",
  };
}

const uuidShape =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type IssueStaffInvitationResult =
  /**
   * Uniform outcome whether or not an invitation was created: existing
   * candidate/service/active/restricted accounts are never converted or
   * duplicated, and the issuer learns nothing about them.
   */
  | Readonly<{ kind: "ACCEPTED" }>
  | Readonly<{ kind: "INVALID_INPUT" }>
  | Readonly<{ kind: "NOT_AUTHORIZED" }>;

export type IssuedInvitation = Readonly<{
  invitationId: string;
  supersededId: string | null;
  /** Delivered after commit; holds the raw capability for the link only. */
  email: AuthEmailMessage;
}>;

/**
 * Issues (or reissues, superseding the live one) an invitation inside the
 * caller's transaction. Returns null when the email's current account may
 * not receive one. The raw token leaves this function only inside the
 * email message, which the caller enqueues after commit.
 */
export async function issueInvitationInTransaction(
  tx: Tx,
  deps: StaffAuthDependencies,
  input: Readonly<{
    email: string;
    emailDisplay: string;
    purpose: StaffInvitationPurpose;
    issuerReasonCode: InvitationIssuerReason;
    accountId?: string;
    recoveryCaseId?: string;
    now: Date;
  }>,
  audit: TransactionAudit,
  actor: InvitationActorFacts,
): Promise<IssuedInvitation | null> {
  await lockInvitationEmail(tx, input.email);
  const existing = await findAccountByEmail(tx, input.email);
  if (!canIssueStaffInvitation(existing, input.purpose)) return null;
  if (input.accountId && existing?.id !== input.accountId) return null;

  const ttlSeconds =
    input.purpose === "STAFF_REENROLLMENT"
      ? deps.env.AUTH_STAFF_REENROLLMENT_EXPIRES_IN_SECONDS
      : deps.env.AUTH_STAFF_INVITATION_EXPIRES_IN_SECONDS;
  let supersededId: string | null = null;
  const pending = await lockPendingInvitationForEmail(tx, input.email);
  if (pending) {
    const decision = decideInvitationTransition(
      pending,
      "SUPERSEDE",
      input.now,
    );
    const to = decision.kind === "apply" ? "SUPERSEDED" : "EXPIRED";
    if (!(await transitionInvitation(tx, pending, to, input.now))) {
      throw new Error("pending invitation changed concurrently");
    }
    if (to === "SUPERSEDED") supersededId = pending.id;
  }
  // A superseded activation's enrollment context ends with it.
  if (existing && existing.status === "INVITED") {
    await lockAccountForUpdate(tx, existing.id);
    await deleteAllSessions(tx, existing.id);
  }

  const token = newInvitationToken();
  const invitationId = await insertInvitation(tx, {
    email: input.email,
    emailDisplay: input.emailDisplay,
    purpose: input.purpose,
    tokenDigest: digestInvitationToken(token),
    issuerReasonCode: input.issuerReasonCode,
    accountId: input.accountId ?? null,
    recoveryCaseId: input.recoveryCaseId ?? null,
    issuedAt: input.now,
    expiresAt: new Date(input.now.getTime() + ttlSeconds * 1000),
  });
  if (supersededId) {
    await linkSupersededInvitation(tx, supersededId, invitationId);
    await audit.append({
      code: "staff.invitation_superseded",
      recordRef: supersededId,
      ...actor,
    });
  }
  // Committed with the invitation itself (ADR-0012): no invitation exists
  // without its evidence.
  await audit.append({
    code: "staff.invitation_issued",
    recordRef: invitationId,
    ...(input.accountId ? { accountRef: input.accountId } : {}),
    ...actor,
  });
  return Object.freeze({
    invitationId,
    supersededId,
    email: {
      template: "STAFF_INVITATION" as const,
      to: input.email,
      token,
      purpose: input.purpose,
      expiresInMinutes: Math.round(ttlSeconds / 60),
    },
  });
}

/**
 * Issues a staff activation invitation, or resends one (the previous live
 * capability is superseded and stops working immediately).
 */
export async function issueStaffInvitation(
  input: Readonly<{ email: unknown; actor: StaffAdministrationActor }>,
  deps: StaffAuthDependencies = defaultStaffDependencies(),
): Promise<IssueStaffInvitationResult> {
  if (!deps.staffAdmin.allows(input.actor, "INVITATION_ISSUE")) {
    await deps.events.record({
      code: "staff.invitation_refused",
      category: "denied",
    });
    return { kind: "NOT_AUTHORIZED" };
  }
  const email = tryNormalizeEmail(input.email);
  if (!email) return { kind: "INVALID_INPUT" };
  const issuerReasonCode: InvitationIssuerReason =
    input.actor.kind === "BOOTSTRAP" ? input.actor.reason : "TEST_HARNESS";

  const issued = await withAuditedTransaction(deps, (tx, audit) =>
    issueInvitationInTransaction(
      tx,
      deps,
      {
        email: email.login,
        emailDisplay: email.display,
        purpose: "STAFF_ACTIVATION",
        issuerReasonCode,
        now: new Date(),
      },
      audit,
      invitationActorFacts(input.actor),
    ),
  );
  if (!issued) {
    await deps.events.record({
      code: "staff.invitation_refused",
      category: "not_eligible",
    });
    return { kind: "ACCEPTED" };
  }
  deps.email.enqueue(issued.email);
  return { kind: "ACCEPTED" };
}

export type RevokeStaffInvitationResult =
  | Readonly<{ kind: "REVOKED" }>
  | Readonly<{ kind: "EXPIRED" }>
  | Readonly<{ kind: "NOT_REVOCABLE" }>
  | Readonly<{ kind: "NOT_FOUND" }>
  | Readonly<{ kind: "NOT_AUTHORIZED" }>;

/** Revokes a live invitation; acceptance fails immediately afterwards. */
export async function revokeStaffInvitation(
  input: Readonly<{ invitationId: string; actor: StaffAdministrationActor }>,
  deps: StaffAuthDependencies = defaultStaffDependencies(),
): Promise<RevokeStaffInvitationResult> {
  if (!deps.staffAdmin.allows(input.actor, "INVITATION_REVOKE")) {
    await deps.events.record({
      code: "staff.invitation_refused",
      category: "denied",
    });
    return { kind: "NOT_AUTHORIZED" };
  }
  const now = new Date();
  const actor = invitationActorFacts(input.actor);
  const result = await withAuditedTransaction(deps, async (tx, audit) => {
    // Only a UUID-shaped reference can match; anything else is not found
    // and never reaches an event.
    if (!uuidShape.test(input.invitationId))
      return { kind: "NOT_FOUND" } as const;
    const row = await findInvitationById(tx, input.invitationId, true);
    if (!row) return { kind: "NOT_FOUND" } as const;
    const decision = decideInvitationTransition(row, "REVOKE", now);
    if (decision.kind === "not-allowed") {
      return { kind: "NOT_REVOCABLE" } as const;
    }
    if (decision.kind === "expired") {
      await transitionInvitation(tx, row, "EXPIRED", now);
      await audit.append({
        code: "staff.invitation_expired",
        recordRef: row.id,
        systemActor: "SCHEDULED_EXPIRY",
      });
      return { kind: "EXPIRED" } as const;
    }
    if (!(await transitionInvitation(tx, row, "REVOKED", now))) {
      return { kind: "NOT_REVOCABLE" } as const;
    }
    // Any enrollment context started from this invitation ends now.
    if (row.accountId) {
      const account = await lockAccountForUpdate(tx, row.accountId);
      if (account?.accountType === "STAFF" && account.status === "INVITED") {
        await deleteAllSessions(tx, row.accountId);
      }
    }
    await audit.append({
      code: "staff.invitation_revoked",
      recordRef: row.id,
      ...(row.accountId ? { accountRef: row.accountId } : {}),
      ...actor,
    });
    return { kind: "REVOKED" } as const;
  });
  if (result.kind === "NOT_FOUND" || result.kind === "NOT_REVOCABLE") {
    await deps.events.record({
      code: "staff.invitation_refused",
      category: "not_eligible",
      ...(result.kind === "NOT_REVOCABLE"
        ? { recordRef: input.invitationId }
        : {}),
    });
  }
  return result;
}

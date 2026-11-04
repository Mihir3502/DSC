import "server-only";
import { listStaffHoldingPermissionAt } from "@/modules/identity-access";
import { isCandidacyPublicId } from "../domain/candidacy-policy";
import { isOwnerChangeReason, parseDueDate } from "../domain/work-queue";
import {
  findOpenStaffWorkItem,
  findPerson,
  insertResponsibilityHistory,
  updateCandidacy,
  updateWorkItemDueDate,
} from "../infrastructure/candidates-repository";
import {
  lockCandidacy,
  recordOf,
  validated,
  version,
  type CandidateResult,
} from "./candidate-commands";
import {
  authorizeCandidateCommand,
  candidateDependencies,
  fingerprint,
  refuse,
  runCandidateCommand,
  type CandidateActor,
  type CandidateDependencies,
  type CommandContext,
} from "./candidate-runtime";

// Named responsibility commands (packet M3.1 §8–§10). Ownership is operational
// only and never grants candidate-account ownership. The client sends a target
// and a closed reason; scope, eligibility, state, and time are all derived here
// under the candidacy's row lock. Each change writes the business row, one
// append-only history row, and an audit event in the same transaction.

export type AssignOwnerInput = Readonly<{
  commandKey?: string;
  candidacyId?: string;
  expectedVersion?: string;
  ownerAccountId?: string;
  reasonCode?: string;
}>;

const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Holding candidate.owner.assign at this placement, and not the candidate. */
async function verifyEligibleOwner(
  ctx: CommandContext,
  row: Parameters<typeof recordOf>[0],
  accountId: string,
) {
  const subject = await findPerson(ctx.tx, row.personId, null);
  const eligible = await listStaffHoldingPermissionAt(ctx.tx, {
    permission: "candidate.owner.assign",
    organizationId: row.organizationId,
    branchId: row.branchId,
    teamId: row.teamId,
    excludeAccountIds: subject?.candidateAccountId
      ? [subject.candidateAccountId]
      : [],
    onlyAccountId: accountId,
    at: ctx.now,
    limit: 1,
  });
  if (eligible.length === 0) refuse("OWNER_NOT_ELIGIBLE");
}

/**
 * assign_candidacy_owner_to_other: a PSA Manager assigns or reassigns the
 * owner, with a reason. Claiming an unowned record is the separate self-only
 * command, assignCandidacyOwnerToSelf.
 */
export async function assignCandidacyOwner(
  input: AssignOwnerInput,
  actor: CandidateActor,
  deps: CandidateDependencies = candidateDependencies(),
): Promise<CandidateResult> {
  return validated(async () => {
    if (actor.kind !== "STAFF")
      return { kind: "REFUSED", reason: "NOT_AUTHORIZED" };
    if (!isCandidacyPublicId(input.candidacyId))
      return { kind: "REFUSED", reason: "NOT_FOUND" };
    const expected = version(input.expectedVersion);
    const target = input.ownerAccountId;
    const reason = input.reasonCode;
    if (typeof target !== "string" || !uuid.test(target))
      return { kind: "REFUSED", reason: "INVALID_INPUT" };
    if (!isOwnerChangeReason(reason))
      return { kind: "REFUSED", reason: "INVALID_INPUT" };
    return runCandidateCommand(
      deps,
      actor,
      {
        name: "assign_candidacy_owner_to_other",
        commandKey: input.commandKey,
        fingerprint: fingerprint({
          id: input.candidacyId,
          expected,
          target,
          reason,
        }),
      },
      async (ctx) => {
        const row = await lockCandidacy(ctx, input.candidacyId!);
        await authorizeCandidateCommand(
          ctx,
          deps,
          "candidate.owner.assign_others",
          "EDIT",
          recordOf(row),
          reason,
        );
        await authorizeCandidateCommand(
          ctx,
          deps,
          "candidate.work_queue.read",
          "READ",
          recordOf(row),
        );
        if (row.version !== expected) refuse("STALE_VERSION");
        if (row.status !== "ACTIVE") refuse("INVALID_TRANSITION");
        if (row.ownerAccountId === target) refuse("INVALID_TRANSITION");
        await verifyEligibleOwner(ctx, row, target);
        const updated =
          (await updateCandidacy(
            ctx.tx,
            row.id,
            expected,
            { ownerAccountId: target },
            ctx.actorId,
            ctx.now,
          )) ?? refuse("STALE_VERSION");
        await insertResponsibilityHistory(ctx.tx, {
          candidacyId: row.id,
          changeCode: row.ownerAccountId
            ? "OWNER_REASSIGNED"
            : "OWNER_ASSIGNED",
          ...(row.ownerAccountId
            ? { previousOwnerAccountId: row.ownerAccountId }
            : {}),
          newOwnerAccountId: target,
          reasonCode: reason,
          actorAccountId: ctx.actorId,
          occurredAt: ctx.now,
        });
        ctx.events.push({
          code: "candidacy.owner_assigned",
          recordRef: row.id,
          candidacyRef: row.id,
          organizationRef: row.organizationId,
          previousVersion: row.version,
          newVersion: updated.version,
          changeCodes: [
            row.ownerAccountId ? "REASSIGNED" : "ASSIGNED",
            target === ctx.actorId ? "SELF" : "OTHER",
          ],
          reasonCode: reason,
        });
        return {
          outcome: "UPDATED",
          targetId: row.id,
          version: updated.version,
        };
      },
    );
  });
}

/**
 * release_candidacy_owner: the current owner gives a record back, or a PSA
 * Manager clears someone else's ownership. Either way the record stays in the
 * queue as unassigned.
 */
export async function releaseCandidacyOwner(
  input: Readonly<{
    commandKey?: string;
    candidacyId?: string;
    expectedVersion?: string;
    reasonCode?: string;
  }>,
  actor: CandidateActor,
  deps: CandidateDependencies = candidateDependencies(),
): Promise<CandidateResult> {
  return validated(async () => {
    if (actor.kind !== "STAFF")
      return { kind: "REFUSED", reason: "NOT_AUTHORIZED" };
    if (!isCandidacyPublicId(input.candidacyId))
      return { kind: "REFUSED", reason: "NOT_FOUND" };
    const expected = version(input.expectedVersion);
    const reason = input.reasonCode;
    if (!isOwnerChangeReason(reason))
      return { kind: "REFUSED", reason: "INVALID_INPUT" };
    return runCandidateCommand(
      deps,
      actor,
      {
        name: "release_candidacy_owner",
        commandKey: input.commandKey,
        fingerprint: fingerprint({ id: input.candidacyId, expected, reason }),
      },
      async (ctx) => {
        const row = await lockCandidacy(ctx, input.candidacyId!);
        // Whose ownership it is decides the permission, so read it under lock.
        await authorizeCandidateCommand(
          ctx,
          deps,
          row.ownerAccountId === ctx.actorId
            ? "candidate.owner.assign"
            : "candidate.owner.assign_others",
          "EDIT",
          recordOf(row),
          reason,
        );
        if (row.version !== expected) refuse("STALE_VERSION");
        if (row.status !== "ACTIVE") refuse("INVALID_TRANSITION");
        if (row.ownerAccountId === null) refuse("INVALID_TRANSITION");
        const updated =
          (await updateCandidacy(
            ctx.tx,
            row.id,
            expected,
            { ownerAccountId: null },
            ctx.actorId,
            ctx.now,
          )) ?? refuse("STALE_VERSION");
        await insertResponsibilityHistory(ctx.tx, {
          candidacyId: row.id,
          changeCode: "OWNER_RELEASED",
          previousOwnerAccountId: row.ownerAccountId!,
          reasonCode: reason,
          actorAccountId: ctx.actorId,
          occurredAt: ctx.now,
        });
        ctx.events.push({
          code: "candidacy.owner_released",
          recordRef: row.id,
          candidacyRef: row.id,
          organizationRef: row.organizationId,
          previousVersion: row.version,
          newVersion: updated.version,
          changeCodes: [row.ownerAccountId === ctx.actorId ? "SELF" : "OTHER"],
          reasonCode: reason,
        });
        return {
          outcome: "UPDATED",
          targetId: row.id,
          version: updated.version,
        };
      },
    );
  });
}

/**
 * set_work_item_due_date: sets or clears the due date on the open staff work
 * item. Candidate tasks and finished items can't get one, and nothing here
 * sets a deadline automatically. expectedVersion is the work item's version.
 */
export async function setWorkItemDueDate(
  input: Readonly<{
    commandKey?: string;
    candidacyId?: string;
    expectedVersion?: string;
    dueDate?: string;
  }>,
  actor: CandidateActor,
  deps: CandidateDependencies = candidateDependencies(),
): Promise<CandidateResult> {
  return validated(async () => {
    if (actor.kind !== "STAFF")
      return { kind: "REFUSED", reason: "NOT_AUTHORIZED" };
    if (!isCandidacyPublicId(input.candidacyId))
      return { kind: "REFUSED", reason: "NOT_FOUND" };
    const expected = version(input.expectedVersion);
    return runCandidateCommand(
      deps,
      actor,
      {
        name: "set_work_item_due_date",
        commandKey: input.commandKey,
        fingerprint: fingerprint({
          id: input.candidacyId,
          expected,
          dueDate: input.dueDate ?? "",
        }),
      },
      async (ctx) => {
        const row = await lockCandidacy(ctx, input.candidacyId!);
        await authorizeCandidateCommand(
          ctx,
          deps,
          "candidate.due_date.manage",
          "EDIT",
          recordOf(row),
        );
        const parsed = parseDueDate(input.dueDate, ctx.now);
        if (!parsed.ok) return refuse("INVALID_INPUT");
        if (row.status !== "ACTIVE") refuse("INVALID_TRANSITION");
        const item =
          (await findOpenStaffWorkItem(ctx.tx, row.id, "update")) ??
          refuse("INVALID_TRANSITION");
        if (item.version !== expected) refuse("STALE_VERSION");
        const before = item.dueAt?.getTime() ?? null;
        if (before === (parsed.dueAt?.getTime() ?? null)) {
          refuse("INVALID_TRANSITION");
        }
        const updated =
          (await updateWorkItemDueDate(
            ctx.tx,
            item.id,
            expected,
            parsed.dueAt,
            ctx.now,
          )) ?? refuse("STALE_VERSION");
        await insertResponsibilityHistory(ctx.tx, {
          candidacyId: row.id,
          workItemId: item.id,
          changeCode: parsed.dueAt ? "DUE_DATE_SET" : "DUE_DATE_CLEARED",
          previousDueAt: item.dueAt,
          newDueAt: parsed.dueAt,
          actorAccountId: ctx.actorId,
          occurredAt: ctx.now,
        });
        ctx.events.push({
          code: "work_item.due_date_changed",
          recordRef: row.id,
          candidacyRef: row.id,
          organizationRef: row.organizationId,
          previousVersion: item.version,
          newVersion: updated.version,
          changeCodes: [parsed.dueAt ? "SET" : "CLEARED"],
        });
        return {
          outcome: "UPDATED",
          targetId: row.id,
          version: updated.version,
        };
      },
    );
  });
}

import "server-only";
import { isCandidacyPublicId } from "../domain/candidacy-policy";
import { candidacyWorkflow } from "../domain/candidate-portal";
import {
  isHoldCategory,
  isHoldRemovalReason,
  normalizeHoldReason,
  parseHoldReviewDate,
} from "../domain/holds";
import {
  findActiveHold,
  insertHold,
  removeHold,
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
} from "./candidate-runtime";

// Named hold commands (packet M3.3; HIRING_WORKFLOW §6.5). During prescreen the
// owner decided HR Specialists and PSA Managers place and remove holds. The
// RECRUITING hold category limits HR to this kind of hold, and the queue read
// keeps out other roles that hold the same permission for later stages. A hold
// never changes the stage, so removing it returns to where things were.

export async function placeCandidacyHold(
  input: Readonly<{
    commandKey?: string;
    candidacyId?: string;
    expectedVersion?: string;
    reasonCode?: string;
    internalReason?: string;
    reviewDate?: string;
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
    const category = input.reasonCode;
    const reason = normalizeHoldReason(input.internalReason);
    if (!isHoldCategory(category) || reason === null) {
      return { kind: "REFUSED", reason: "INVALID_INPUT" };
    }
    return runCandidateCommand(
      deps,
      actor,
      {
        name: "place_candidacy_hold",
        commandKey: input.commandKey,
        fingerprint: fingerprint({
          id: input.candidacyId,
          expected,
          category,
          reason,
          reviewDate: input.reviewDate ?? "",
        }),
      },
      async (ctx) => {
        const row = await lockCandidacy(ctx, input.candidacyId!);
        await authorizeCandidateCommand(
          ctx,
          deps,
          "compliance_hold.place",
          "CREATE",
          recordOf(row),
          category,
          candidacyWorkflow(row),
          "RECRUITING",
        );
        await authorizeCandidateCommand(
          ctx,
          deps,
          "candidate.work_queue.read",
          "READ",
          recordOf(row),
        );
        const reviewAt = parseHoldReviewDate(input.reviewDate, ctx.now);
        if (!reviewAt) return refuse("INVALID_INPUT");
        if (row.version !== expected) refuse("STALE_VERSION");
        if (await findActiveHold(ctx.tx, row.id)) refuse("ALREADY_ON_HOLD");
        const hold = await insertHold(ctx.tx, {
          candidacyId: row.id,
          categoryCode: category,
          internalReason: reason,
          reviewAt,
          placedByAccountId: ctx.actorId,
          placedAt: ctx.now,
        });
        ctx.events.push({
          code: "candidacy.hold_placed",
          recordRef: row.id,
          candidacyRef: row.id,
          organizationRef: row.organizationId,
          newVersion: hold.version,
          reasonCode: category,
        });
        return { outcome: "UPDATED", targetId: row.id, version: row.version };
      },
    );
  });
}

export async function removeCandidacyHold(
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
    const reasonCode = input.reasonCode;
    if (!isHoldRemovalReason(reasonCode)) {
      return { kind: "REFUSED", reason: "INVALID_INPUT" };
    }
    return runCandidateCommand(
      deps,
      actor,
      {
        name: "remove_candidacy_hold",
        commandKey: input.commandKey,
        fingerprint: fingerprint({
          id: input.candidacyId,
          expected,
          reasonCode,
        }),
      },
      async (ctx) => {
        const row = await lockCandidacy(ctx, input.candidacyId!);
        await authorizeCandidateCommand(
          ctx,
          deps,
          "compliance_hold.remove",
          "EDIT",
          recordOf(row),
          reasonCode,
          candidacyWorkflow(row),
          "RECRUITING",
        );
        await authorizeCandidateCommand(
          ctx,
          deps,
          "candidate.work_queue.read",
          "READ",
          recordOf(row),
        );
        const hold =
          (await findActiveHold(ctx.tx, row.id, "update")) ??
          refuse("INVALID_TRANSITION");
        if (hold.version !== expected) refuse("STALE_VERSION");
        const removed =
          (await removeHold(
            ctx.tx,
            hold.id,
            expected,
            ctx.actorId,
            reasonCode,
            ctx.now,
          )) ?? refuse("STALE_VERSION");
        ctx.events.push({
          code: "candidacy.hold_removed",
          recordRef: row.id,
          candidacyRef: row.id,
          organizationRef: row.organizationId,
          previousVersion: hold.version,
          newVersion: removed.version,
          reasonCode,
        });
        return { outcome: "UPDATED", targetId: row.id, version: row.version };
      },
    );
  });
}

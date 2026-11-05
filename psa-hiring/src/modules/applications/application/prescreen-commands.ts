import "server-only";
import { and, asc, desc, eq, lte, sql } from "drizzle-orm";
import {
  authorizeCandidateCommand,
  candidacyWorkflow,
  candidateDependencies,
  findActiveHold,
  findCandidacyByPublicId,
  fingerprint,
  isCandidacyPublicId,
  markNotSelected,
  markPrescreenAccepted,
  markPrescreenPassed,
  refuse,
  runCandidateCommand,
  type CandidacyRow,
  type CandidateActor,
  type CandidateDependencies,
  type CandidateOutcome,
  type CandidateExecutor,
  type CommandContext,
} from "@/modules/candidates";
import {
  exceptionIsCurrent,
  hasUnmet,
  isExceptionReason,
  isNotSelectedReason,
  normalizeNotes,
  parseChecklistItems,
  parseResponses,
  passBlocker,
  type PrescreenFacts,
} from "../domain/prescreen";
import {
  prescreenChecklistVersion,
  prescreenReview,
} from "../infrastructure/applications-schema";
import { findLatestVersion } from "../infrastructure/applications-repository";

// Named prescreen commands (packet M3.3 §8-§10). The client sends answers, closed
// reasons, and a version. State, reviewer, time, and scope come from here, under
// the candidacy's row lock. Each change writes the review, any stage change, and
// an audit event in one transaction. Passing moves the stage to Interview and
// creates no interview record. A hold blocks every decision.

const parseVersion = (value: unknown): number | null =>
  typeof value === "string" && /^[1-9][0-9]{0,8}$/.test(value)
    ? Number(value)
    : null;

type ReviewRow = typeof prescreenReview.$inferSelect;

const recordOf = (row: CandidacyRow) =>
  ({
    kind: "RECORD",
    id: row.id,
    sensitivity: "CONFIDENTIAL_PERSONNEL",
  }) as const;

async function lockRecord(ctx: CommandContext, publicId: string) {
  return (
    (await findCandidacyByPublicId(ctx.tx, publicId, "update")) ??
    refuse("NOT_FOUND")
  );
}

async function openReview(tx: CandidateExecutor, candidacyId: string) {
  const [row] = await tx
    .select()
    .from(prescreenReview)
    .where(
      and(
        eq(prescreenReview.candidacyId, candidacyId),
        eq(prescreenReview.status, "IN_PROGRESS"),
      ),
    )
    .for("update");
  return row ?? null;
}

async function checklistOf(tx: CandidateExecutor, id: string) {
  const [row] = await tx
    .select({ items: prescreenChecklistVersion.items })
    .from(prescreenChecklistVersion)
    .where(eq(prescreenChecklistVersion.id, id));
  return parseChecklistItems(row?.items);
}

const factsOf = (
  review: ReviewRow,
  items: PrescreenFacts["items"],
): PrescreenFacts => ({
  items,
  responses: review.responses as Record<string, unknown>,
  responsesVersion: review.responsesVersion,
  exceptionResponsesVersion: review.exceptionResponsesVersion,
});

async function updateReview(
  tx: CandidateExecutor,
  review: ReviewRow,
  patch: Partial<typeof prescreenReview.$inferInsert>,
): Promise<ReviewRow> {
  const [row] = await tx
    .update(prescreenReview)
    .set({ ...patch, version: sql`${prescreenReview.version} + 1` })
    .where(
      and(
        eq(prescreenReview.id, review.id),
        eq(prescreenReview.version, review.version),
      ),
    )
    .returning();
  return row ?? refuse("STALE_VERSION");
}

/** accept_application_for_review: starts the prescreen of the latest version. */
export async function acceptApplicationForPrescreen(
  input: Readonly<{
    commandKey?: string;
    candidacyId?: string;
    expectedVersion?: string;
  }>,
  actor: CandidateActor,
  deps: CandidateDependencies = candidateDependencies(),
): Promise<CandidateOutcome> {
  if (actor.kind !== "STAFF") {
    return { kind: "REFUSED", reason: "NOT_AUTHORIZED" };
  }
  if (!isCandidacyPublicId(input.candidacyId)) {
    return { kind: "REFUSED", reason: "NOT_FOUND" };
  }
  const expected = parseVersion(input.expectedVersion);
  if (expected === null) return { kind: "REFUSED", reason: "INVALID_INPUT" };
  return runCandidateCommand(
    deps,
    actor,
    {
      name: "accept_application_for_prescreen",
      commandKey: input.commandKey,
      fingerprint: fingerprint({ id: input.candidacyId, expected }),
    },
    async (ctx) => {
      const row = await lockRecord(ctx, input.candidacyId!);
      await authorizeCandidateCommand(
        ctx,
        deps,
        "prescreen.begin",
        "REVIEW",
        recordOf(row),
        undefined,
        candidacyWorkflow(row),
      );
      if (row.version !== expected) refuse("STALE_VERSION");
      const latest = await findLatestVersion(ctx.tx, row.id);
      if (latest?.status !== "SUBMITTED") return refuse("INVALID_TRANSITION");
      const [checklist] = await ctx.tx
        .select({ id: prescreenChecklistVersion.id })
        .from(prescreenChecklistVersion)
        .where(lte(prescreenChecklistVersion.effectiveFrom, ctx.now))
        .orderBy(
          desc(prescreenChecklistVersion.effectiveFrom),
          asc(prescreenChecklistVersion.id),
        )
        .limit(1);
      if (!checklist) return refuse("TEMPLATE_UNAVAILABLE");
      const updated = await markPrescreenAccepted(ctx, row);
      await ctx.tx.insert(prescreenReview).values({
        candidacyId: row.id,
        applicationVersionId: latest.id,
        checklistVersionId: checklist.id,
        acceptedByAccountId: ctx.actorId,
        acceptedAt: ctx.now,
      });
      ctx.events.push({
        code: "prescreen.accepted",
        recordRef: row.id,
        candidacyRef: row.id,
        organizationRef: row.organizationId,
        previousVersion: row.version,
        newVersion: updated.version,
      });
      return {
        outcome: "UPDATED",
        targetId: row.id,
        version: updated.version,
      };
    },
  );
}

/** save_prescreen_responses: changing answers voids any earlier exception. */
export async function savePrescreenResponses(
  input: Readonly<{
    commandKey?: string;
    candidacyId?: string;
    expectedVersion?: string;
    responses?: string;
    internalNotes?: string;
  }>,
  actor: CandidateActor,
  deps: CandidateDependencies = candidateDependencies(),
): Promise<CandidateOutcome> {
  if (actor.kind !== "STAFF") {
    return { kind: "REFUSED", reason: "NOT_AUTHORIZED" };
  }
  if (!isCandidacyPublicId(input.candidacyId)) {
    return { kind: "REFUSED", reason: "NOT_FOUND" };
  }
  const expected = parseVersion(input.expectedVersion);
  const notes = normalizeNotes(input.internalNotes);
  if (expected === null || !notes.ok) {
    return { kind: "REFUSED", reason: "INVALID_INPUT" };
  }
  return runCandidateCommand(
    deps,
    actor,
    {
      name: "save_prescreen_responses",
      commandKey: input.commandKey,
      fingerprint: fingerprint({
        id: input.candidacyId,
        expected,
        responses: input.responses ?? "",
        notes: notes.notes,
      }),
    },
    async (ctx) => {
      const row = await lockRecord(ctx, input.candidacyId!);
      await authorizeCandidateCommand(
        ctx,
        deps,
        "prescreen.complete",
        "APPROVE",
        recordOf(row),
        undefined,
        candidacyWorkflow(row),
      );
      const review =
        (await openReview(ctx.tx, row.id)) ?? refuse("INVALID_TRANSITION");
      if (review.version !== expected) refuse("STALE_VERSION");
      if (await findActiveHold(ctx.tx, row.id)) refuse("ON_HOLD");
      const items = await checklistOf(ctx.tx, review.checklistVersionId);
      const responses = parseResponses(items, input.responses);
      if (!responses) return refuse("INVALID_INPUT");
      const updated = await updateReview(ctx.tx, review, {
        responses,
        responsesVersion: review.responsesVersion + 1,
        internalNotes: notes.notes,
        reviewerAccountId: ctx.actorId,
        exceptionReasonCode: null,
        exceptionByAccountId: null,
        exceptionAt: null,
        exceptionResponsesVersion: null,
      });
      ctx.events.push({
        code: "prescreen.responses_saved",
        recordRef: row.id,
        candidacyRef: row.id,
        organizationRef: row.organizationId,
        previousVersion: review.version,
        newVersion: updated.version,
        count: Object.keys(responses).length,
        ...(review.exceptionReasonCode
          ? { changeCodes: ["EXCEPTION_VOIDED"] }
          : {}),
      });
      return {
        outcome: "UPDATED",
        targetId: row.id,
        version: updated.version,
      };
    },
  );
}

/** approve_prescreen_exception: a PSA Manager who didn't do this review. */
export async function approvePrescreenException(
  input: Readonly<{
    commandKey?: string;
    candidacyId?: string;
    expectedVersion?: string;
    reasonCode?: string;
  }>,
  actor: CandidateActor,
  deps: CandidateDependencies = candidateDependencies(),
): Promise<CandidateOutcome> {
  if (actor.kind !== "STAFF") {
    return { kind: "REFUSED", reason: "NOT_AUTHORIZED" };
  }
  if (!isCandidacyPublicId(input.candidacyId)) {
    return { kind: "REFUSED", reason: "NOT_FOUND" };
  }
  const expected = parseVersion(input.expectedVersion);
  const reason = input.reasonCode;
  if (expected === null || !isExceptionReason(reason)) {
    return { kind: "REFUSED", reason: "INVALID_INPUT" };
  }
  return runCandidateCommand(
    deps,
    actor,
    {
      name: "approve_prescreen_exception",
      commandKey: input.commandKey,
      fingerprint: fingerprint({ id: input.candidacyId, expected, reason }),
    },
    async (ctx) => {
      const row = await lockRecord(ctx, input.candidacyId!);
      await authorizeCandidateCommand(
        ctx,
        deps,
        "prescreen.exception.approve",
        "APPROVE",
        recordOf(row),
        reason,
        candidacyWorkflow(row),
      );
      const review =
        (await openReview(ctx.tx, row.id)) ?? refuse("INVALID_TRANSITION");
      if (review.version !== expected) refuse("STALE_VERSION");
      if (await findActiveHold(ctx.tx, row.id)) refuse("ON_HOLD");
      if (review.reviewerAccountId === ctx.actorId) {
        refuse("EXCEPTION_SELF_APPROVAL");
      }
      const items = await checklistOf(ctx.tx, review.checklistVersionId);
      const facts = factsOf(review, items);
      if (!hasUnmet(facts) || exceptionIsCurrent(facts)) {
        refuse("EXCEPTION_NOT_NEEDED");
      }
      const updated = await updateReview(ctx.tx, review, {
        exceptionReasonCode: reason!,
        exceptionByAccountId: ctx.actorId,
        exceptionAt: ctx.now,
        exceptionResponsesVersion: review.responsesVersion,
      });
      ctx.events.push({
        code: "prescreen.exception_approved",
        recordRef: row.id,
        candidacyRef: row.id,
        organizationRef: row.organizationId,
        previousVersion: review.version,
        newVersion: updated.version,
        reasonCode: reason!,
      });
      return {
        outcome: "UPDATED",
        targetId: row.id,
        version: updated.version,
      };
    },
  );
}

/** pass_prescreen: every answer in, and any unmet item covered by an exception. */
export async function passPrescreen(
  input: Readonly<{
    commandKey?: string;
    candidacyId?: string;
    expectedVersion?: string;
  }>,
  actor: CandidateActor,
  deps: CandidateDependencies = candidateDependencies(),
): Promise<CandidateOutcome> {
  if (actor.kind !== "STAFF") {
    return { kind: "REFUSED", reason: "NOT_AUTHORIZED" };
  }
  if (!isCandidacyPublicId(input.candidacyId)) {
    return { kind: "REFUSED", reason: "NOT_FOUND" };
  }
  const expected = parseVersion(input.expectedVersion);
  if (expected === null) return { kind: "REFUSED", reason: "INVALID_INPUT" };
  return runCandidateCommand(
    deps,
    actor,
    {
      name: "pass_prescreen",
      commandKey: input.commandKey,
      fingerprint: fingerprint({ id: input.candidacyId, expected }),
    },
    async (ctx) => {
      const row = await lockRecord(ctx, input.candidacyId!);
      await authorizeCandidateCommand(
        ctx,
        deps,
        "prescreen.complete",
        "APPROVE",
        recordOf(row),
        undefined,
        candidacyWorkflow(row),
      );
      const review =
        (await openReview(ctx.tx, row.id)) ?? refuse("INVALID_TRANSITION");
      if (review.version !== expected) refuse("STALE_VERSION");
      if (await findActiveHold(ctx.tx, row.id)) refuse("ON_HOLD");
      const items = await checklistOf(ctx.tx, review.checklistVersionId);
      const blocker = passBlocker(factsOf(review, items));
      if (blocker) refuse(blocker);
      const finished = await updateReview(ctx.tx, review, {
        status: "PASSED",
        decidedByAccountId: ctx.actorId,
        decidedAt: ctx.now,
      });
      const updated = await markPrescreenPassed(ctx, row);
      ctx.events.push({
        code: "prescreen.passed",
        recordRef: row.id,
        candidacyRef: row.id,
        organizationRef: row.organizationId,
        previousVersion: row.version,
        newVersion: updated.version,
        changeCodes: finished.exceptionReasonCode
          ? ["WITH_EXCEPTION"]
          : ["ALL_MET"],
      });
      return {
        outcome: "UPDATED",
        targetId: row.id,
        version: updated.version,
      };
    },
  );
}

/** not_select_prescreen: closes the candidacy. The candidate sees no reason. */
export async function notSelectAtPrescreen(
  input: Readonly<{
    commandKey?: string;
    candidacyId?: string;
    expectedVersion?: string;
    reasonCode?: string;
  }>,
  actor: CandidateActor,
  deps: CandidateDependencies = candidateDependencies(),
): Promise<CandidateOutcome> {
  if (actor.kind !== "STAFF") {
    return { kind: "REFUSED", reason: "NOT_AUTHORIZED" };
  }
  if (!isCandidacyPublicId(input.candidacyId)) {
    return { kind: "REFUSED", reason: "NOT_FOUND" };
  }
  const expected = parseVersion(input.expectedVersion);
  const reason = input.reasonCode;
  if (expected === null || !isNotSelectedReason(reason)) {
    return { kind: "REFUSED", reason: "INVALID_INPUT" };
  }
  return runCandidateCommand(
    deps,
    actor,
    {
      name: "not_select_at_prescreen",
      commandKey: input.commandKey,
      fingerprint: fingerprint({ id: input.candidacyId, expected, reason }),
    },
    async (ctx) => {
      const row = await lockRecord(ctx, input.candidacyId!);
      await authorizeCandidateCommand(
        ctx,
        deps,
        "prescreen.complete",
        "APPROVE",
        recordOf(row),
        undefined,
        candidacyWorkflow(row),
      );
      const review =
        (await openReview(ctx.tx, row.id)) ?? refuse("INVALID_TRANSITION");
      if (review.version !== expected) refuse("STALE_VERSION");
      if (await findActiveHold(ctx.tx, row.id)) refuse("ON_HOLD");
      await updateReview(ctx.tx, review, {
        status: "NOT_SELECTED",
        notSelectedReasonCode: reason!,
        decidedByAccountId: ctx.actorId,
        decidedAt: ctx.now,
      });
      const updated = await markNotSelected(ctx, row, reason!);
      ctx.events.push({
        code: "prescreen.not_selected",
        recordRef: row.id,
        candidacyRef: row.id,
        organizationRef: row.organizationId,
        previousVersion: row.version,
        newVersion: updated.version,
        reasonCode: reason!,
      });
      return {
        outcome: "UPDATED",
        targetId: row.id,
        version: updated.version,
      };
    },
  );
}

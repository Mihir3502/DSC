import "server-only";
import { and, eq, sql } from "drizzle-orm";
import {
  authorizeCandidateCommand,
  candidacyWorkflow,
  candidateDependencies,
  findActiveHold,
  findCandidacyByPublicId,
  fingerprint,
  isCandidacyPublicId,
  markApplicationReturned,
  refuse,
  runCandidateCommand,
  type CandidateActor,
  type CandidateDependencies,
  type CandidateOutcome,
} from "@/modules/candidates";
import {
  isReturnReason,
  normalizeInstructions,
  parseReopenSelection,
  parseTemplate,
} from "../domain/application-template";
import {
  applicationReturn,
  applicationVersion,
  outboxEvent,
  prescreenReview,
} from "../infrastructure/applications-schema";
import {
  findLatestVersion,
  findTemplateVersion,
} from "../infrastructure/applications-repository";

// return_application (packet M2.7; HIRING_WORKFLOW §16). One transaction marks
// the submitted version returned, records the reason and what reopened, moves
// the stage back, swaps the review item for the candidate's task, and writes
// audit and the outbox row. Nothing submitted is erased. Audit gets codes only;
// the instructions are candidate-visible and stay on the return record.

export type ReturnInput = Readonly<{
  commandKey?: string;
  candidacyId?: string;
  expectedVersion?: string;
  reasonCode?: string;
  instructions?: string;
  /** JSON: section code to the field codes flagged in it. */
  selection?: string;
  attachments?: string;
}>;

function parseSelection(value: unknown): unknown {
  if (typeof value !== "string" || value.length > 8000) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export async function returnApplication(
  input: ReturnInput,
  actor: CandidateActor,
  deps: CandidateDependencies = candidateDependencies(),
): Promise<CandidateOutcome> {
  if (actor.kind === "CANDIDATE") {
    return { kind: "REFUSED", reason: "NOT_AUTHORIZED" };
  }
  if (!isCandidacyPublicId(input.candidacyId)) {
    return { kind: "REFUSED", reason: "NOT_FOUND" };
  }
  const expected =
    typeof input.expectedVersion === "string" &&
    /^[1-9][0-9]{0,8}$/.test(input.expectedVersion)
      ? Number(input.expectedVersion)
      : null;
  const reason = input.reasonCode;
  const instructions = normalizeInstructions(input.instructions);
  const rawSelection = parseSelection(input.selection);
  const attachments = input.attachments === "yes";
  if (
    expected === null ||
    !isReturnReason(reason) ||
    instructions === null ||
    rawSelection === null ||
    (input.attachments !== undefined && !attachments)
  ) {
    return { kind: "REFUSED", reason: "INVALID_INPUT" };
  }
  const account =
    actor.kind === "BOOTSTRAP" ? actor.accountId : actor.principal.accountId;
  if (!deps.limiter.consume("applicationReturnPerAccount", account)) {
    return { kind: "REFUSED", reason: "RATE_LIMITED" };
  }
  return runCandidateCommand(
    deps,
    actor,
    {
      name: "return_application",
      commandKey: input.commandKey,
      fingerprint: fingerprint({
        candidacy: input.candidacyId,
        expected,
        reason,
        instructions,
        selection: input.selection,
        attachments,
      }),
    },
    async (ctx) => {
      const row =
        (await findCandidacyByPublicId(ctx.tx, input.candidacyId!, "update")) ??
        refuse("NOT_FOUND");
      await authorizeCandidateCommand(
        ctx,
        deps,
        "application.review",
        "REVIEW",
        {
          kind: "RECORD",
          id: row.id,
          sensitivity: "CONFIDENTIAL_PERSONNEL",
        },
        undefined,
        candidacyWorkflow(row),
      );
      if (row.version !== expected) refuse("STALE_VERSION");
      if (
        row.status !== "ACTIVE" ||
        (row.currentStage !== "APPLICATION_SUBMITTED" &&
          row.currentStage !== "PRESCREEN_REVIEW")
      ) {
        refuse("INVALID_TRANSITION");
      }
      // A hold pauses progression, including asking for more information.
      if (await findActiveHold(ctx.tx, row.id)) refuse("ON_HOLD");
      const latest = await findLatestVersion(ctx.tx, row.id);
      if (latest?.status !== "SUBMITTED") return refuse("INVALID_TRANSITION");
      const pinned = await findTemplateVersion(
        ctx.tx,
        latest.templateVersionId,
      );
      const template = pinned && parseTemplate(pinned.schemaJson);
      if (!template) return refuse("TEMPLATE_UNAVAILABLE");
      const reopened = parseReopenSelection(template, rawSelection);
      if (!reopened || (Object.keys(reopened).length === 0 && !attachments)) {
        return refuse("INVALID_INPUT");
      }
      await ctx.tx.insert(applicationReturn).values({
        applicationVersionId: latest.id,
        candidacyId: row.id,
        reasonCode: reason!,
        instructions,
        reopened,
        attachmentsReopened: attachments,
        returnedByAccountId: ctx.actorId,
        returnedAt: ctx.now,
      });
      await ctx.tx
        .update(applicationVersion)
        .set({ status: "RETURNED" })
        .where(eq(applicationVersion.id, latest.id));
      const updated = await markApplicationReturned(ctx, row, reason!);
      // Asking for more during prescreen ends this review. The resubmitted
      // version gets its own, so the first stays as history.
      await ctx.tx
        .update(prescreenReview)
        .set({
          status: "RETURNED",
          version: sql`${prescreenReview.version} + 1`,
        })
        .where(
          and(
            eq(prescreenReview.candidacyId, row.id),
            eq(prescreenReview.status, "IN_PROGRESS"),
          ),
        );
      await ctx.tx.insert(outboxEvent).values({
        aggregateType: "CANDIDACY",
        aggregateId: row.id,
        aggregateVersion: updated.version,
        eventType: "APPLICATION_RETURNED_EMAIL",
        createdAt: ctx.now,
        availableAt: ctx.now,
      });
      ctx.events.push({
        code: "application.returned",
        recordRef: row.id,
        candidacyRef: row.id,
        organizationRef: row.organizationId,
        previousVersion: row.version,
        newVersion: updated.version,
        reasonCode: reason!,
        count: Object.keys(reopened).length,
        changeCodes: attachments ? ["ATTACHMENTS_REOPENED"] : ["SECTIONS_ONLY"],
      });
      return {
        outcome: "RETURNED",
        targetId: row.id,
        version: updated.version,
      };
    },
  );
}

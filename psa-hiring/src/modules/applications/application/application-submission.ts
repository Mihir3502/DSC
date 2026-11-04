import "server-only";
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  authorizeCandidateCommand,
  candidacyWorkflow,
  candidateDependencies,
  findCandidacyByPublicId,
  fingerprint,
  isCandidacyPublicId,
  markApplicationSubmitted,
  newCandidateReference,
  refuse,
  runCandidateCommand,
  type CandidateActor,
  type CandidateDependencies,
  type CandidateOutcome,
} from "@/modules/candidates";
import { listSubmittableAttachments } from "@/modules/documents";
import { cycleForCandidacy } from "@/modules/organization";
import {
  checkApplication,
  normalizeSignature,
  parseTemplate,
  type ApplicationCheck,
} from "../domain/application-template";
import {
  applicationSubmission,
  applicationSubmissionAttachment,
  applicationVersion,
  outboxEvent,
} from "../infrastructure/applications-schema";
import {
  findDraft,
  findEffectiveCertification,
  findTemplateVersion,
  listDraftSections,
} from "../infrastructure/applications-repository";

// submit_application (packet M2.6; HIRING_WORKFLOW §5.2-5.3). One transaction
// re-checks everything against current state, freezes the answers and clean
// attachment versions with the certification version accepted, moves the
// stage, completes the candidate's task, opens the staff review item, and
// writes the audit event and outbox row. The client supplies a key, the review
// token it was shown, the certification version, and a typed name.

export type SubmitInput = Readonly<{
  commandKey?: string;
  candidacyId?: string;
  certificationVersion?: string;
  certified?: string;
  signature?: string;
  reviewToken?: string;
}>;

export type SubmitResult =
  CandidateOutcome | Readonly<{ kind: "INCOMPLETE"; check: ApplicationCheck }>;

class Incomplete extends Error {
  constructor(readonly check: ApplicationCheck) {
    super("application incomplete");
  }
}

/** What the candidate reviewed; a save or file change invalidates it. */
export function reviewTokenFor(
  answers: Readonly<Record<string, unknown>>,
  attachmentVersionIds: readonly string[],
  certificationVersion: number,
): string {
  const canonical = JSON.stringify({
    answers: Object.keys(answers)
      .sort()
      .map((section) => [section, answers[section]]),
    attachments: [...attachmentVersionIds].sort(),
    certificationVersion,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

export async function submitApplication(
  input: SubmitInput,
  actor: CandidateActor,
  deps: CandidateDependencies = candidateDependencies(),
): Promise<SubmitResult> {
  if (actor.kind === "STAFF") {
    return { kind: "REFUSED", reason: "NOT_AUTHORIZED" };
  }
  if (!isCandidacyPublicId(input.candidacyId)) {
    return { kind: "REFUSED", reason: "NOT_FOUND" };
  }
  const signature = normalizeSignature(input.signature);
  const version =
    typeof input.certificationVersion === "string" &&
    /^[1-9][0-9]{0,8}$/.test(input.certificationVersion)
      ? Number(input.certificationVersion)
      : null;
  if (
    input.certified !== "yes" ||
    signature === null ||
    version === null ||
    typeof input.reviewToken !== "string" ||
    !/^[0-9a-f]{64}$/.test(input.reviewToken)
  ) {
    return { kind: "REFUSED", reason: "INVALID_INPUT" };
  }
  const account =
    actor.kind === "BOOTSTRAP" ? actor.accountId : actor.principal.accountId;
  if (!deps.limiter.consume("applicationSubmitPerAccount", account)) {
    return { kind: "REFUSED", reason: "RATE_LIMITED" };
  }
  try {
    return await runCandidateCommand(
      deps,
      actor,
      {
        name: "submit_application",
        commandKey: input.commandKey,
        fingerprint: fingerprint({
          candidacy: input.candidacyId,
          version,
          signature,
          token: input.reviewToken,
        }),
      },
      async (ctx) => {
        const row =
          (await findCandidacyByPublicId(
            ctx.tx,
            input.candidacyId!,
            "update",
          )) ?? refuse("NOT_FOUND");
        await authorizeCandidateCommand(
          ctx,
          deps,
          "application.own.submit",
          "CREATE",
          {
            kind: "RECORD",
            id: row.id,
            sensitivity: "CONFIDENTIAL_PERSONNEL",
          },
          undefined,
          candidacyWorkflow(row),
        );
        if (
          row.status !== "ACTIVE" ||
          row.currentStage !== "APPLICATION_INCOMPLETE"
        ) {
          refuse("INVALID_TRANSITION");
        }
        const cycle = await cycleForCandidacy(
          ctx.tx,
          { cycleId: row.hiringCycleId },
          ctx.now,
        );
        if (!cycle?.accepting) refuse("OPENING_UNAVAILABLE");
        const draft =
          (await findDraft(ctx.tx, row.id)) ?? refuse("INVALID_TRANSITION");
        const templateRow = await findTemplateVersion(
          ctx.tx,
          draft.templateVersionId,
        );
        const template = templateRow && parseTemplate(templateRow.schemaJson);
        if (!template) return refuse("TEMPLATE_UNAVAILABLE");
        const answers = Object.fromEntries(
          (await listDraftSections(ctx.tx, draft.id)).map((s) => [
            s.sectionCode,
            s.answers,
          ]),
        );
        const check = checkApplication(template, answers);
        if (!check.complete) throw new Incomplete(check);
        const certification =
          (await findEffectiveCertification(ctx.tx, ctx.now)) ??
          refuse("TEMPLATE_UNAVAILABLE");
        const files = await listSubmittableAttachments(ctx.tx, row.id);
        const versionIds = files.included.map((f) => f.versionId);
        const token = reviewTokenFor(
          answers,
          versionIds,
          certification.versionNumber,
        );
        // Whatever changed since the review page was read must be seen again.
        if (
          certification.versionNumber !== version ||
          token !== input.reviewToken
        ) {
          refuse("STALE_VERSION");
        }
        const [submission] = await ctx.tx
          .insert(applicationSubmission)
          .values({
            applicationVersionId: draft.id,
            candidacyId: row.id,
            templateVersionId: draft.templateVersionId,
            certificationVersionId: certification.id,
            answers,
            contentHash: token,
            certifiedName: signature,
            receiptNumber: `R-${newCandidateReference().slice(2)}`,
            submittedByAccountId: ctx.actorId,
            submittedAt: ctx.now,
          })
          .returning({ id: applicationSubmission.id });
        if (versionIds.length > 0) {
          await ctx.tx.insert(applicationSubmissionAttachment).values(
            versionIds.map((documentVersionId) => ({
              submissionId: submission!.id,
              documentVersionId,
            })),
          );
        }
        await ctx.tx
          .update(applicationVersion)
          .set({ status: "SUBMITTED" })
          .where(eq(applicationVersion.id, draft.id));
        const updated = await markApplicationSubmitted(ctx, row);
        await ctx.tx.insert(outboxEvent).values({
          aggregateType: "CANDIDACY",
          aggregateId: row.id,
          aggregateVersion: updated.version,
          eventType: "APPLICATION_RECEIVED_EMAIL",
          createdAt: ctx.now,
          availableAt: ctx.now,
        });
        ctx.events.push({
          code: "application.submitted",
          recordRef: row.id,
          candidacyRef: row.id,
          organizationRef: row.organizationId,
          previousVersion: row.version,
          newVersion: updated.version,
          changeCodes: [
            `TEMPLATE_V${templateRow!.versionNumber}`,
            `CERTIFICATION_V${certification.versionNumber}`,
          ],
          count: versionIds.length,
        });
        return {
          outcome: "SUBMITTED",
          targetId: row.id,
          version: updated.version,
        };
      },
    );
  } catch (error) {
    if (error instanceof Incomplete) {
      return { kind: "INCOMPLETE", check: error.check };
    }
    throw error;
  }
}

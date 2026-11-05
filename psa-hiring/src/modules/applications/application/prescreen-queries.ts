import "server-only";
import { and, desc, eq } from "drizzle-orm";
import {
  authorize,
  project,
  resolveCurrentStaff,
  type AuthorizationRequest,
  type Principal,
} from "@/modules/identity-access";
import {
  candidacyWorkflow,
  candidateDependencies,
  findAccountName,
  findActiveHold,
  findCandidacyByPublicId,
  holdCategoryLabels,
  isCandidacyPublicId,
  type CandidateDependencies,
  type CandidateExecutor,
} from "@/modules/candidates";
import {
  allAnswered,
  exceptionIsCurrent,
  exceptionReasonLabels,
  hasUnmet,
  notSelectedReasonLabels,
  parseChecklistItems,
  passBlocker,
  type PrescreenFacts,
} from "../domain/prescreen";
import {
  prescreenChecklistVersion,
  prescreenReview,
} from "../infrastructure/applications-schema";
import {
  prescreenContract,
  type PrescreenView,
} from "../presentation/application-views";

// The prescreen screen's one read (packet M3.3 §8). It writes nothing. Readers
// are the people who can act on a prescreen (Recruiter, HR, PSA Manager). Anyone
// else, and any unknown record, gets one NOT_FOUND. Notes, reasons, and answers
// are staff-only: nothing here reaches a candidate projection.

export type PrescreenResult =
  | Readonly<{ kind: "OK"; view: PrescreenView }>
  | Readonly<{ kind: "UNAUTHENTICATED" | "NOT_FOUND" }>;

const silent: CandidateDependencies["events"] = {
  record: async () => true,
  recordInTransaction: async () => {},
};

const db = (deps: CandidateDependencies) =>
  deps.db as unknown as CandidateExecutor;

function request(
  principal: Principal,
  permission: string,
  operation: AuthorizationRequest["operation"],
  id: string,
  extra: Pick<
    AuthorizationRequest,
    "reasonCode" | "workflow" | "holdCategory"
  > = {},
): AuthorizationRequest {
  return {
    principal: {
      accountId: principal.accountId,
      accountType: principal.accountType,
      sessionId: principal.sessionId,
    },
    permission,
    operation,
    resource: { kind: "RECORD", id, sensitivity: "CONFIDENTIAL_PERSONNEL" },
    ...extra,
  };
}

export async function queryPrescreen(
  headers: Headers,
  candidacyId: unknown,
  deps: CandidateDependencies = candidateDependencies(),
): Promise<PrescreenResult> {
  const principal = await resolveCurrentStaff(headers);
  if (!principal) return { kind: "UNAUTHENTICATED" };
  if (!isCandidacyPublicId(candidacyId)) return { kind: "NOT_FOUND" };
  const row = await findCandidacyByPublicId(db(deps), candidacyId, null);
  if (!row) return { kind: "NOT_FOUND" };
  const probe = { ...deps, events: silent };
  // Prescreen permissions depend on the stage, so reading uses a stage-free one
  // alongside a role check that holds at any stage: the queue read, which only
  // the people who run prescreens have.
  const allowed = await authorize(
    request(principal, "candidate.work_queue.read", "READ", row.id),
    deps,
  );
  if (allowed.decision !== "ALLOW") return { kind: "NOT_FOUND" };
  const workflow = candidacyWorkflow(row);
  const can = async (
    permission: string,
    operation: AuthorizationRequest["operation"],
    reasonCode?: string,
  ) => {
    const decision = await authorize(
      request(principal, permission, operation, row.id, {
        workflow,
        ...(reasonCode ? { reasonCode } : {}),
      }),
      probe,
    );
    return decision;
  };
  const allows = async (
    permission: string,
    operation: AuthorizationRequest["operation"],
    reasonCode?: string,
  ) => (await can(permission, operation, reasonCode)).decision === "ALLOW";

  const [review] = await db(deps)
    .select()
    .from(prescreenReview)
    .where(eq(prescreenReview.candidacyId, row.id))
    .orderBy(desc(prescreenReview.acceptedAt), desc(prescreenReview.id))
    .limit(1);
  const [checklist] = review
    ? await db(deps)
        .select({
          versionNumber: prescreenChecklistVersion.versionNumber,
          items: prescreenChecklistVersion.items,
          reviewStatus: prescreenChecklistVersion.reviewStatus,
        })
        .from(prescreenChecklistVersion)
        .where(and(eq(prescreenChecklistVersion.id, review.checklistVersionId)))
    : [];
  const items = parseChecklistItems(checklist?.items);
  const hold = await findActiveHold(db(deps), row.id);
  const inProgress =
    review?.status === "IN_PROGRESS" && row.currentStage === "PRESCREEN_REVIEW";
  const facts: PrescreenFacts | null = review
    ? {
        items,
        responses: review.responses as Record<string, unknown>,
        responsesVersion: review.responsesVersion,
        exceptionResponsesVersion: review.exceptionResponsesVersion,
      }
    : null;

  const actions: string[] = [];
  if (
    row.status === "ACTIVE" &&
    row.currentStage === "APPLICATION_SUBMITTED" &&
    (await allows("prescreen.begin", "REVIEW"))
  ) {
    actions.push("accept");
  }
  const canComplete =
    inProgress && (await allows("prescreen.complete", "APPROVE"));
  if (canComplete && !hold) {
    actions.push("save", "not_select");
    if (facts && passBlocker(facts) === null) actions.push("pass");
  }
  if (
    inProgress &&
    !hold &&
    facts &&
    hasUnmet(facts) &&
    !exceptionIsCurrent(facts)
  ) {
    const decision = await can(
      "prescreen.exception.approve",
      "APPROVE",
      "EQUIVALENT_EXPERIENCE",
    );
    const permitted =
      decision.decision === "ALLOW" ||
      decision.reasonCode === "RECENT_AUTH_REQUIRED";
    if (permitted && review!.reviewerAccountId !== principal.accountId) {
      actions.push("exception");
    }
  }
  // Holds have their own rule: a PSA Manager may hold without being able to
  // complete the prescreen.
  const holdAllowed = async (
    permission: string,
    operation: AuthorizationRequest["operation"],
    reasonCode: string,
  ) =>
    (
      await authorize(
        request(principal, permission, operation, row.id, {
          workflow,
          reasonCode,
          holdCategory: "RECRUITING",
        }),
        probe,
      )
    ).decision === "ALLOW";
  if (
    inProgress &&
    !hold &&
    (await holdAllowed("compliance_hold.place", "CREATE", "INTERNAL_REVIEW"))
  ) {
    actions.push("place_hold");
  }
  if (
    inProgress &&
    hold &&
    (await holdAllowed("compliance_hold.remove", "EDIT", "RESOLVED"))
  ) {
    actions.push("remove_hold");
  }

  const nameOf = async (id: string | null) =>
    id ? ((await findAccountName(db(deps), id)) ?? "Unavailable") : null;

  const view: PrescreenView = {
    candidacyId: row.publicId,
    reference: row.candidateReference,
    candidacyVersion: row.version,
    status: (review?.status ?? "NOT_STARTED") as PrescreenView["status"],
    reviewVersion: review?.version ?? null,
    checklistVersion: checklist?.versionNumber ?? null,
    checklistDraft: checklist?.reviewStatus === "DRAFT_UNREVIEWED",
    items: items.map((item) => ({
      code: item.code,
      label: item.label,
      result:
        (facts?.responses[item.code] as
          "MET" | "NOT_MET" | "NOT_APPLICABLE" | undefined) ?? null,
    })),
    complete: facts ? allAnswered(facts) : false,
    notes: review?.internalNotes ?? null,
    reviewer: await nameOf(review?.reviewerAccountId ?? null),
    exception: review?.exceptionReasonCode
      ? {
          reason:
            exceptionReasonLabels[
              review.exceptionReasonCode as keyof typeof exceptionReasonLabels
            ] ?? "Unavailable",
          by: (await nameOf(review.exceptionByAccountId)) ?? "Unavailable",
          when: review.exceptionAt!.toISOString(),
        }
      : null,
    exceptionNeeded: facts
      ? hasUnmet(facts) && !exceptionIsCurrent(facts)
      : false,
    decision: review?.decidedAt
      ? {
          by: (await nameOf(review.decidedByAccountId)) ?? "Unavailable",
          when: review.decidedAt.toISOString(),
          reason: review.notSelectedReasonCode
            ? (notSelectedReasonLabels[
                review.notSelectedReasonCode as keyof typeof notSelectedReasonLabels
              ] ?? "Unavailable")
            : null,
        }
      : null,
    hold: hold
      ? {
          version: hold.version,
          category:
            holdCategoryLabels[
              hold.categoryCode as keyof typeof holdCategoryLabels
            ] ?? "Unavailable",
          reason: hold.internalReason,
          reviewDate: hold.reviewAt.toISOString().slice(0, 10),
          placedBy: (await nameOf(hold.placedByAccountId)) ?? "Unavailable",
        }
      : null,
    actions,
  };
  const projected = project(prescreenContract, view, {
    audience: "STAFF",
    purpose: "DETAIL",
    allowed: new Set(["candidate.work_queue.read"]),
  });
  if (projected.kind !== "PROJECTED") {
    deps.logger.error("authz.projection_refused", {
      module: "applications",
      action: prescreenContract.name,
      reasonCode: projected.reason,
    });
    return { kind: "NOT_FOUND" };
  }
  return { kind: "OK", view: projected.value };
}

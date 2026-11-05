import "server-only";
import {
  authorize,
  project,
  resolveCurrentStaff,
  type AuthorizationDependencies,
  type AuthorizationRequest,
  type Principal,
  type ProjectionContract,
} from "@/modules/identity-access";
import { isCandidacyPublicId } from "../domain/candidacy-policy";
import {
  candidateStatusCode,
  candidateStatusWording,
} from "../domain/candidate-portal";
import {
  blockerLabels,
  deriveBlockers,
  mergeTimeline,
  stageEventLabels,
  workspaceTabs,
} from "../domain/candidate-workspace";
import { holdCategoryLabels, type HoldCategory } from "../domain/holds";
import {
  nextStaffAction,
  ownerChangeReasonLabels,
  responsibilityChangeLabels,
  stageLabels,
  workerPathLabels,
  type OwnerChangeReason,
  type StageFilter,
  type WorkerPathFilter,
} from "../domain/work-queue";
import {
  findAccountName,
  findActiveHold,
  findCandidacyByPublicId,
  findOpenStaffWorkItem,
  findPerson,
  findPlacementLabels,
  hasActiveCorrection,
  hasOpenDuplicate,
  listHoldEvents,
  listResponsibilityHistory,
  listStageHistory,
  type CandidacyRow,
  type Executor,
} from "../infrastructure/candidates-repository";
import {
  candidateOverviewContract,
  candidateWorkspaceContract,
  type CandidateOverviewView,
  type CandidateWorkspaceView,
} from "../presentation/candidate-views";
import {
  candidateDependencies,
  type CandidateDependencies,
} from "./candidate-runtime";

// Candidate workspace for staff (packet M3.2; UI_FLOW §10). Read only: these
// queries write nothing. Unknown, out-of-scope, and not-permitted records are
// one NOT_FOUND. Tabs depend only on what this reader may open, and carry no
// counts, so nothing about records in a hidden tab can be inferred.

export type WorkspaceResult<V> =
  | Readonly<{ kind: "OK"; view: V }>
  | Readonly<{ kind: "UNAUTHENTICATED" | "NOT_FOUND" }>;

const PERMISSION = "candidate.read.assigned";
const TIMELINE_LIMIT = 50;

const silent: AuthorizationDependencies["events"] = {
  record: async () => true,
  recordInTransaction: async () => {},
};

const db = (deps: CandidateDependencies) => deps.db as unknown as Executor;

function recordRequest(
  principal: Principal,
  permission: string,
  id: string,
): AuthorizationRequest {
  return {
    principal: {
      accountId: principal.accountId,
      accountType: principal.accountType,
      sessionId: principal.sessionId,
    },
    permission,
    operation: "READ",
    resource: { kind: "RECORD", id, sensitivity: "CONFIDENTIAL_PERSONNEL" },
  };
}

function render<V extends object>(
  contract: ProjectionContract<V, V>,
  view: V,
  deps: AuthorizationDependencies,
): WorkspaceResult<V> {
  const projected = project(contract, view, {
    audience: contract.audience,
    purpose: contract.purpose,
    allowed: new Set([PERMISSION]),
  });
  if (projected.kind !== "PROJECTED") {
    deps.logger.error("authz.projection_refused", {
      module: "candidates",
      action: contract.name,
      reasonCode: projected.reason,
    });
    return { kind: "NOT_FOUND" };
  }
  return { kind: "OK", view: projected.value };
}

type Authorized =
  | Readonly<{ kind: "UNAUTHENTICATED" | "NOT_FOUND" }>
  | Readonly<{ kind: "OK"; principal: Principal; row: CandidacyRow }>;

/** The one gate for both queries, so they can't disagree on who gets in. */
async function authorizedRecord(
  headers: Headers,
  candidacyId: unknown,
  deps: CandidateDependencies,
): Promise<Authorized> {
  const principal = await resolveCurrentStaff(headers);
  if (!principal) return { kind: "UNAUTHENTICATED" };
  if (!isCandidacyPublicId(candidacyId)) return { kind: "NOT_FOUND" };
  const row = await findCandidacyByPublicId(db(deps), candidacyId, null);
  if (!row) return { kind: "NOT_FOUND" };
  const allowed = await authorize(
    recordRequest(principal, PERMISSION, row.id),
    deps,
  );
  if (allowed.decision !== "ALLOW") return { kind: "NOT_FOUND" };
  return { kind: "OK", principal, row };
}

const allows = async (
  principal: Principal,
  permission: string,
  id: string,
  deps: CandidateDependencies,
) =>
  (
    await authorize(recordRequest(principal, permission, id), {
      ...deps,
      events: silent,
    })
  ).decision === "ALLOW";

export async function queryCandidateWorkspaceShell(
  headers: Headers,
  candidacyId: unknown,
  deps: CandidateDependencies = candidateDependencies(),
): Promise<WorkspaceResult<CandidateWorkspaceView>> {
  const access = await authorizedRecord(headers, candidacyId, deps);
  if (access.kind !== "OK") return access;
  const { principal, row } = access;
  const who = await findPerson(db(deps), row.personId, null);
  if (!who) return { kind: "NOT_FOUND" };
  const [
    placement,
    item,
    returned,
    history,
    canReadApplication,
    canReadPrescreen,
    canReadHold,
    hold,
  ] = await Promise.all([
    findPlacementLabels(db(deps), row.branchId, row.positionId),
    findOpenStaffWorkItem(db(deps), row.id),
    hasActiveCorrection(db(deps), row.id),
    listStageHistory(db(deps), row.id),
    allows(principal, "application.read", row.id, deps),
    // Prescreen permissions depend on the stage; its readers hold the queue read.
    allows(principal, "candidate.work_queue.read", row.id, deps),
    allows(principal, "compliance_hold.read", row.id, deps),
    findActiveHold(db(deps), row.id),
  ]);
  const closed = row.status !== "ACTIVE";
  const ownerName =
    row.ownerAccountId === null
      ? "Unassigned"
      : row.ownerAccountId === principal.accountId
        ? "You"
        : ((await findAccountName(db(deps), row.ownerAccountId)) ??
          "Another staff member");
  return render(
    candidateWorkspaceContract,
    {
      id: row.publicId,
      reference: row.candidateReference,
      displayName: [
        who.preferredName ?? who.legalFirstName,
        who.legalLastName,
      ].join(" "),
      position: placement?.position ?? "Unavailable",
      branch: placement?.branch ?? "Unavailable",
      stage: stageLabels[row.currentStage as StageFilter] ?? "Unavailable",
      status:
        candidateStatusWording[
          candidateStatusCode(row.currentStage, row.status)
        ].label,
      closed,
      workerPath:
        workerPathLabels[row.proposedWorkerPath as WorkerPathFilter] ??
        "Unavailable",
      owner: ownerName,
      nextAction: closed
        ? "None: this record is closed"
        : nextStaffAction(row.currentStage, returned, item !== null),
      dueDate: item?.dueAt ? item.dueAt.toISOString().slice(0, 10) : null,
      // The category only. The internal reason stays on the Prescreen tab.
      hold:
        hold && canReadHold
          ? {
              label:
                holdCategoryLabels[hold.categoryCode as HoldCategory] ??
                "Unavailable",
            }
          : null,
      tabs: [
        ...workspaceTabs(row.publicId, {
          canReadApplication,
          canReadPrescreen,
          everSubmitted: history.some(
            (h) => h.commandCode === "submit_application",
          ),
        }),
      ],
    },
    deps,
  );
}

export async function queryCandidateOverview(
  headers: Headers,
  candidacyId: unknown,
  deps: CandidateDependencies = candidateDependencies(),
): Promise<WorkspaceResult<CandidateOverviewView>> {
  const access = await authorizedRecord(headers, candidacyId, deps);
  if (access.kind !== "OK") return access;
  const { principal, row } = access;
  const now = deps.clock();
  const [
    item,
    returned,
    stages,
    changes,
    canManage,
    canSeeDuplicate,
    canReadHold,
    hold,
    holds,
  ] = await Promise.all([
    findOpenStaffWorkItem(db(deps), row.id),
    hasActiveCorrection(db(deps), row.id),
    listStageHistory(db(deps), row.id),
    listResponsibilityHistory(db(deps), row.id, TIMELINE_LIMIT),
    allows(principal, "candidate.work_queue.read", row.id, deps),
    allows(principal, "candidate.prospect.read", row.id, deps),
    allows(principal, "compliance_hold.read", row.id, deps),
    findActiveHold(db(deps), row.id),
    listHoldEvents(db(deps), row.id),
  ]);
  const possibleDuplicate =
    canSeeDuplicate &&
    (await hasOpenDuplicate(db(deps), row.personId, row.organizationId));
  const timeline = mergeTimeline<
    Readonly<{ occurredAt: Date; event: string; detail: string | null }>
  >(
    [
      stages.map((s) => ({
        occurredAt: s.occurredAt,
        event: stageEventLabels[s.commandCode] ?? "Stage changed",
        detail: null,
      })),
      changes.map((c) => {
        const reason = c.reasonCode
          ? ownerChangeReasonLabels[c.reasonCode as OwnerChangeReason]
          : undefined;
        return {
          occurredAt: c.occurredAt,
          event: responsibilityChangeLabels[c.changeCode] ?? "Changed",
          // Who and why stay with the people who manage the queue.
          detail: canManage
            ? [reason, `by ${c.actorName}`].filter(Boolean).join(", ")
            : null,
        };
      }),
      canReadHold
        ? holds.flatMap((h) => [
            {
              occurredAt: h.placedAt,
              event: "Placed on hold",
              detail: null,
            },
            ...(h.removedAt
              ? [
                  {
                    occurredAt: h.removedAt,
                    event: "Hold removed",
                    detail: null,
                  },
                ]
              : []),
          ])
        : [],
    ],
    TIMELINE_LIMIT,
  );
  return render(
    candidateOverviewContract,
    {
      blockers: deriveBlockers({
        stage: row.currentStage,
        status: row.status,
        returned,
        overdue: item?.dueAt ? item.dueAt < now : false,
        unassigned: row.ownerAccountId === null,
        possibleDuplicate,
        onHold: hold !== null && canReadHold,
      }).map((code) => ({ code, label: blockerLabels[code] })),
      timeline: timeline.map((t) => ({
        event: t.event,
        detail: t.detail,
        when: t.occurredAt.toISOString(),
      })),
      canManageWork: canManage && row.status === "ACTIVE",
    },
    deps,
  );
}

import "server-only";
import { and, eq, inArray } from "drizzle-orm";
import {
  authorize,
  authorizeQueryScope,
  listStaffHoldingPermissionAt,
  project,
  resolveCurrentStaff,
  type AuthorizationDependencies,
  type AuthorizationRequest,
  type Principal,
  type ProjectionContract,
} from "@/modules/identity-access";
import { isCandidacyPublicId } from "../domain/candidacy-policy";
import {
  encodeWorkQueueCursor,
  nextStaffAction,
  ownerChangeReasonLabels,
  parseWorkQueueFilters,
  responsibilityChangeLabels,
  stageLabels,
  WORK_QUEUE_PAGE_SIZE,
  workerPathLabels,
  type OwnerChangeReason,
  type StageFilter,
  type WorkerPathFilter,
  type WorkQueueSearch,
} from "../domain/work-queue";
import {
  countWorkQueue,
  countWorkQueueDashboard,
  findAccountName,
  findCandidacyByPublicId,
  findOpenStaffWorkItem,
  findPerson,
  findPlacementLabels,
  listResponsibilityHistory,
  listWorkQueueFilterOptions,
  listWorkQueuePage,
  type Executor,
  type WorkQueueContext,
} from "../infrastructure/candidates-repository";
import { workItem } from "../infrastructure/candidates-schema";
import {
  staffDashboardContract,
  staffShellContract,
  workItemContract,
  workQueueContract,
  type StaffDashboardView,
  type StaffShellView,
  type WorkItemView,
  type WorkQueueView,
} from "../presentation/candidate-views";
import {
  candidateDependencies,
  type CandidateDependencies,
} from "./candidate-runtime";

// Staff dashboard and unified work queue (packet M3.1; UI_FLOW §9). Purpose-
// specific reads that write nothing. Scope is enforced in SQL by the central
// constraint, and each returned row is rechecked. Unknown, out-of-scope, and
// not-permitted records are one NOT_FOUND. A staff member's own candidacy never
// appears. Only what's implemented is shown: no blocker counts, holds, or
// deadlines are invented.

export type WorkQueueResult<V> =
  | Readonly<{ kind: "OK"; view: V }>
  | Readonly<{
      kind: "UNAUTHENTICATED" | "NOT_FOUND" | "NO_QUEUE" | "INVALID_FILTERS";
    }>;

const PERMISSION = "candidate.work_queue.read";

const silent: AuthorizationDependencies["events"] = {
  record: async () => true,
  recordInTransaction: async () => {},
};

const db = (deps: CandidateDependencies) => deps.db as unknown as Executor;

const principalOf = (p: Principal) => ({
  accountId: p.accountId,
  accountType: p.accountType,
  sessionId: p.sessionId,
});

function recordRequest(
  principal: Principal,
  permission: string,
  operation: AuthorizationRequest["operation"],
  id: string,
  reasonCode?: string,
): AuthorizationRequest {
  return {
    principal: principalOf(principal),
    permission,
    operation,
    resource: { kind: "RECORD", id, sensitivity: "CONFIDENTIAL_PERSONNEL" },
    ...(reasonCode ? { reasonCode } : {}),
  };
}

function render<V extends object>(
  contract: ProjectionContract<V, V>,
  view: V,
  deps: AuthorizationDependencies,
): WorkQueueResult<V> {
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

const scopeRequest = (principal: Principal) => ({
  principal: principalOf(principal),
  permission: PERMISSION,
  operation: "READ" as const,
  sensitivity: "CONFIDENTIAL_PERSONNEL" as const,
});

/** Turns the central scope decision into the queue's query context. */
function queueContext(
  principal: Principal,
  scope: Awaited<ReturnType<typeof authorizeQueryScope>>,
  deps: CandidateDependencies,
): WorkQueueContext | null {
  if (scope.decision !== "ALLOW" || scope.constraint.kind !== "SCOPES") {
    return null;
  }
  const teamIds = scope.constraint.scopes.flatMap((s) =>
    s.type === "TEAM" ? [s.teamId] : [],
  );
  return {
    constraint: {
      ...scope.constraint,
      excludeSubjectAccountId: principal.accountId,
    },
    actorAccountId: principal.accountId,
    teamIds,
    now: deps.clock(),
  };
}

const displayName = (p: {
  preferredName: string | null;
  legalFirstName: string;
  legalLastName: string;
}) => [p.preferredName ?? p.legalFirstName, p.legalLastName].join(" ");

const stageLabel = (stage: string) =>
  stageLabels[stage as StageFilter] ?? "Unavailable";
const workerPathLabel = (path: string) =>
  workerPathLabels[path as WorkerPathFilter] ?? "Unavailable";
const dayOf = (at: Date | null) => (at ? at.toISOString().slice(0, 10) : null);

/** Which staff links apply. Never passed down as authority. */
export async function queryStaffShell(
  headers: Headers,
  deps: CandidateDependencies = candidateDependencies(),
): Promise<WorkQueueResult<StaffShellView>> {
  const principal = await resolveCurrentStaff(headers);
  if (!principal) return { kind: "UNAUTHENTICATED" };
  const scope = await authorizeQueryScope(scopeRequest(principal), {
    ...deps,
    events: silent,
  });
  const context = queueContext(principal, scope, deps);
  if (!context) return { kind: "NO_QUEUE" };
  return render(
    staffShellContract,
    {
      navigation: [
        { label: "Dashboard", href: "/staff" },
        { label: "Work Queue", href: "/staff/work" },
      ],
    },
    deps,
  );
}

export async function queryStaffDashboard(
  headers: Headers,
  deps: CandidateDependencies = candidateDependencies(),
): Promise<WorkQueueResult<StaffDashboardView>> {
  const principal = await resolveCurrentStaff(headers);
  if (!principal) return { kind: "UNAUTHENTICATED" };
  const scope = await authorizeQueryScope(scopeRequest(principal), {
    ...deps,
    events: silent,
  });
  const context = queueContext(principal, scope, deps);
  if (!context) return { kind: "NO_QUEUE" };
  return render(
    staffDashboardContract,
    await countWorkQueueDashboard(db(deps), context),
    deps,
  );
}

export async function queryWorkQueue(
  headers: Headers,
  search: WorkQueueSearch,
  deps: CandidateDependencies = candidateDependencies(),
): Promise<WorkQueueResult<WorkQueueView>> {
  const principal = await resolveCurrentStaff(headers);
  if (!principal) return { kind: "UNAUTHENTICATED" };
  const scope = await authorizeQueryScope(scopeRequest(principal), {
    ...deps,
    events: silent,
  });
  const context = queueContext(principal, scope, deps);
  if (!context) return { kind: "NOT_FOUND" };
  const filters = parseWorkQueueFilters(search);
  if (!filters) return { kind: "INVALID_FILTERS" };
  const [rows, total, options] = await Promise.all([
    listWorkQueuePage(db(deps), filters, context, WORK_QUEUE_PAGE_SIZE + 1),
    countWorkQueue(db(deps), filters, context),
    listWorkQueueFilterOptions(db(deps), context),
  ]);
  const page = rows.slice(0, WORK_QUEUE_PAGE_SIZE);
  const last = page.at(-1);
  const items: WorkQueueView["items"][number][] = [];
  for (const row of page) {
    const recheck = await authorize(
      recordRequest(principal, PERMISSION, "READ", row.id),
      { ...deps, events: silent },
    );
    if (recheck.decision !== "ALLOW") continue;
    items.push({
      id: row.publicId,
      reference: row.reference,
      displayName: displayName(row),
      position: row.position,
      branch: row.branch,
      stage: stageLabel(row.stage),
      nextAction: nextStaffAction(row.stage, row.returned, row.itemId !== null),
      owner:
        row.ownerAccountId === null
          ? "Unassigned"
          : row.ownerAccountId === principal.accountId
            ? "You"
            : (row.ownerName ?? "Another staff member"),
      workerPath: workerPathLabel(row.workerPath),
      returned: row.returned,
      dueDate: dayOf(row.dueAt),
      overdue: row.dueAt !== null && row.dueAt < context.now,
      ageDays: Math.max(
        0,
        Math.floor(
          (context.now.getTime() - row.createdAt.getTime()) / 86_400_000,
        ),
      ),
    });
  }
  return render(
    workQueueContract,
    {
      items,
      total,
      nextCursor:
        rows.length > WORK_QUEUE_PAGE_SIZE && last
          ? encodeWorkQueueCursor({
              dueAt: last.dueAt ? last.dueAtText : null,
              createdAt: last.createdAtText,
              publicId: last.publicId,
            })
          : null,
      branches: [...options.branches],
      positions: [...options.positions],
      hasTeamScope: context.teamIds.length > 0,
    },
    deps,
  );
}

/** One record's owner, due date, and allowed actions. Not the M3.2 workspace. */
export async function queryWorkItem(
  headers: Headers,
  candidacyId: unknown,
  deps: CandidateDependencies = candidateDependencies(),
): Promise<WorkQueueResult<WorkItemView>> {
  const principal = await resolveCurrentStaff(headers);
  if (!principal) return { kind: "UNAUTHENTICATED" };
  if (!isCandidacyPublicId(candidacyId)) return { kind: "NOT_FOUND" };
  const row = await findCandidacyByPublicId(db(deps), candidacyId, null);
  if (!row || row.status !== "ACTIVE") return { kind: "NOT_FOUND" };
  const allowed = await authorize(
    recordRequest(principal, PERMISSION, "READ", row.id),
    deps,
  );
  if (allowed.decision !== "ALLOW") return { kind: "NOT_FOUND" };
  const who = await findPerson(db(deps), row.personId, null);
  if (!who) return { kind: "NOT_FOUND" };
  const now = deps.clock();
  const probe = { ...deps, events: silent };
  const can = async (
    permission: string,
    operation: AuthorizationRequest["operation"],
    reason?: string,
  ) =>
    (
      await authorize(
        recordRequest(principal, permission, operation, row.id, reason),
        probe,
      )
    ).decision === "ALLOW";
  const canSelf = await can(
    "candidate.owner.assign",
    "EDIT",
    "WORKLOAD_BALANCE",
  );
  const canOthers = await can(
    "candidate.owner.assign_others",
    "EDIT",
    "WORKLOAD_BALANCE",
  );
  const canDue = await can("candidate.due_date.manage", "EDIT");
  const owned = row.ownerAccountId === principal.accountId;
  const unassigned = row.ownerAccountId === null;
  const actions: string[] = [];
  if (canSelf && unassigned) actions.push("claim");
  if ((canSelf && owned) || (canOthers && !unassigned)) actions.push("release");
  if (canOthers) actions.push("assign");
  const item = await findOpenStaffWorkItem(db(deps), row.id);
  if (canDue && item) actions.push("due_date");
  const eligible = canOthers
    ? await listStaffHoldingPermissionAt(db(deps), {
        permission: "candidate.owner.assign",
        organizationId: row.organizationId,
        branchId: row.branchId,
        teamId: row.teamId,
        excludeAccountIds: [
          ...(who.candidateAccountId ? [who.candidateAccountId] : []),
          ...(row.ownerAccountId ? [row.ownerAccountId] : []),
        ],
        at: now,
        limit: 100,
      })
    : [];
  const placement = await findPlacementLabels(
    db(deps),
    row.branchId,
    row.positionId,
  );
  const history = await listResponsibilityHistory(db(deps), row.id);
  const [correction] = await db(deps)
    .select({ id: workItem.id })
    .from(workItem)
    .where(
      and(
        eq(workItem.candidacyId, row.id),
        eq(workItem.workTypeCode, "CORRECT_APPLICATION"),
        inArray(workItem.status, ["OPEN", "IN_PROGRESS", "BLOCKED"]),
      ),
    )
    .limit(1);
  const returned = correction !== undefined;
  return render(
    workItemContract,
    {
      id: row.publicId,
      reference: row.candidateReference,
      displayName: displayName(who),
      position: placement?.position ?? "Unavailable",
      branch: placement?.branch ?? "Unavailable",
      stage: stageLabel(row.currentStage),
      nextAction: nextStaffAction(row.currentStage, returned, item !== null),
      owner: unassigned
        ? "Unassigned"
        : owned
          ? "You"
          : ((await findAccountName(db(deps), row.ownerAccountId!)) ??
            "Another staff member"),
      unassigned,
      ownedByActor: owned,
      workerPath: workerPathLabel(row.proposedWorkerPath),
      returned,
      version: row.version,
      hasApplication: item !== null || returned,
      item: item
        ? {
            version: item.version,
            dueDate: dayOf(item.dueAt),
            overdue: item.dueAt !== null && item.dueAt < now,
          }
        : null,
      actions,
      eligibleOwners: eligible.map((e) => ({ id: e.accountId, name: e.name })),
      history: history.map((h) => ({
        change: responsibilityChangeLabels[h.changeCode] ?? "Changed",
        reason: h.reasonCode
          ? (ownerChangeReasonLabels[h.reasonCode as OwnerChangeReason] ??
            (h.reasonCode === "INITIAL_ASSIGNMENT"
              ? "Set when the record was created"
              : null))
          : null,
        by: h.actorName,
        when: h.occurredAt.toISOString(),
      })),
    },
    deps,
  );
}

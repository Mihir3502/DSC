import "server-only";
import {
  authorize,
  project,
  resolveCurrentCandidate,
  type AuthorizationRequest,
  type Principal,
  type ProjectionContract,
} from "@/modules/identity-access";
import { cycleForCandidacy } from "@/modules/organization";
import {
  applicationRoutes,
  candidateNavigation,
  candidateStatusCode,
  candidateStatusWording,
  isActionable,
  parseTaskFilter,
  resolveNextAction,
  selectCurrentCandidacy,
  taskCategory,
  workTypes,
  type TaskFilter,
} from "../domain/candidate-portal";
import {
  candidateHelpConfig,
  type HelpConfig,
} from "../infrastructure/candidate-config";
import {
  findPersonByAccount,
  listCandidaciesOfPerson,
  listCandidateWorkItems,
  type CandidacyRow,
  type Executor,
  type WorkItemRow,
} from "../infrastructure/candidates-repository";
import {
  candidateDependencies,
  type CandidateDependencies,
} from "./candidate-runtime";
import {
  candidateHelpContract,
  candidateHomeContract,
  candidateShellContract,
  candidateTasksContract,
  type CandidateHelpView,
  type CandidateHomeView,
  type CandidateShellView,
  type CandidateTasksView,
} from "../presentation/candidate-views";

// Candidate portal queries (packet M2.3 §7, §16, §18). Each derives the
// account from the session, reads only that account's person and candidacies,
// revalidates tasks against the candidacy, and returns one exact projection.
// A reference that isn't the candidate's own is one NOT_FOUND. Reads never
// write: a stale task is hidden here and canceled only by reconciliation.

export type PortalResult<V> =
  | Readonly<{ kind: "OK"; view: V }>
  | Readonly<{
      kind: "UNAUTHENTICATED" | "NOT_FOUND" | "INVALID_FILTER";
    }>;

const db = (deps: CandidateDependencies) => deps.db as unknown as Executor;
const PERMISSION = "candidate.candidacy.read_own";

function ownRequest(principal: Principal): AuthorizationRequest {
  return {
    principal: {
      accountId: principal.accountId,
      accountType: principal.accountType,
      sessionId: principal.sessionId,
    },
    permission: PERMISSION,
    operation: "READ",
    resource: {
      kind: "RECORD",
      id: principal.accountId,
      sensitivity: "CONFIDENTIAL_PERSONNEL",
    },
  };
}

function render<V extends object>(
  contract: ProjectionContract<V, V>,
  view: V,
  deps: CandidateDependencies,
): PortalResult<V> {
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

const factsOf = (row: CandidacyRow) => ({
  stage: row.currentStage,
  status: row.status,
});

function statusOf(row: CandidacyRow, deps: CandidateDependencies) {
  const code = candidateStatusCode(row.currentStage, row.status);
  if (code === "UNAVAILABLE") {
    deps.logger.warn("candidates.status_unmapped", {
      module: "candidates",
      resultCode: "status_unmapped",
    });
  }
  return { code, ...candidateStatusWording[code] };
}

/** One unambiguous format; no per-user timezone setting exists yet. */
const dateLabel = (at: Date) =>
  `${new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(at)} UTC`;

async function openingOf(row: CandidacyRow, deps: CandidateDependencies) {
  const found = await cycleForCandidacy(
    db(deps),
    { cycleId: row.hiringCycleId },
    deps.clock(),
  );
  return {
    title: found?.cycle.publicTitle ?? "",
    location: found?.cycle.locationLabel ?? "",
  };
}

/** The account's own person, candidacies, and tasks: never anyone else's. */
async function loadOwn(principal: Principal, deps: CandidateDependencies) {
  const person = await findPersonByAccount(db(deps), principal.accountId, null);
  const rows = person ? await listCandidaciesOfPerson(db(deps), person.id) : [];
  const items = await listCandidateWorkItems(
    db(deps),
    rows.map((r) => r.id),
  );
  return { person, rows, items };
}

function currentOf(
  rows: readonly CandidacyRow[],
  items: readonly WorkItemRow[],
) {
  const context = rows.map((row) => {
    const own = items.filter(
      (i) => i.candidacyId === row.id && isActionable(i, factsOf(row)),
    );
    const due = own
      .map((i) => i.dueAt)
      .filter((d): d is Date => d !== null)
      .sort((a, b) => a.getTime() - b.getTime());
    return {
      row,
      ...factsOf(row),
      publicId: row.publicId,
      updatedAt: row.updatedAt,
      closedAt: row.closedAt,
      hasAction: resolveNextAction(factsOf(row), own) !== null,
      nearestDue: due[0] ?? null,
    };
  });
  return selectCurrentCandidacy(context)?.row ?? null;
}

function countsOf(
  rows: readonly CandidacyRow[],
  items: readonly WorkItemRow[],
) {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const counts = { actionNeeded: 0, upcoming: 0, underReview: 0, completed: 0 };
  for (const item of items) {
    const row = byId.get(item.candidacyId);
    if (!row) continue;
    const category = taskCategory(item, factsOf(row));
    if (category === "action_needed") counts.actionNeeded += 1;
    if (category === "completed") counts.completed += 1;
  }
  return counts;
}

/** The name and navigation for the portal shell. */
export async function queryCandidateShell(
  headers: Headers,
  deps: CandidateDependencies = candidateDependencies(),
): Promise<PortalResult<CandidateShellView>> {
  const principal = await resolveCurrentCandidate(headers);
  if (!principal) return { kind: "UNAUTHENTICATED" };
  const decision = await authorize(ownRequest(principal), deps);
  if (decision.decision !== "ALLOW") return { kind: "NOT_FOUND" };
  const { person, rows, items } = await loadOwn(principal, deps);
  const current = currentOf(rows, items);
  return render(
    candidateShellContract,
    {
      displayName: person
        ? (person.preferredName ?? person.legalFirstName)
        : null,
      agencyName: candidateHelpConfig().agencyName,
      navigation: [...candidateNavigation(current?.publicId ?? null)],
    },
    deps,
  );
}

/** Candidate home: status, one next action, counts, and the switcher. */
export async function queryCandidateHome(
  headers: Headers,
  requestedCandidacy: unknown,
  deps: CandidateDependencies = candidateDependencies(),
): Promise<PortalResult<CandidateHomeView>> {
  const principal = await resolveCurrentCandidate(headers);
  if (!principal) return { kind: "UNAUTHENTICATED" };
  const decision = await authorize(ownRequest(principal), deps);
  if (decision.decision !== "ALLOW") return { kind: "NOT_FOUND" };
  const { rows, items } = await loadOwn(principal, deps);
  const selected =
    requestedCandidacy === undefined
      ? currentOf(rows, items)
      : (rows.find((r) => r.publicId === requestedCandidacy) ?? null);
  if (requestedCandidacy !== undefined && !selected) {
    return { kind: "NOT_FOUND" };
  }
  if (!selected) {
    return render(
      candidateHomeContract,
      {
        current: null,
        candidacies: [],
        nextAction: null,
        taskCounts: countsOf(rows, items),
      },
      deps,
    );
  }
  const candidacies =
    rows.length > 1
      ? await Promise.all(
          rows.map(async (row) => ({
            candidacyId: row.publicId,
            reference: row.candidateReference,
            ...(await openingOf(row, deps)),
            status: statusOf(row, deps).label,
            selected: row.id === selected.id,
          })),
        )
      : [];
  const next = resolveNextAction(
    factsOf(selected),
    items.filter((i) => i.candidacyId === selected.id),
  );
  const type = next ? workTypes[next.workTypeCode] : undefined;
  return render(
    candidateHomeContract,
    {
      current: {
        candidacyId: selected.publicId,
        reference: selected.candidateReference,
        ...(await openingOf(selected, deps)),
        status: statusOf(selected, deps),
      },
      candidacies,
      nextAction:
        next && type
          ? {
              title: type.title,
              instruction: type.instruction,
              actionLabel: type.actionLabel,
              href: applicationRoutes[type.routeKey](selected.publicId),
              due: next.dueAt ? dateLabel(next.dueAt) : null,
            }
          : null,
      taskCounts: countsOf(rows, items),
    },
    deps,
  );
}

const finishedLabel: Readonly<Record<string, string>> = {
  COMPLETED: "Completed",
  CANCELED: "No longer needed",
};

/** Own tasks under one allowlisted filter, in a stable bounded order. */
export async function queryCandidateTasks(
  headers: Headers,
  requestedFilter: unknown,
  deps: CandidateDependencies = candidateDependencies(),
): Promise<PortalResult<CandidateTasksView>> {
  const principal = await resolveCurrentCandidate(headers);
  if (!principal) return { kind: "UNAUTHENTICATED" };
  const filter: TaskFilter | null = parseTaskFilter(requestedFilter);
  if (!filter) return { kind: "INVALID_FILTER" };
  const decision = await authorize(ownRequest(principal), deps);
  if (decision.decision !== "ALLOW") return { kind: "NOT_FOUND" };
  const { rows, items } = await loadOwn(principal, deps);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const tasks = [];
  for (const item of items) {
    const row = byId.get(item.candidacyId);
    const type = workTypes[item.workTypeCode];
    if (!row || !type || taskCategory(item, factsOf(row)) !== filter) continue;
    const actionable = filter === "action_needed";
    tasks.push({
      key: `${row.publicId}-${item.createdAt.getTime()}`,
      title: type.title,
      instruction: actionable ? type.instruction : null,
      status: actionable
        ? "Action needed"
        : (finishedLabel[item.status] ?? "Completed"),
      due: item.dueAt ? dateLabel(item.dueAt) : null,
      reference: row.candidateReference,
      opening: (await openingOf(row, deps)).title,
      actionLabel: actionable ? type.actionLabel : null,
      href: actionable ? applicationRoutes[type.routeKey](row.publicId) : null,
    });
    if (tasks.length === 50) break;
  }
  return render(
    candidateTasksContract,
    { filter, tasks, counts: countsOf(rows, items) },
    deps,
  );
}

/** Help contact from validated server configuration. */
export async function queryCandidateHelp(
  headers: Headers,
  help: HelpConfig = candidateHelpConfig(),
  deps: CandidateDependencies = candidateDependencies(),
): Promise<PortalResult<CandidateHelpView>> {
  const principal = await resolveCurrentCandidate(headers);
  if (!principal) return { kind: "UNAUTHENTICATED" };
  const decision = await authorize(ownRequest(principal), deps);
  if (decision.decision !== "ALLOW") return { kind: "NOT_FOUND" };
  return render(candidateHelpContract, help, deps);
}

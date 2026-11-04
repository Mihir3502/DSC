// Candidate portal rules (packet M2.3 §7–§10). Pure and deterministic.
//
// The registries here are the one place that candidate-visible wording and
// work types are defined. A work item coordinates action only: the candidacy
// stays authoritative, so an item whose target isn't eligible is never shown
// as actionable.

// ---------------------------------------------------- candidate status

export const CANDIDATE_STATUS_VERSION = "STATUS-1";

export type CandidateStatusCode =
  | "UNDER_REVIEW"
  | "APPLICATION_IN_PROGRESS"
  | "APPLICATION_SUBMITTED"
  | "NOT_CONTINUING"
  | "UNAVAILABLE";

export const candidateStatusWording: Readonly<
  Record<CandidateStatusCode, Readonly<{ label: string; explanation: string }>>
> = Object.freeze({
  UNDER_REVIEW: {
    label: "Under review",
    explanation:
      "We are reviewing your information. No action is needed right now.",
  },
  APPLICATION_IN_PROGRESS: {
    label: "Application in progress",
    explanation: "Complete your application to continue.",
  },
  APPLICATION_SUBMITTED: {
    label: "Application received",
    explanation:
      "We received your application. No action is needed unless we contact you.",
  },
  NOT_CONTINUING: {
    label: "Application not continuing",
    explanation: "This application process is no longer active.",
  },
  UNAVAILABLE: {
    label: "Status unavailable",
    explanation: "We could not load your current status. Please try again.",
  },
});

/** Unknown stages and statuses fail closed to a generic unavailable state. */
export function candidateStatusCode(
  stage: string,
  status: string,
): CandidateStatusCode {
  if (status === "TERMINAL" || status === "ARCHIVED") return "NOT_CONTINUING";
  if (status !== "ACTIVE") return "UNAVAILABLE";
  if (stage === "PROSPECT") return "UNDER_REVIEW";
  if (stage === "APPLICATION_INCOMPLETE") return "APPLICATION_IN_PROGRESS";
  if (stage === "APPLICATION_SUBMITTED") return "APPLICATION_SUBMITTED";
  return "UNAVAILABLE";
}

// --------------------------------------------------------- work items

export const workItemStatuses = [
  "OPEN",
  "IN_PROGRESS",
  "BLOCKED",
  "COMPLETED",
  "CANCELED",
] as const;
export type WorkItemStatus = (typeof workItemStatuses)[number];
export const activeWorkItemStatuses: readonly WorkItemStatus[] = [
  "OPEN",
  "IN_PROGRESS",
  "BLOCKED",
];

export const workItemPriorities = ["NORMAL", "HIGH"] as const;
export type WorkItemPriority = (typeof workItemPriorities)[number];

export const applicationRoutes = {
  APPLICATION_OVERVIEW: (candidacyId: string) =>
    `/candidate/applications/${candidacyId}`,
} as const;
export type CandidateRouteKey = keyof typeof applicationRoutes;

export type CandidacyFacts = Readonly<{ stage: string; status: string }>;

type WorkType = Readonly<{
  title: string;
  instruction: string;
  actionLabel: string;
  routeKey: CandidateRouteKey;
  isEligible: (candidacy: CandidacyFacts) => boolean;
}>;

export const WORK_TYPE_REGISTRY_VERSION = "WORK-1";

export const workTypes: Readonly<Record<string, WorkType>> = Object.freeze({
  CORRECT_APPLICATION: {
    title: "Correct your application",
    instruction: "We asked you to change part of your application.",
    actionLabel: "See what to correct",
    routeKey: "APPLICATION_OVERVIEW",
    isEligible: (c: CandidacyFacts) =>
      c.status === "ACTIVE" && c.stage === "APPLICATION_INCOMPLETE",
  },
  COMPLETE_APPLICATION: {
    title: "Complete your application",
    instruction: "Answer each section. You can save and come back.",
    actionLabel: "Continue your application",
    routeKey: "APPLICATION_OVERVIEW",
    isEligible: (c: CandidacyFacts) =>
      c.status === "ACTIVE" && c.stage === "APPLICATION_INCOMPLETE",
  },
});

export const taskFilters = [
  "action_needed",
  "upcoming",
  "under_review",
  "completed",
] as const;
export type TaskFilter = (typeof taskFilters)[number];

export const parseTaskFilter = (value: unknown): TaskFilter | null =>
  value === undefined
    ? "action_needed"
    : (taskFilters.find((f) => f === value) ?? null);

export type WorkItemFacts = Readonly<{
  id: string;
  workTypeCode: string;
  status: string;
  priority: string;
  dueAt: Date | null;
  createdAt: Date;
}>;

/** Only a registered work type on an eligible target is actionable. */
export function isActionable(
  item: Pick<WorkItemFacts, "workTypeCode" | "status">,
  candidacy: CandidacyFacts,
): boolean {
  return (
    activeWorkItemStatuses.includes(item.status as WorkItemStatus) &&
    workTypes[item.workTypeCode]?.isEligible(candidacy) === true
  );
}

/**
 * A finished item is history, and a stale or unknown active one is hidden. A
 * completed application task on a submitted candidacy is under review.
 */
export function taskCategory(
  item: Pick<WorkItemFacts, "workTypeCode" | "status">,
  candidacy: CandidacyFacts,
): "action_needed" | "under_review" | "completed" | null {
  if (item.status === "COMPLETED" || item.status === "CANCELED") {
    if (!workTypes[item.workTypeCode]) return null;
    return item.status === "COMPLETED" &&
      candidacy.status === "ACTIVE" &&
      candidacy.stage === "APPLICATION_SUBMITTED"
      ? "under_review"
      : "completed";
  }
  return isActionable(item, candidacy) ? "action_needed" : null;
}

const time = (d: Date | null) => (d ? d.getTime() : Number.POSITIVE_INFINITY);

/** Priority, then nearest due date, oldest, and a stable ID. */
export function compareWorkItems(a: WorkItemFacts, b: WorkItemFacts): number {
  const rank = (p: string) => (p === "HIGH" ? 0 : 1);
  return (
    rank(a.priority) - rank(b.priority) ||
    time(a.dueAt) - time(b.dueAt) ||
    a.createdAt.getTime() - b.createdAt.getTime() ||
    a.id.localeCompare(b.id)
  );
}

export type NextAction = Readonly<{
  workTypeCode: string;
  dueAt: Date | null;
}>;

/**
 * One next action, or none. If the task row is missing, an eligible stage
 * still gets the same action, so a lagging backfill never hides it.
 */
export function resolveNextAction(
  candidacy: CandidacyFacts,
  items: readonly WorkItemFacts[],
): NextAction | null {
  const [first] = items
    .filter((item) => isActionable(item, candidacy))
    .sort(compareWorkItems);
  if (first) return { workTypeCode: first.workTypeCode, dueAt: first.dueAt };
  return workTypes.COMPLETE_APPLICATION!.isEligible(candidacy)
    ? { workTypeCode: "COMPLETE_APPLICATION", dueAt: null }
    : null;
}

// --------------------------------------------------- candidacy context

export type ContextCandidate = CandidacyFacts &
  Readonly<{
    publicId: string;
    updatedAt: Date;
    closedAt: Date | null;
    hasAction: boolean;
    nearestDue: Date | null;
  }>;

/**
 * Deterministic current candidacy (packet M2.3 §7.4): active needing action,
 * then nearest known due date, then most recently updated active, then most
 * recently closed, then the stable external ID.
 */
export function selectCurrentCandidacy<C extends ContextCandidate>(
  candidacies: readonly C[],
): C | null {
  const rank = (c: C) => (c.status !== "ACTIVE" ? 2 : c.hasAction ? 0 : 1);
  const recency = (c: C) =>
    (c.status === "ACTIVE"
      ? c.updatedAt
      : (c.closedAt ?? c.updatedAt)
    ).getTime();
  return (
    [...candidacies].sort(
      (a, b) =>
        rank(a) - rank(b) ||
        time(a.nearestDue) - time(b.nearestDue) ||
        recency(b) - recency(a) ||
        a.publicId.localeCompare(b.publicId),
    )[0] ?? null
  );
}

// ---------------------------------------------------------- navigation

export type NavigationEntry = Readonly<{
  key: string;
  label: string;
  href: string;
}>;

/**
 * Only implemented routes appear. Later modules add entries here when their
 * routes exist; nothing is shown disabled.
 */
export function candidateNavigation(
  currentCandidacyId: string | null,
): readonly NavigationEntry[] {
  return [
    { key: "home", label: "Home", href: "/candidate" },
    ...(currentCandidacyId
      ? [
          {
            key: "application",
            label: "Application",
            href: applicationRoutes.APPLICATION_OVERVIEW(currentCandidacyId),
          },
        ]
      : []),
    { key: "tasks", label: "My Tasks", href: "/candidate/tasks" },
    { key: "security", label: "Security", href: "/candidate/security" },
    { key: "help", label: "Help", href: "/candidate/help" },
  ];
}

// ------------------------------------------------------ workflow facts

/** The server-read state the workflow policy decides on. */
export const candidacyWorkflow = (
  row: Readonly<{ status: string; currentStage: string }>,
) =>
  ({
    policy: "CANDIDACY_WORKFLOW",
    state: row.status === "ACTIVE" ? row.currentStage : "CLOSED",
  }) as const;

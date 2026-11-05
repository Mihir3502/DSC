import { isCandidacyPublicId } from "./candidacy-policy";

// Staff work-queue rules (packet M3.1; UI_FLOW §9). Filters are closed lists
// parsed at the boundary: an unknown name, an unknown value, or a repeated
// parameter is refused rather than ignored. Wording is code-owned. A worker
// path here is only a proposal, never a classification decision (CLAUDE.md).

export const WORK_QUEUE_PAGE_SIZE = 25;

export const assignmentFilters = ["MINE", "TEAM", "UNASSIGNED"] as const;
export const stageFilters = [
  "PROSPECT",
  "APPLICATION_INCOMPLETE",
  "APPLICATION_SUBMITTED",
  "PRESCREEN_REVIEW",
  "INTERVIEW",
] as const;
export const dueFilters = ["OVERDUE", "TODAY", "NEXT_7", "NONE"] as const;
export const workerPathFilters = ["UNDECIDED", "W2", "CONTRACTOR"] as const;
export const exceptionFilters = ["RETURNED", "ON_HOLD"] as const;

export type AssignmentFilter = (typeof assignmentFilters)[number];
export type StageFilter = (typeof stageFilters)[number];
export type DueFilter = (typeof dueFilters)[number];
export type WorkerPathFilter = (typeof workerPathFilters)[number];
export type ExceptionFilter = (typeof exceptionFilters)[number];

export const assignmentLabels: Readonly<Record<AssignmentFilter, string>> = {
  MINE: "Assigned to me",
  TEAM: "My team",
  UNASSIGNED: "Unassigned",
};
export const stageLabels: Readonly<Record<StageFilter, string>> = {
  PROSPECT: "Prospect",
  APPLICATION_INCOMPLETE: "Application incomplete",
  APPLICATION_SUBMITTED: "Application submitted",
  PRESCREEN_REVIEW: "Prescreen review",
  INTERVIEW: "Interview",
};
export const dueLabels: Readonly<Record<DueFilter, string>> = {
  OVERDUE: "Overdue",
  TODAY: "Due today",
  NEXT_7: "Due in the next 7 days",
  NONE: "No due date",
};
export const workerPathLabels: Readonly<Record<WorkerPathFilter, string>> = {
  UNDECIDED: "Undecided",
  W2: "Proposed W-2",
  CONTRACTOR: "Proposed contractor",
};
export const exceptionLabels: Readonly<Record<ExceptionFilter, string>> = {
  RETURNED: "Returned for correction",
  ON_HOLD: "On hold",
};

export const ownerChangeReasons = [
  "WORKLOAD_BALANCE",
  "COVERAGE",
  "ROLE_CHANGE",
  "ASSIGNMENT_CORRECTION",
] as const;
export type OwnerChangeReason = (typeof ownerChangeReasons)[number];
export const ownerChangeReasonLabels: Readonly<
  Record<OwnerChangeReason, string>
> = {
  WORKLOAD_BALANCE: "Balancing workload",
  COVERAGE: "Covering for someone away",
  ROLE_CHANGE: "Staff role changed",
  ASSIGNMENT_CORRECTION: "Correcting an earlier assignment",
};
export const isOwnerChangeReason = (
  value: unknown,
): value is OwnerChangeReason =>
  (ownerChangeReasons as readonly unknown[]).includes(value);

export type WorkQueueCursor = Readonly<{
  /** Exact stored instants as text, so microseconds survive the round trip. */
  dueAt: string | null;
  createdAt: string;
  publicId: string;
}>;

export type WorkQueueFilters = Readonly<{
  assignment: AssignmentFilter | null;
  stage: StageFilter | null;
  due: DueFilter | null;
  branch: string | null;
  position: string | null;
  workerPath: WorkerPathFilter | null;
  exception: ExceptionFilter | null;
  cursor: WorkQueueCursor | null;
}>;

export const emptyWorkQueueFilters: WorkQueueFilters = Object.freeze({
  assignment: null,
  stage: null,
  due: null,
  branch: null,
  position: null,
  workerPath: null,
  exception: null,
  cursor: null,
});

const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const instant = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const allowedNames = new Set([
  "assignment",
  "stage",
  "due",
  "branch",
  "position",
  "workerPath",
  "exception",
  "after",
]);

export function encodeWorkQueueCursor(cursor: WorkQueueCursor): string {
  return [cursor.dueAt ?? "none", cursor.createdAt, cursor.publicId].join("~");
}

export function decodeWorkQueueCursor(value: string): WorkQueueCursor | null {
  if (value.length > 80) return null;
  const parts = value.split("~");
  if (parts.length !== 3) return null;
  const [dueAt, createdAt, publicId] = parts as [string, string, string];
  const validInstant = (v: string) =>
    instant.test(v) && !Number.isNaN(Date.parse(v));
  if (dueAt !== "none" && !validInstant(dueAt)) return null;
  if (!validInstant(createdAt) || !isCandidacyPublicId(publicId)) return null;
  return { dueAt: dueAt === "none" ? null : dueAt, createdAt, publicId };
}

function closed<T extends string>(
  list: readonly T[],
  value: string | undefined,
): T | null | "INVALID" {
  if (value === undefined || value === "") return null;
  return (list as readonly string[]).includes(value) ? (value as T) : "INVALID";
}

export type WorkQueueSearch = Readonly<
  Record<string, string | readonly string[] | undefined>
>;

/** Exact query parameters only. Never widens what the caller may see. */
export function parseWorkQueueFilters(
  search: WorkQueueSearch,
): WorkQueueFilters | null {
  const values: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(search)) {
    if (!allowedNames.has(name)) return null;
    if (value !== undefined && typeof value !== "string") return null;
    values[name] = value as string | undefined;
  }
  const assignment = closed(assignmentFilters, values.assignment);
  const stage = closed(stageFilters, values.stage);
  const due = closed(dueFilters, values.due);
  const workerPath = closed(workerPathFilters, values.workerPath);
  const exception = closed(exceptionFilters, values.exception);
  if (
    assignment === "INVALID" ||
    stage === "INVALID" ||
    due === "INVALID" ||
    workerPath === "INVALID" ||
    exception === "INVALID"
  ) {
    return null;
  }
  const id = (value: string | undefined) => {
    if (value === undefined || value === "") return null;
    return uuid.test(value) ? value : "INVALID";
  };
  const branch = id(values.branch);
  const position = id(values.position);
  if (branch === "INVALID" || position === "INVALID") return null;
  let cursor: WorkQueueCursor | null = null;
  if (values.after !== undefined && values.after !== "") {
    cursor = decodeWorkQueueCursor(values.after);
    if (!cursor) return null;
  }
  return {
    assignment,
    stage,
    due,
    branch,
    position,
    workerPath,
    exception,
    cursor,
  };
}

/** The same filters as a query string, for page links. Excludes the cursor. */
export function workQueueQuery(
  filters: WorkQueueFilters,
  after?: string,
): string {
  const query = new URLSearchParams();
  for (const name of [
    "assignment",
    "stage",
    "due",
    "branch",
    "position",
    "workerPath",
    "exception",
  ] as const) {
    const value = filters[name];
    if (value) query.set(name, value);
  }
  if (after) query.set("after", after);
  const text = query.toString();
  return text ? `?${text}` : "";
}

/** What staff do next. Only actions that exist today get wording. */
export function nextStaffAction(
  stage: string,
  returned: boolean,
  hasReviewItem: boolean,
): string {
  if (stage === "PRESCREEN_REVIEW") return "Complete the prescreen";
  if (stage === "PROSPECT")
    return "Start the application or close the prospect";
  if (stage === "APPLICATION_SUBMITTED") {
    return hasReviewItem
      ? "Accept the application for prescreen"
      : "None right now";
  }
  if (stage === "APPLICATION_INCOMPLETE") {
    return returned
      ? "Wait for the candidate's correction"
      : "Wait for the candidate to submit";
  }
  return "None right now";
}

const DAY = 86_400_000;

export const startOfUtcDay = (at: Date) =>
  new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));

/** The window a due filter covers, relative to the server's clock. */
export function dueWindow(
  filter: "TODAY" | "NEXT_7",
  now: Date,
): Readonly<{ from: Date; to: Date }> {
  const today = startOfUtcDay(now);
  return filter === "TODAY"
    ? { from: now, to: new Date(today.getTime() + DAY) }
    : { from: now, to: new Date(today.getTime() + 8 * DAY) };
}

export const MAX_DUE_DAYS_AHEAD = 365;

/**
 * A due date is a calendar day, and it runs to the end of that day in UTC.
 * Today through one year ahead; the past is refused, since it could only make
 * something overdue from the moment it was set. Null means clear.
 */
export function parseDueDate(
  value: unknown,
  now: Date,
): Readonly<{ ok: true; dueAt: Date | null }> | Readonly<{ ok: false }> {
  if (value === undefined || value === "") return { ok: true, dueAt: null };
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return { ok: false };
  }
  const start = new Date(`${value}T00:00:00.000Z`);
  if (
    Number.isNaN(start.getTime()) ||
    start.toISOString().slice(0, 10) !== value
  ) {
    return { ok: false };
  }
  const today = startOfUtcDay(now).getTime();
  if (start.getTime() < today) return { ok: false };
  if (start.getTime() > today + MAX_DUE_DAYS_AHEAD * DAY) return { ok: false };
  return { ok: true, dueAt: new Date(start.getTime() + DAY - 1) };
}

export const responsibilityChangeLabels: Readonly<Record<string, string>> = {
  OWNER_ASSIGNED: "Owner assigned",
  OWNER_REASSIGNED: "Owner changed",
  OWNER_RELEASED: "Owner removed",
  DUE_DATE_SET: "Due date set",
  DUE_DATE_CLEARED: "Due date cleared",
};

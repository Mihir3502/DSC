import { z } from "zod";
import {
  defineProjection,
  type FieldRule,
  type ProjectionContract,
} from "@/modules/identity-access";

// Exact projections for M2.2 (packet M2.2 §19). Candidate, staff
// prospect, duplicate-queue, and duplicate-review views are separate
// strict schemas: none can carry another audience's fields, and none
// carries internal IDs, account IDs, match signals for candidates, or
// another person's data. Every field requires the view's permission in
// the allowed set, otherwise the whole resource is refused.

export const candidateProjectionNames = [
  "candidate.application_start.v1",
  "candidate.portal_shell.v1",
  "candidate.portal_home.v1",
  "candidate.task_list.v1",
  "candidate.help.v1",
  "staff.prospect_form.v1",
  "staff.prospect_detail.v1",
  "staff.duplicate_queue.v1",
  "staff.submitted_queue.v1",
  "staff.duplicate_review.v1",
  "staff.shell.v1",
  "staff.dashboard.v1",
  "staff.work_queue.v1",
  "staff.work_item.v1",
  "staff.candidate_workspace.v1",
  "staff.candidate_overview.v1",
] as const;

const requires = (permission: string): FieldRule => ({
  sensitivity: "CONFIDENTIAL_PERSONNEL",
  includeWith: permission,
  otherwise: "DENY_RESOURCE",
});

function fieldsFor<S extends object>(
  keys: readonly (keyof S & string)[],
  permission: string,
) {
  return Object.fromEntries(
    keys.map((key) => [
      key,
      { rule: requires(permission), value: (s: S) => s[key] },
    ]),
  ) as unknown as ProjectionContract<S, S>["fields"];
}

const reference = z.string().regex(/^C-[0-9A-HJKMNP-TV-Z]{8}$/);
const publicId = z.string().regex(/^[0-9a-hjkmnp-tv-z]{12}$/);
const label = z.string().max(200);
const version = z.number().int().min(1);
const actions = z.array(z.string().regex(/^[a-z_]+$/)).max(10);

// ------------------------------------------------------------- candidate

const opening = z.strictObject({
  title: label,
  location: label,
  closes: label.nullable(),
});

const startSchema = z.strictObject({
  /** The opening named by the handoff, when it still accepts applications. */
  opening: opening.nullable(),
  /** True only when the candidate has no canonical person yet. */
  needsPersonDetails: z.boolean(),
  /** The candidate's own candidacy for this opening, or the latest one. */
  own: z
    .strictObject({
      candidacyId: publicId,
      reference,
      status: label,
      title: label,
    })
    .nullable(),
});
export type CandidateStartView = z.infer<typeof startSchema>;

export const candidateStartContract = defineProjection<
  CandidateStartView,
  CandidateStartView
>({
  name: "candidate.application_start.v1",
  audience: "CANDIDATE",
  purpose: "STATUS",
  fields: fieldsFor<CandidateStartView>(
    ["opening", "needsPersonDetails", "own"],
    "candidate.candidacy.read_own",
  ),
  schema: startSchema,
});

// ------------------------------------------------------ candidate portal

const navigationEntry = z.strictObject({
  key: z.string().regex(/^[a-z]+$/),
  label,
  href: z.string().regex(/^\/candidate(?:\/[a-z0-9-]+)*$/),
});
const candidatePath = z
  .string()
  .regex(/^\/candidate\/applications\/[0-9a-hjkmnp-tv-z]{12}$/);

const shellSchema = z.strictObject({
  displayName: label.nullable(),
  agencyName: label.nullable(),
  navigation: z.array(navigationEntry).max(12),
});
export type CandidateShellView = z.infer<typeof shellSchema>;
export const candidateShellContract = defineProjection<
  CandidateShellView,
  CandidateShellView
>({
  name: "candidate.portal_shell.v1",
  audience: "CANDIDATE",
  purpose: "STATUS",
  fields: fieldsFor<CandidateShellView>(
    ["displayName", "agencyName", "navigation"],
    "candidate.candidacy.read_own",
  ),
  schema: shellSchema,
});

const taskCounts = z.strictObject({
  actionNeeded: z.number().int().min(0),
  upcoming: z.number().int().min(0),
  underReview: z.number().int().min(0),
  completed: z.number().int().min(0),
});

const homeSchema = z.strictObject({
  current: z
    .strictObject({
      candidacyId: publicId,
      reference,
      title: label,
      location: label,
      status: z.strictObject({
        code: z.enum([
          "UNDER_REVIEW",
          "APPLICATION_IN_PROGRESS",
          "APPLICATION_SUBMITTED",
          "NOT_CONTINUING",
          "UNAVAILABLE",
        ]),
        label,
        explanation: label,
      }),
    })
    .nullable(),
  candidacies: z
    .array(
      z.strictObject({
        candidacyId: publicId,
        reference,
        title: label,
        location: label,
        status: label,
        selected: z.boolean(),
      }),
    )
    .max(50),
  nextAction: z
    .strictObject({
      title: label,
      instruction: label,
      actionLabel: label,
      href: candidatePath,
      due: label.nullable(),
    })
    .nullable(),
  taskCounts,
});
export type CandidateHomeView = z.infer<typeof homeSchema>;
export const candidateHomeContract = defineProjection<
  CandidateHomeView,
  CandidateHomeView
>({
  name: "candidate.portal_home.v1",
  audience: "CANDIDATE",
  purpose: "STATUS",
  fields: fieldsFor<CandidateHomeView>(
    ["current", "candidacies", "nextAction", "taskCounts"],
    "candidate.candidacy.read_own",
  ),
  schema: homeSchema,
});

const tasksSchema = z.strictObject({
  filter: z.enum(["action_needed", "upcoming", "under_review", "completed"]),
  tasks: z
    .array(
      z.strictObject({
        key: z.string().max(40),
        title: label,
        instruction: label.nullable(),
        status: label,
        due: label.nullable(),
        reference,
        opening: label,
        actionLabel: label.nullable(),
        href: candidatePath.nullable(),
      }),
    )
    .max(50),
  counts: taskCounts,
});
export type CandidateTasksView = z.infer<typeof tasksSchema>;
export const candidateTasksContract = defineProjection<
  CandidateTasksView,
  CandidateTasksView
>({
  name: "candidate.task_list.v1",
  audience: "CANDIDATE",
  purpose: "LIST",
  fields: fieldsFor<CandidateTasksView>(
    ["filter", "tasks", "counts"],
    "candidate.candidacy.read_own",
  ),
  schema: tasksSchema,
});

const helpSchema = z.strictObject({
  agencyName: label.nullable(),
  email: label.nullable(),
  phone: label.nullable(),
});
export type CandidateHelpView = z.infer<typeof helpSchema>;
export const candidateHelpContract = defineProjection<
  CandidateHelpView,
  CandidateHelpView
>({
  name: "candidate.help.v1",
  audience: "CANDIDATE",
  purpose: "DETAIL",
  fields: fieldsFor<CandidateHelpView>(
    ["agencyName", "email", "phone"],
    "candidate.candidacy.read_own",
  ),
  schema: helpSchema,
});

// ------------------------------------------------------------------ staff

const prospectFormSchema = z.strictObject({
  openings: z
    .array(
      z.strictObject({
        reference: publicId,
        title: label,
        location: label,
        closes: label.nullable(),
      }),
    )
    .max(100),
});
export type ProspectFormView = z.infer<typeof prospectFormSchema>;

export const prospectFormContract = defineProjection<
  ProspectFormView,
  ProspectFormView
>({
  name: "staff.prospect_form.v1",
  audience: "STAFF",
  purpose: "EDIT",
  fields: fieldsFor<ProspectFormView>(["openings"], "candidate.prospect.read"),
  schema: prospectFormSchema,
});

const prospectDetailSchema = z.strictObject({
  id: publicId,
  reference,
  displayName: label,
  email: z.string().max(254),
  phone: z.string().max(40).nullable(),
  opening: label,
  stage: z.enum([
    "Prospect",
    "Application incomplete",
    "Application submitted",
  ]),
  status: z.enum(["Active", "Closed"]),
  source: z.enum(["Candidate self-service", "Staff entered"]),
  owner: z.enum(["Unassigned", "You", "Another staff member"]),
  possibleDuplicate: z.boolean(),
  history: z
    .array(
      z.strictObject({
        stage: label,
        occurredAt: z.string().max(40),
        command: label,
      }),
    )
    .max(50),
  version,
  actions,
});
export type ProspectDetailView = z.infer<typeof prospectDetailSchema>;

export const prospectDetailContract = defineProjection<
  ProspectDetailView,
  ProspectDetailView
>({
  name: "staff.prospect_detail.v1",
  audience: "STAFF",
  purpose: "DETAIL",
  fields: fieldsFor<ProspectDetailView>(
    [
      "id",
      "reference",
      "displayName",
      "email",
      "phone",
      "opening",
      "stage",
      "status",
      "source",
      "owner",
      "possibleDuplicate",
      "history",
      "version",
      "actions",
    ],
    "candidate.prospect.read",
  ),
  schema: prospectDetailSchema,
});

const queueSchema = z.strictObject({
  cases: z
    .array(
      z.strictObject({
        id: publicId,
        tier: z.enum(["HIGH", "MEDIUM"]),
        status: z.enum(["Pending review", "Confirmed duplicate"]),
        created: z.string().max(40),
      }),
    )
    .max(50),
});
export type DuplicateQueueView = z.infer<typeof queueSchema>;

export const duplicateQueueContract = defineProjection<
  DuplicateQueueView,
  DuplicateQueueView
>({
  name: "staff.duplicate_queue.v1",
  audience: "STAFF",
  purpose: "LIST",
  fields: fieldsFor<DuplicateQueueView>(
    ["cases"],
    "candidate.duplicate.review",
  ),
  schema: queueSchema,
});

const side = z.strictObject({
  displayName: label,
  email: z.string().max(254),
  phone: z.string().max(40).nullable(),
  candidateAccountLinked: z.boolean(),
  candidacies: z
    .array(z.strictObject({ reference, stage: label, status: label }))
    .max(20),
});

const reviewSchema = z.strictObject({
  id: publicId,
  version,
  status: z.enum(["PENDING", "CONFIRMED_DUPLICATE", "NOT_DUPLICATE", "MERGED"]),
  tier: z.enum(["HIGH", "MEDIUM"]),
  signals: z.array(z.enum(["EXACT_EMAIL", "EXACT_PHONE"])).max(2),
  ruleset: z.string().max(16),
  first: side,
  second: side,
  /** Why a merge cannot proceed, when known before trying (no detail). */
  mergeBlocker: z
    .enum([
      "BLOCKED_TWO_CANDIDATE_ACCOUNTS",
      "BLOCKED_CURRENT_CANDIDACY_COLLISION",
      "BLOCKED_PERSON_NOT_ACTIVE",
    ])
    .nullable(),
  actions,
});
export type DuplicateReviewView = z.infer<typeof reviewSchema>;

export const duplicateReviewContract = defineProjection<
  DuplicateReviewView,
  DuplicateReviewView
>({
  name: "staff.duplicate_review.v1",
  audience: "STAFF",
  purpose: "REVIEW",
  fields: fieldsFor<DuplicateReviewView>(
    [
      "id",
      "version",
      "status",
      "tier",
      "signals",
      "ruleset",
      "first",
      "second",
      "mergeBlocker",
      "actions",
    ],
    "candidate.duplicate.review",
  ),
  schema: reviewSchema,
});

// ------------------------------------------------ submitted-application queue

const submittedQueueSchema = z.strictObject({
  items: z
    .array(
      z.strictObject({
        id: publicId,
        reference,
        opening: label,
        submitted: z.string().max(40),
      }),
    )
    .max(100),
});
export type SubmittedQueueView = z.infer<typeof submittedQueueSchema>;
export const submittedQueueContract = defineProjection<
  SubmittedQueueView,
  SubmittedQueueView
>({
  name: "staff.submitted_queue.v1",
  audience: "STAFF",
  purpose: "LIST",
  fields: fieldsFor<SubmittedQueueView>(["items"], "application.read"),
  schema: submittedQueueSchema,
});

// ------------------------------------------------------ M3.1 staff work queue
//
// Safe summary fields only: a reference, a display name, placement, and
// workflow labels. Never an email, phone, date of birth, answer, attachment,
// internal note, or account id. A worker path is a proposal label.

const QUEUE_PERMISSION = "candidate.work_queue.read";

const staffShellSchema = z.strictObject({
  navigation: z
    .array(
      z.strictObject({
        label: label,
        href: z.string().regex(/^\/staff(\/[a-z/-]+)?$/),
      }),
    )
    .max(6),
});
export type StaffShellView = z.infer<typeof staffShellSchema>;
export const staffShellContract = defineProjection<
  StaffShellView,
  StaffShellView
>({
  name: "staff.shell.v1",
  audience: "STAFF",
  purpose: "DETAIL",
  fields: fieldsFor<StaffShellView>(["navigation"], QUEUE_PERMISSION),
  schema: staffShellSchema,
});

const count = z.number().int().min(0);
const dashboardSchema = z.strictObject({
  myDueToday: count,
  overdue: count,
  unassignedSubmitted: count,
  returned: count,
});
export type StaffDashboardView = z.infer<typeof dashboardSchema>;
export const staffDashboardContract = defineProjection<
  StaffDashboardView,
  StaffDashboardView
>({
  name: "staff.dashboard.v1",
  audience: "STAFF",
  purpose: "DETAIL",
  fields: fieldsFor<StaffDashboardView>(
    ["myDueToday", "overdue", "unassignedSubmitted", "returned"],
    QUEUE_PERMISSION,
  ),
  schema: dashboardSchema,
});

const dayOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const filterOption = z.strictObject({ id: z.uuid(), label });
const workQueueSchema = z.strictObject({
  items: z
    .array(
      z.strictObject({
        id: publicId,
        reference,
        displayName: label,
        position: label,
        branch: label,
        stage: label,
        nextAction: label,
        owner: label,
        workerPath: label,
        returned: z.boolean(),
        dueDate: dayOnly.nullable(),
        overdue: z.boolean(),
        ageDays: count,
      }),
    )
    .max(25),
  total: count,
  nextCursor: z.string().max(80).nullable(),
  branches: z.array(filterOption).max(100),
  positions: z.array(filterOption).max(100),
  hasTeamScope: z.boolean(),
});
export type WorkQueueView = z.infer<typeof workQueueSchema>;
export const workQueueContract = defineProjection<WorkQueueView, WorkQueueView>(
  {
    name: "staff.work_queue.v1",
    audience: "STAFF",
    purpose: "LIST",
    fields: fieldsFor<WorkQueueView>(
      ["items", "total", "nextCursor", "branches", "positions", "hasTeamScope"],
      QUEUE_PERMISSION,
    ),
    schema: workQueueSchema,
  },
);

const workItemSchema = z.strictObject({
  id: publicId,
  reference,
  displayName: label,
  position: label,
  branch: label,
  stage: label,
  nextAction: label,
  owner: label,
  unassigned: z.boolean(),
  ownedByActor: z.boolean(),
  workerPath: label,
  returned: z.boolean(),
  version,
  hasApplication: z.boolean(),
  item: z
    .strictObject({
      version,
      dueDate: dayOnly.nullable(),
      overdue: z.boolean(),
    })
    .nullable(),
  actions: actions,
  eligibleOwners: z
    .array(z.strictObject({ id: z.uuid(), name: label }))
    .max(100),
  history: z
    .array(
      z.strictObject({
        change: label,
        reason: label.nullable(),
        by: label,
        when: z.string().max(40),
      }),
    )
    .max(20),
});
export type WorkItemView = z.infer<typeof workItemSchema>;
export const workItemContract = defineProjection<WorkItemView, WorkItemView>({
  name: "staff.work_item.v1",
  audience: "STAFF",
  purpose: "DETAIL",
  fields: fieldsFor<WorkItemView>(
    [
      "id",
      "reference",
      "displayName",
      "position",
      "branch",
      "stage",
      "nextAction",
      "owner",
      "unassigned",
      "ownedByActor",
      "workerPath",
      "returned",
      "version",
      "hasApplication",
      "item",
      "actions",
      "eligibleOwners",
      "history",
    ],
    QUEUE_PERMISSION,
  ),
  schema: workItemSchema,
});

// ------------------------------------------------- M3.2 candidate workspace
//
// Header and tabs, then the Overview's blockers and timeline. No contact
// details, answers, internal ids, or account ids. A tab holds a label and a
// link, never a count. A worker path is a proposal label, never a decision.

const WORKSPACE_PERMISSION = "candidate.read.assigned";

const candidateWorkspaceSchema = z.strictObject({
  id: publicId,
  reference,
  displayName: label,
  position: label,
  branch: label,
  stage: label,
  status: label,
  closed: z.boolean(),
  workerPath: label,
  owner: label,
  nextAction: label,
  dueDate: dayOnly.nullable(),
  hold: z.strictObject({ label }).nullable(),
  tabs: z
    .array(
      z.strictObject({
        key: z.enum(["overview", "application"]),
        label,
        href: z
          .string()
          .regex(/^\/staff\/candidates\/[0-9a-z]{12}(\/[a-z]+)?$/),
      }),
    )
    .min(1)
    .max(13),
});
export type CandidateWorkspaceView = z.infer<typeof candidateWorkspaceSchema>;
export const candidateWorkspaceContract = defineProjection<
  CandidateWorkspaceView,
  CandidateWorkspaceView
>({
  name: "staff.candidate_workspace.v1",
  audience: "STAFF",
  purpose: "DETAIL",
  fields: fieldsFor<CandidateWorkspaceView>(
    [
      "id",
      "reference",
      "displayName",
      "position",
      "branch",
      "stage",
      "status",
      "closed",
      "workerPath",
      "owner",
      "nextAction",
      "dueDate",
      "hold",
      "tabs",
    ],
    WORKSPACE_PERMISSION,
  ),
  schema: candidateWorkspaceSchema,
});

const candidateOverviewSchema = z.strictObject({
  blockers: z
    .array(z.strictObject({ code: z.string().regex(/^[A-Z_]+$/), label }))
    .max(5),
  timeline: z
    .array(
      z.strictObject({
        event: label,
        detail: label.nullable(),
        when: z.string().max(40),
      }),
    )
    .max(50),
  canManageWork: z.boolean(),
});
export type CandidateOverviewView = z.infer<typeof candidateOverviewSchema>;
export const candidateOverviewContract = defineProjection<
  CandidateOverviewView,
  CandidateOverviewView
>({
  name: "staff.candidate_overview.v1",
  audience: "STAFF",
  purpose: "DETAIL",
  fields: fieldsFor<CandidateOverviewView>(
    ["blockers", "timeline", "canManageWork"],
    WORKSPACE_PERMISSION,
  ),
  schema: candidateOverviewSchema,
});

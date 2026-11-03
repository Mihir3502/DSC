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
  "staff.prospect_form.v1",
  "staff.prospect_detail.v1",
  "staff.duplicate_queue.v1",
  "staff.duplicate_review.v1",
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
      reference,
      status: z.enum(["Not started", "Application started", "Closed"]),
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
  stage: z.enum(["Prospect", "Application incomplete"]),
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

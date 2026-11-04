import { z } from "zod";
import {
  defineProjection,
  type FieldRule,
  type ProjectionContract,
} from "@/modules/identity-access";

// Exact candidate projections for application drafts (packet M2.4 §8). They
// carry no internal IDs, stage or status codes, staff fields, or another
// person's data. Every field requires the view's permission, otherwise the
// whole resource is refused.

export const applicationProjectionNames = [
  "candidate.application_overview.v1",
  "candidate.application_section.v1",
  "candidate.application_review.v1",
  "candidate.application_receipt.v1",
  "staff.application_review.v1",
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

const code = z.string().regex(/^[a-z][a-z0-9_]{1,39}$/);
const publicId = z.string().regex(/^[0-9a-hjkmnp-tv-z]{12}$/);
const reference = z.string().regex(/^C-[0-9A-HJKMNP-TV-Z]{8}$/);
const label = z.string().max(300);
const sectionStatus = z.enum([
  "Not started",
  "In progress",
  "Complete",
  "Needs correction",
]);

/** What staff asked the candidate to change; plain text, encoded on render. */
const correction = z.strictObject({
  reason: label,
  instructions: z.string().max(1000),
});

const overviewSchema = z.strictObject({
  candidacyId: publicId,
  reference,
  title: label,
  location: label,
  status: label,
  /** False when no draft has been started yet. */
  started: z.boolean(),
  /** True once the application has been submitted. */
  submitted: z.boolean(),
  /** False once the application can no longer be edited. */
  editable: z.boolean(),
  sections: z
    .array(
      z.strictObject({
        code,
        title: label,
        description: label,
        status: sectionStatus,
        /** False when a correction didn't reopen this section. */
        editable: z.boolean(),
      }),
    )
    .max(20),
  correction: correction.nullable(),
  attachmentsEditable: z.boolean(),
  completeCount: z.number().int().min(0),
  lastSaved: label.nullable(),
});
export type ApplicationOverviewView = z.infer<typeof overviewSchema>;

export const applicationOverviewContract = defineProjection<
  ApplicationOverviewView,
  ApplicationOverviewView
>({
  name: "candidate.application_overview.v1",
  audience: "CANDIDATE",
  purpose: "STATUS",
  fields: fieldsFor<ApplicationOverviewView>(
    [
      "candidacyId",
      "reference",
      "title",
      "location",
      "status",
      "started",
      "submitted",
      "editable",
      "sections",
      "correction",
      "attachmentsEditable",
      "completeCount",
      "lastSaved",
    ],
    "candidate.candidacy.read_own",
  ),
  schema: overviewSchema,
});

const option = z.strictObject({ value: code, label });
const answer = z.union([z.string().max(2000), z.array(code).max(20)]);

const sectionSchema = z.strictObject({
  candidacyId: publicId,
  reference,
  code,
  title: label,
  description: label,
  status: sectionStatus,
  /** The optimistic version a save must name; 0 when never saved. */
  version: z.number().int().min(0),
  fields: z
    .array(
      z.strictObject({
        code,
        label,
        hint: label.nullable(),
        type: z.enum([
          "short_text",
          "long_text",
          "date",
          "email",
          "phone",
          "single_choice",
          "multi_choice",
        ]),
        required: z.boolean(),
        /** Staff asked the candidate to check this answer. */
        flagged: z.boolean(),
        options: z.array(option).max(20),
        value: answer.nullable(),
      }),
    )
    .max(30),
  lastSaved: label.nullable(),
  correction: correction.nullable(),
  previous: z.strictObject({ code, title: label }).nullable(),
  next: z.strictObject({ code, title: label }).nullable(),
});
export type ApplicationSectionView = z.infer<typeof sectionSchema>;

export const applicationSectionContract = defineProjection<
  ApplicationSectionView,
  ApplicationSectionView
>({
  name: "candidate.application_section.v1",
  audience: "CANDIDATE",
  purpose: "EDIT",
  fields: fieldsFor<ApplicationSectionView>(
    [
      "candidacyId",
      "reference",
      "code",
      "title",
      "description",
      "status",
      "version",
      "fields",
      "lastSaved",
      "correction",
      "previous",
      "next",
    ],
    "application.own.edit",
  ),
  schema: sectionSchema,
});

const reviewSchema = z.strictObject({
  candidacyId: publicId,
  reference,
  title: label,
  complete: z.boolean(),
  /** False once the position stops accepting applications. */
  accepting: z.boolean(),
  sections: z
    .array(
      z.strictObject({
        code,
        title: label,
        complete: z.boolean(),
        editable: z.boolean(),
        missing: z.array(label).max(30),
        answers: z
          .array(
            z.strictObject({
              label,
              value: z.string().max(4000),
            }),
          )
          .max(30),
      }),
    )
    .max(20),
  attachments: z
    .array(z.strictObject({ category: label, name: label, size: label }))
    .max(20),
  excludedAttachments: z
    .array(z.strictObject({ name: label, status: label }))
    .max(20),
  attachmentsEditable: z.boolean(),
  correction: correction.nullable(),
  certification: z.strictObject({
    version: z.number().int().min(1),
    statement: z.string().max(2000),
  }),
  /** Binds the submission to exactly what this page shows. */
  reviewToken: z.string().regex(/^[0-9a-f]{64}$/),
});
export type ApplicationReviewView = z.infer<typeof reviewSchema>;

export const applicationReviewContract = defineProjection<
  ApplicationReviewView,
  ApplicationReviewView
>({
  name: "candidate.application_review.v1",
  audience: "CANDIDATE",
  purpose: "REVIEW",
  fields: fieldsFor<ApplicationReviewView>(
    [
      "candidacyId",
      "reference",
      "title",
      "complete",
      "accepting",
      "sections",
      "attachments",
      "excludedAttachments",
      "attachmentsEditable",
      "correction",
      "certification",
      "reviewToken",
    ],
    "application.own.submit",
  ),
  schema: reviewSchema,
});

const receiptSchema = z.strictObject({
  candidacyId: publicId,
  reference,
  receiptNumber: z.string().regex(/^R-[0-9A-HJKMNP-TV-Z]{8}$/),
  title: label,
  submitted: label,
  certifiedName: label,
  certificationVersion: z.number().int().min(1),
  sectionCount: z.number().int().min(0),
  attachmentCount: z.number().int().min(0),
});
export type ApplicationReceiptView = z.infer<typeof receiptSchema>;

export const applicationReceiptContract = defineProjection<
  ApplicationReceiptView,
  ApplicationReceiptView
>({
  name: "candidate.application_receipt.v1",
  audience: "CANDIDATE",
  purpose: "STATUS",
  fields: fieldsFor<ApplicationReceiptView>(
    [
      "candidacyId",
      "reference",
      "receiptNumber",
      "title",
      "submitted",
      "certifiedName",
      "certificationVersion",
      "sectionCount",
      "attachmentCount",
    ],
    "candidate.candidacy.read_own",
  ),
  schema: receiptSchema,
});

// ------------------------------------------------------------------ staff

const staffReviewSchema = z.strictObject({
  candidacyId: publicId,
  reference,
  title: label,
  submitted: label,
  receiptNumber: z.string().regex(/^R-[0-9A-HJKMNP-TV-Z]{8}$/),
  certifiedName: label,
  certificationVersion: z.number().int().min(1),
  version: z.number().int().min(1),
  /** True once returned, until the candidate submits a correction. */
  awaitingCorrection: z.boolean(),
  /** True only when this staff member may return it now. */
  canReturn: z.boolean(),
  sections: z
    .array(
      z.strictObject({
        code,
        title: label,
        fields: z
          .array(
            z.strictObject({
              code,
              label,
              value: z.string().max(4000).nullable(),
            }),
          )
          .max(30),
      }),
    )
    .max(20),
  attachments: z
    .array(z.strictObject({ category: label, name: label, size: label }))
    .max(20),
  earlierReturns: z
    .array(
      z.strictObject({
        when: label,
        reason: label,
        instructions: z.string().max(1000),
      }),
    )
    .max(20),
});
export type StaffApplicationReviewView = z.infer<typeof staffReviewSchema>;

export const staffApplicationReviewContract = defineProjection<
  StaffApplicationReviewView,
  StaffApplicationReviewView
>({
  name: "staff.application_review.v1",
  audience: "STAFF",
  purpose: "REVIEW",
  fields: fieldsFor<StaffApplicationReviewView>(
    [
      "candidacyId",
      "reference",
      "title",
      "submitted",
      "receiptNumber",
      "certifiedName",
      "certificationVersion",
      "version",
      "awaitingCorrection",
      "canReturn",
      "sections",
      "attachments",
      "earlierReturns",
    ],
    "application.read",
  ),
  schema: staffReviewSchema,
});

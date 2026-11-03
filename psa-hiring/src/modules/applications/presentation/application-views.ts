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
const sectionStatus = z.enum(["Not started", "In progress", "Complete"]);

const overviewSchema = z.strictObject({
  candidacyId: publicId,
  reference,
  title: label,
  location: label,
  status: label,
  /** False when no draft has been started yet. */
  started: z.boolean(),
  /** False once the application can no longer be edited. */
  editable: z.boolean(),
  sections: z
    .array(
      z.strictObject({
        code,
        title: label,
        description: label,
        status: sectionStatus,
      }),
    )
    .max(20),
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
      "editable",
      "sections",
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
        options: z.array(option).max(20),
        value: answer.nullable(),
      }),
    )
    .max(30),
  lastSaved: label.nullable(),
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
      "previous",
      "next",
    ],
    "application.own.edit",
  ),
  schema: sectionSchema,
});

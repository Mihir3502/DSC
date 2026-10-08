import { z } from "zod";
import {
  defineProjection,
  type FieldRule,
  type ProjectionContract,
} from "@/modules/identity-access";

// Exact staff projections for organization configuration (packet M2.1
// §16, §23; ADR-0011). Every view is a strict object: unknown keys are
// rejected, and every field requires the resource's read permission in
// the set the M1 service allowed, otherwise the whole resource is
// refused. No account, assignment, scope reference, audit, or actor
// identity is ever part of a view. Internal IDs appear only where the
// staff screens need them to address a record they may already read.

export const organizationProjectionNames = [
  "staff.position_list.v1",
  "staff.position_detail.v1",
  "staff.position_form.v1",
  "staff.job_description_detail.v1",
  "staff.hiring_cycle_detail.v1",
  "staff.hiring_cycle_form.v1",
  "staff.organization_hierarchy.v1",
] as const;

const requires = (permission: string): FieldRule => ({
  sensitivity: "INTERNAL",
  includeWith: permission,
  otherwise: "DENY_RESOURCE",
});

/** Every key of the source is projected under one read permission. */
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

const uuid = z.uuid();
const code = z.string().regex(/^[A-Z0-9][A-Z0-9_-]{1,31}$/);
const text = z.string().max(8000);
const label = z.string().max(200);
const version = z.number().int().min(1);
const capabilities = z.array(z.string().regex(/^[a-z_]+$/)).max(20);

// ------------------------------------------------------------- positions

const positionSummary = z.strictObject({
  id: uuid,
  code,
  internalTitle: label,
  publicTitle: label,
  workerPaths: z.enum([
    "W2_ONLY",
    "CONTRACTOR_ELIGIBLE_ONLY",
    "W2_AND_CONTRACTOR_ELIGIBLE",
  ]),
  status: z.enum(["DRAFT", "ACTIVE", "INACTIVE", "RETIRED"]),
  version,
});
export type PositionSummaryView = z.infer<typeof positionSummary>;

const positionListSchema = z.strictObject({
  items: z.array(positionSummary).max(50),
  nextCursor: code.nullable(),
  canCreate: z.boolean(),
});
export type PositionListView = z.infer<typeof positionListSchema>;

export const positionListContract = defineProjection<
  PositionListView,
  PositionListView
>({
  name: "staff.position_list.v1",
  audience: "STAFF",
  purpose: "LIST",
  fields: fieldsFor<PositionListView>(
    ["items", "nextCursor", "canCreate"],
    "position.read",
  ),
  schema: positionListSchema,
});

const descriptionSummary = z.strictObject({
  id: uuid,
  versionNumber: version,
  publicTitle: label,
  status: z.enum(["DRAFT", "PUBLISHED", "SUPERSEDED", "RETIRED"]),
  publishedAt: z.string().nullable(),
});

const cycleSummary = z.strictObject({
  id: uuid,
  code,
  internalLabel: label,
  status: z.enum([
    "DRAFT",
    "PUBLISHED",
    "OPEN",
    "CLOSED",
    "CANCELLED",
    "ARCHIVED",
  ]),
  window: label,
  placement: label,
});

const positionDetailSchema = z.strictObject({
  position: positionSummary,
  organizationName: label,
  descriptions: z.array(descriptionSummary).max(100),
  cycles: z.array(cycleSummary).max(100),
  /** Permitted actions (UI hints; every command re-authorizes). */
  actions: capabilities,
});
export type PositionDetailView = z.infer<typeof positionDetailSchema>;

export const positionDetailContract = defineProjection<
  PositionDetailView,
  PositionDetailView
>({
  name: "staff.position_detail.v1",
  audience: "STAFF",
  purpose: "DETAIL",
  fields: fieldsFor<PositionDetailView>(
    ["position", "organizationName", "descriptions", "cycles", "actions"],
    "position.read",
  ),
  schema: positionDetailSchema,
});

const positionFormSchema = z.strictObject({
  organizations: z
    .array(z.strictObject({ id: uuid, code, name: label }))
    .max(50),
});
export type PositionFormView = z.infer<typeof positionFormSchema>;

export const positionFormContract = defineProjection<
  PositionFormView,
  PositionFormView
>({
  name: "staff.position_form.v1",
  audience: "STAFF",
  purpose: "EDIT",
  fields: fieldsFor<PositionFormView>(["organizations"], "position.create"),
  schema: positionFormSchema,
});

// ------------------------------------------------- job-description version

const descriptionDetailSchema = z.strictObject({
  id: uuid,
  positionId: uuid,
  positionTitle: label,
  versionNumber: version,
  publicTitle: label,
  summary: z.string().max(500),
  body: text,
  status: z.enum(["DRAFT", "PUBLISHED", "SUPERSEDED", "RETIRED"]),
  publishedAt: z.string().nullable(),
  version,
  actions: capabilities,
});
export type DescriptionDetailView = z.infer<typeof descriptionDetailSchema>;

export const descriptionDetailContract = defineProjection<
  DescriptionDetailView,
  DescriptionDetailView
>({
  name: "staff.job_description_detail.v1",
  audience: "STAFF",
  purpose: "DETAIL",
  fields: fieldsFor<DescriptionDetailView>(
    [
      "id",
      "positionId",
      "positionTitle",
      "versionNumber",
      "publicTitle",
      "summary",
      "body",
      "status",
      "publishedAt",
      "version",
      "actions",
    ],
    "job_description.read",
  ),
  schema: descriptionDetailSchema,
});

// ------------------------------------------------------------ hiring cycle

const cycleDetailSchema = z.strictObject({
  id: uuid,
  positionId: uuid,
  positionTitle: label,
  publicReference: z.string().regex(/^[0-9a-hjkmnp-tv-z]{12}$/),
  code,
  internalLabel: label,
  publicLabel: label.nullable(),
  status: z.enum([
    "DRAFT",
    "PUBLISHED",
    "OPEN",
    "CLOSED",
    "CANCELLED",
    "ARCHIVED",
  ]),
  branchName: label,
  teamName: label.nullable(),
  timezone: z.string().max(64),
  opensAt: label,
  closesAt: label.nullable(),
  /** datetime-local values for the draft edit form. */
  opensAtLocal: z.string().max(16),
  closesAtLocal: z.string().max(16).nullable(),
  openEnded: z.boolean(),
  snapshot: z
    .strictObject({
      descriptionVersion: version,
      publicTitle: label,
      locationLabel: label,
      workerPaths: label,
      publishedAt: label,
    })
    .nullable(),
  endReason: z.string().max(64).nullable(),
  version,
  actions: capabilities,
});
export type CycleDetailView = z.infer<typeof cycleDetailSchema>;

export const cycleDetailContract = defineProjection<
  CycleDetailView,
  CycleDetailView
>({
  name: "staff.hiring_cycle_detail.v1",
  audience: "STAFF",
  purpose: "DETAIL",
  fields: fieldsFor<CycleDetailView>(
    [
      "id",
      "positionId",
      "positionTitle",
      "publicReference",
      "code",
      "internalLabel",
      "publicLabel",
      "status",
      "branchName",
      "teamName",
      "timezone",
      "opensAt",
      "closesAt",
      "opensAtLocal",
      "closesAtLocal",
      "openEnded",
      "snapshot",
      "endReason",
      "version",
      "actions",
    ],
    "hiring_cycle.read",
  ),
  schema: cycleDetailSchema,
});

const cycleFormSchema = z.strictObject({
  positionId: uuid,
  positionTitle: label,
  branches: z
    .array(
      z.strictObject({
        id: uuid,
        code,
        name: label,
        timezone: z.string().max(64),
        teams: z
          .array(z.strictObject({ id: uuid, code, name: label }))
          .max(100),
      }),
    )
    .max(200),
});
export type CycleFormView = z.infer<typeof cycleFormSchema>;

export const cycleFormContract = defineProjection<CycleFormView, CycleFormView>(
  {
    name: "staff.hiring_cycle_form.v1",
    audience: "STAFF",
    purpose: "EDIT",
    fields: fieldsFor<CycleFormView>(
      ["positionId", "positionTitle", "branches"],
      "position.read",
    ),
    schema: cycleFormSchema,
  },
);

// --------------------------------------------------------------- hierarchy

const hierarchyEntity = z.strictObject({
  id: uuid,
  code,
  name: label,
  status: z.enum(["DRAFT", "ACTIVE", "INACTIVE", "ARCHIVED"]),
  version,
});

const hierarchySchema = z.strictObject({
  organizations: z
    .array(
      hierarchyEntity.extend({
        legalName: label,
        timezone: z.string().max(64),
        actions: capabilities,
        branches: z
          .array(
            hierarchyEntity.extend({
              publicLocationLabel: label,
              timezone: z.string().max(64),
              teams: z.array(hierarchyEntity).max(100),
            }),
          )
          .max(200),
      }),
    )
    .max(50),
});
export type HierarchyView = z.infer<typeof hierarchySchema>;

export const hierarchyContract = defineProjection<HierarchyView, HierarchyView>(
  {
    name: "staff.organization_hierarchy.v1",
    audience: "STAFF",
    purpose: "DETAIL",
    fields: fieldsFor<HierarchyView>(["organizations"], "organization.read"),
    schema: hierarchySchema,
  },
);

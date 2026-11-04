import { z } from "zod";
import {
  defineProjection,
  type FieldRule,
  type ProjectionContract,
} from "@/modules/identity-access";

// Exact candidate projection for attachments (packet M2.5 §8). It has no
// storage key, hash, internal ID, scanner code, or uploader.

export const documentProjectionNames = [
  "candidate.application_attachments.v1",
] as const;

const rule: FieldRule = {
  sensitivity: "CONFIDENTIAL_PERSONNEL",
  includeWith: "candidate.candidacy.read_own",
  otherwise: "DENY_RESOURCE",
};
const publicId = z.string().regex(/^[0-9a-hjkmnp-tv-z]{12}$/);
const label = z.string().max(200);

const attachmentsSchema = z.strictObject({
  candidacyId: publicId,
  editable: z.boolean(),
  atLimit: z.boolean(),
  attachments: z
    .array(
      z.strictObject({
        documentId: publicId,
        version: z.number().int().min(1),
        category: label,
        name: label,
        size: label,
        status: label,
        /** The latest upload didn't pass, so an earlier file may still apply. */
        problem: z.enum(["NOT_ACCEPTED", "NOT_CHECKED"]).nullable(),
        downloadable: z.boolean(),
      }),
    )
    .max(20),
});
export type ApplicationAttachmentsView = z.infer<typeof attachmentsSchema>;

const keys = ["candidacyId", "editable", "atLimit", "attachments"] as const;

export const applicationAttachmentsContract = defineProjection<
  ApplicationAttachmentsView,
  ApplicationAttachmentsView
>({
  name: "candidate.application_attachments.v1",
  audience: "CANDIDATE",
  purpose: "LIST",
  fields: Object.fromEntries(
    keys.map((key) => [
      key,
      { rule, value: (s: ApplicationAttachmentsView) => s[key] },
    ]),
  ) as unknown as ProjectionContract<
    ApplicationAttachmentsView,
    ApplicationAttachmentsView
  >["fields"],
  schema: attachmentsSchema,
});

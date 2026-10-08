import { z } from "zod";
import type { PublicAvailability } from "../domain/lifecycle";
import type { WorkerPaths } from "../domain/values";
import { formatInZone } from "../domain/zoned-time";

// Public position projections (packet M2.1 §17–§18; classification
// PUBLIC). Built only from a hiring cycle's published snapshot and the
// immutable description version it references. Exact strict schemas: no
// internal ID, code, internal label, status history, actor, scope, count,
// or configuration value can appear. Text is plain and is rendered only as
// escaped React text nodes (paragraphs and list items), never as HTML.

/** Approved public wording; contractor eligibility never classifies anyone. */
export const workerPathPublicText: Readonly<Record<WorkerPaths, string>> = {
  W2_ONLY: "W-2 employee position",
  CONTRACTOR_ELIGIBLE_ONLY:
    "May be offered as an independent contractor (1099) role after an approved worker-classification review",
  W2_AND_CONTRACTOR_ELIGIBLE:
    "W-2 employee position; an independent contractor (1099) arrangement may be considered after an approved worker-classification review",
};

export const workerPathFilterLabels: Readonly<Record<WorkerPaths, string>> = {
  W2_ONLY: "W-2 employee only",
  CONTRACTOR_ELIGIBLE_ONLY: "Contractor (1099) eligible only",
  W2_AND_CONTRACTOR_ELIGIBLE: "W-2 or contractor eligible",
};

export const classificationDisclaimer =
  "Contractor eligibility describes the position only. It does not decide how any individual is classified; W-2 employment is the default, and a 1099 arrangement requires a separate documented review and approval.";

const reference = z.string().regex(/^[0-9a-hjkmnp-tv-z]{12}$/);
const line = z.string().max(500);

const listItem = z.strictObject({
  reference,
  title: z.string().max(120),
  summary: z.string().max(500),
  location: z.string().max(120),
  workerPaths: z.string().max(200),
  closes: z.string().max(80).nullable(),
});
export type PublicPositionListItem = z.infer<typeof listItem>;

const acceptingDetail = z.strictObject({
  reference,
  title: z.string().max(120),
  summary: z.string().max(500),
  /** Plain-text blocks: a paragraph, or a list of bullet lines. */
  blocks: z
    .array(
      z.union([
        z.strictObject({
          kind: z.literal("paragraph"),
          text: z.string().max(8000),
        }),
        z.strictObject({
          kind: z.literal("list"),
          items: z.array(line).max(100),
        }),
      ]),
    )
    .max(200),
  location: z.string().max(120),
  workerPaths: z.string().max(200),
  disclaimer: z.string().max(400),
  availability: z.literal("ACCEPTING"),
  closes: z.string().max(80).nullable(),
});

/** A formerly open opening: one generic state, no content or reason. */
const closedDetail = z.strictObject({
  reference,
  availability: z.literal("NO_LONGER_ACCEPTING"),
});

const detail = z.discriminatedUnion("availability", [
  acceptingDetail,
  closedDetail,
]);
export type PublicPositionDetail = z.infer<typeof detail>;
export type AcceptingPositionDetail = z.infer<typeof acceptingDetail>;

export type PublicSource = Readonly<{
  publicReference: string;
  publicTitle: string;
  summary: string;
  body: string;
  locationLabel: string;
  workerPaths: WorkerPaths;
  closesAt: Date | null;
  displayTimezone: string;
}>;

const closesText = (source: PublicSource) =>
  source.closesAt
    ? `Applications close ${formatInZone(source.closesAt, source.displayTimezone)}`
    : null;

export function publicListItem(source: PublicSource): PublicPositionListItem {
  return listItem.parse({
    reference: source.publicReference,
    title: source.publicTitle,
    summary: source.summary,
    location: source.locationLabel,
    workerPaths: workerPathPublicText[source.workerPaths],
    closes: closesText(source),
  });
}

/** Lines starting with "- " or "* " form a list; blank lines split paragraphs. */
export function toBlocks(body: string): AcceptingPositionDetail["blocks"] {
  const blocks: AcceptingPositionDetail["blocks"] = [];
  for (const chunk of body.split(/\n\s*\n/)) {
    const lines = chunk
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    if (lines.length === 0) continue;
    if (lines.every((l) => /^[-*]\s+/.test(l))) {
      blocks.push({
        kind: "list",
        items: lines.map((l) => l.replace(/^[-*]\s+/, "").slice(0, 500)),
      });
    } else {
      blocks.push({ kind: "paragraph", text: lines.join(" ") });
    }
  }
  return blocks;
}

export function publicDetail(
  source: PublicSource,
  availability: Exclude<PublicAvailability, "NOT_PUBLIC">,
): PublicPositionDetail {
  if (availability === "NO_LONGER_ACCEPTING") {
    return detail.parse({
      reference: source.publicReference,
      availability,
    });
  }
  return detail.parse({
    reference: source.publicReference,
    title: source.publicTitle,
    summary: source.summary,
    blocks: toBlocks(source.body),
    location: source.locationLabel,
    workerPaths: workerPathPublicText[source.workerPaths],
    disclaimer: classificationDisclaimer,
    availability,
    closes: closesText(source),
  });
}

// Candidate workspace rules for staff (packet M3.2; UI_FLOW §10). Pure, closed,
// and code-owned. A tab carries a label and a link, and never a count. Blockers
// are only facts already stored. Requirement sets and compliance results don't
// exist yet, so nothing here may read as a compliance clearance.

export type WorkspaceTab = Readonly<{
  key: "overview" | "application" | "prescreen";
  label: string;
  href: string;
}>;

export function workspaceTabs(
  publicId: string,
  facts: Readonly<{
    canReadApplication: boolean;
    canReadPrescreen?: boolean;
    everSubmitted: boolean;
  }>,
): readonly WorkspaceTab[] {
  const base = `/staff/candidates/${publicId}`;
  const tabs: WorkspaceTab[] = [
    { key: "overview", label: "Overview", href: base },
  ];
  if (facts.canReadApplication && facts.everSubmitted) {
    tabs.push({
      key: "application",
      label: "Application",
      href: `${base}/application`,
    });
  }
  if (facts.canReadPrescreen && facts.everSubmitted) {
    tabs.push({
      key: "prescreen",
      label: "Prescreen",
      href: `${base}/recruiting/prescreen`,
    });
  }
  return tabs;
}

export const blockerLabels = {
  RETURNED_FOR_CORRECTION: "Returned for correction: waiting for the candidate",
  WAITING_FOR_SUBMISSION: "Waiting for the candidate to submit the application",
  STAFF_WORK_OVERDUE: "Staff work is overdue",
  NO_OWNER: "Nobody owns this record",
  POSSIBLE_DUPLICATE: "A possible duplicate is under review",
  ON_HOLD: "This candidate is on hold",
} as const;
export type BlockerCode = keyof typeof blockerLabels;

export const NO_BLOCKERS_MESSAGE =
  "Nothing is holding this record up right now. Compliance requirements aren't tracked here yet.";

export function deriveBlockers(
  facts: Readonly<{
    stage: string;
    status: string;
    returned: boolean;
    overdue: boolean;
    unassigned: boolean;
    possibleDuplicate: boolean;
    onHold?: boolean;
  }>,
): readonly BlockerCode[] {
  if (facts.status !== "ACTIVE") return [];
  const blockers: BlockerCode[] = [];
  if (facts.onHold) blockers.push("ON_HOLD");
  if (facts.returned) blockers.push("RETURNED_FOR_CORRECTION");
  else if (facts.stage === "APPLICATION_INCOMPLETE") {
    blockers.push("WAITING_FOR_SUBMISSION");
  }
  if (facts.overdue) blockers.push("STAFF_WORK_OVERDUE");
  if (facts.unassigned) blockers.push("NO_OWNER");
  if (facts.possibleDuplicate) blockers.push("POSSIBLE_DUPLICATE");
  return blockers;
}

export const stageEventLabels: Readonly<Record<string, string>> = {
  create_prospect: "Prospect created",
  start_application: "Application started",
  start_application_from_prospect: "Application started by staff",
  close_prospect: "Prospect closed",
  submit_application: "Application submitted",
  return_application: "Returned for correction",
  accept_for_prescreen: "Accepted for prescreen",
  pass_prescreen: "Prescreen passed",
  not_select_prescreen: "Not selected",
};

/** Newest first; ties keep the given order, so the result is stable. */
export function mergeTimeline<T extends Readonly<{ occurredAt: Date }>>(
  groups: readonly (readonly T[])[],
  limit: number,
): readonly T[] {
  return groups
    .flat()
    .map((entry, index) => ({ entry, index }))
    .sort(
      (a, b) =>
        b.entry.occurredAt.getTime() - a.entry.occurredAt.getTime() ||
        a.index - b.index,
    )
    .slice(0, limit)
    .map(({ entry }) => entry);
}

/** The header's hold slot. Holds can't exist until a later work item adds them. */
export type HoldIndicator = Readonly<{ label: string }>;

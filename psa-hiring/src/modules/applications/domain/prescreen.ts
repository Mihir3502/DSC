// Prescreen rules (packet M3.3; HIRING_WORKFLOW §5.4). The checklist comes from
// a stored version, and version 1 is a neutral draft for business review. Reason
// wording is draft and staff-only: candidates see only their generic status.

export const prescreenResults = ["MET", "NOT_MET", "NOT_APPLICABLE"] as const;
export type PrescreenResult = (typeof prescreenResults)[number];
export const prescreenResultLabels: Readonly<Record<PrescreenResult, string>> =
  {
    MET: "Met",
    NOT_MET: "Not met",
    NOT_APPLICABLE: "Not applicable",
  };

export type ChecklistItem = Readonly<{ code: string; label: string }>;

export const notSelectedReasons = [
  "AVAILABILITY_DOES_NOT_FIT",
  "EXPERIENCE_DOES_NOT_FIT",
  "UNABLE_TO_REACH",
  "POSITION_FILLED",
  "OTHER_BUSINESS_REASON",
] as const;
export const notSelectedReasonLabels: Readonly<
  Record<(typeof notSelectedReasons)[number], string>
> = {
  AVAILABILITY_DOES_NOT_FIT: "Availability doesn't fit this opening",
  EXPERIENCE_DOES_NOT_FIT: "Experience doesn't fit this opening",
  UNABLE_TO_REACH: "Unable to reach the candidate",
  POSITION_FILLED: "Position filled",
  OTHER_BUSINESS_REASON: "Other business reason",
};
export const isNotSelectedReason = (value: unknown) =>
  (notSelectedReasons as readonly unknown[]).includes(value);

export const exceptionReasons = [
  "EQUIVALENT_EXPERIENCE",
  "AVAILABILITY_ARRANGED",
  "DOCUMENTED_MANAGER_JUDGMENT",
] as const;
export const exceptionReasonLabels: Readonly<
  Record<(typeof exceptionReasons)[number], string>
> = {
  EQUIVALENT_EXPERIENCE: "Equivalent experience",
  AVAILABILITY_ARRANGED: "Availability arranged",
  DOCUMENTED_MANAGER_JUDGMENT: "Documented manager judgment",
};
export const isExceptionReason = (value: unknown) =>
  (exceptionReasons as readonly unknown[]).includes(value);

export const MAX_PRESCREEN_NOTES = 2000;

export function parseChecklistItems(value: unknown): readonly ChecklistItem[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is ChecklistItem =>
      typeof item?.code === "string" && typeof item?.label === "string",
  );
}

/** Exactly the checklist's items, each with a known result; or null. */
export function parseResponses(
  items: readonly ChecklistItem[],
  raw: unknown,
): Readonly<Record<string, PrescreenResult>> | null {
  if (typeof raw !== "string" || raw.length > 4000) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const entries = Object.entries(parsed);
  const known = new Set(items.map((i) => i.code));
  const result: Record<string, PrescreenResult> = {};
  for (const [code, value] of entries) {
    if (
      !known.has(code) ||
      !(prescreenResults as readonly unknown[]).includes(value)
    ) {
      return null;
    }
    result[code] = value as PrescreenResult;
  }
  return result;
}

/** Trimmed and bounded, with no control characters other than line breaks. */
export function normalizeNotes(
  value: unknown,
): Readonly<{ ok: true; notes: string | null }> | Readonly<{ ok: false }> {
  if (value === undefined || value === "") return { ok: true, notes: null };
  if (typeof value !== "string") return { ok: false };
  const text = value.trim();
  if (text.length > MAX_PRESCREEN_NOTES) return { ok: false };
  if (/[\u0000-\u0009\u000b\u000c\u000e-\u001f\u007f]/.test(text)) {
    return { ok: false };
  }
  return { ok: true, notes: text || null };
}

export type PrescreenFacts = Readonly<{
  items: readonly ChecklistItem[];
  responses: Readonly<Record<string, unknown>>;
  responsesVersion: number;
  exceptionResponsesVersion: number | null;
}>;

export const allAnswered = (f: PrescreenFacts) =>
  f.items.length > 0 && f.items.every((i) => f.responses[i.code] !== undefined);

export const hasUnmet = (f: PrescreenFacts) =>
  f.items.some((i) => f.responses[i.code] === "NOT_MET");

/** An exception counts only for the exact answers it was approved on. */
export const exceptionIsCurrent = (f: PrescreenFacts) =>
  f.exceptionResponsesVersion !== null &&
  f.exceptionResponsesVersion === f.responsesVersion;

/** Why this can't pass yet, or null when it can (HIRING_WORKFLOW §5.4). */
export function passBlocker(
  f: PrescreenFacts,
): "PRESCREEN_INCOMPLETE" | "EXCEPTION_REQUIRED" | null {
  if (!allAnswered(f)) return "PRESCREEN_INCOMPLETE";
  if (hasUnmet(f) && !exceptionIsCurrent(f)) return "EXCEPTION_REQUIRED";
  return null;
}

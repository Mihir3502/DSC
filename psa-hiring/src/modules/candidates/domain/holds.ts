// Hold categories (packet M3.3; HIRING_WORKFLOW §6.5). Draft wording for business
// review, for staff only. Candidates don't see holds yet, because no candidate
// message has been approved.

export const holdCategories = [
  "WAITING_ON_CANDIDATE_CONTACT",
  "POSITION_UNDER_REVIEW",
  "INTERNAL_REVIEW",
] as const;
export type HoldCategory = (typeof holdCategories)[number];

export const holdCategoryLabels: Readonly<Record<HoldCategory, string>> = {
  WAITING_ON_CANDIDATE_CONTACT: "Waiting to reach the candidate",
  POSITION_UNDER_REVIEW: "Position under review",
  INTERNAL_REVIEW: "Internal review",
};

export const isHoldCategory = (value: unknown): value is HoldCategory =>
  (holdCategories as readonly unknown[]).includes(value);

export const holdRemovalReasons = ["RESOLVED", "PLACED_IN_ERROR"] as const;
export const isHoldRemovalReason = (
  value: unknown,
): value is (typeof holdRemovalReasons)[number] =>
  (holdRemovalReasons as readonly unknown[]).includes(value);

export const MAX_HOLD_REASON = 1000;
const DAY = 86_400_000;
const MAX_REVIEW_DAYS = 180;

/** A required review date: today through 180 days ahead, end of that UTC day. */
export function parseHoldReviewDate(value: unknown, now: Date): Date | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return null;
  }
  const start = new Date(`${value}T00:00:00.000Z`);
  if (
    Number.isNaN(start.getTime()) ||
    start.toISOString().slice(0, 10) !== value
  ) {
    return null;
  }
  const today = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
  );
  if (
    start.getTime() < today ||
    start.getTime() > today + MAX_REVIEW_DAYS * DAY
  ) {
    return null;
  }
  return new Date(start.getTime() + DAY - 1);
}

/** Trimmed, bounded, and without control characters other than line breaks. */
export function normalizeHoldReason(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (text.length === 0 || text.length > MAX_HOLD_REASON) return null;
  if (/[\u0000-\u0009\u000b\u000c\u000e-\u001f\u007f]/.test(text)) return null;
  return text;
}

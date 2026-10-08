// Display labels for M2.1 configuration screens. Pure and closed: every
// status is shown as text (never color alone), and reason options are the
// server's closed reason codes with plain-language labels.

export const statusLabels: Readonly<Record<string, string>> = {
  DRAFT: "Draft (not public, editable)",
  ACTIVE: "Active",
  INACTIVE: "Inactive",
  ARCHIVED: "Archived",
  RETIRED: "Retired (cannot be reactivated)",
  PUBLISHED: "Published (content frozen)",
  SUPERSEDED: "Superseded (kept as history)",
  OPEN: "Open (accepting applications during its window)",
  CLOSED: "Closed (no longer accepting)",
  CANCELLED: "Cancelled",
};

export const workerPathOptions = [
  { value: "W2_ONLY", label: "W-2 employee only" },
  {
    value: "CONTRACTOR_ELIGIBLE_ONLY",
    label: "Eligible for a reviewed 1099 contractor path only",
  },
  {
    value: "W2_AND_CONTRACTOR_ELIGIBLE",
    label: "W-2 employee, or eligible for a reviewed 1099 contractor path",
  },
] as const;

export const workerPathHint =
  "Describes what this position may support. It never classifies a person: W-2 is the default, and any 1099 path needs a separate approved classification review.";

export const changeReasonOptions = [
  { value: "ROUTINE_CONFIGURATION", label: "Routine configuration" },
  { value: "CORRECTION", label: "Correction" },
  { value: "BUSINESS_CHANGE", label: "Business change" },
] as const;

export const closeReasonOptions = [
  { value: "POSITIONS_FILLED", label: "Positions filled" },
  { value: "NO_LONGER_NEEDED", label: "No longer needed" },
  { value: "WINDOW_COMPLETE", label: "Application window complete" },
] as const;

export const cancelReasonOptions = [
  { value: "PUBLISHED_IN_ERROR", label: "Published in error" },
  { value: "NO_LONGER_NEEDED", label: "No longer needed" },
  { value: "POSITION_CHANGED", label: "Position changed materially" },
] as const;

export const timezoneHint =
  "An IANA timezone name, for example America/New_York or America/Chicago.";

export const codeHint =
  "2–32 letters, numbers, hyphens, or underscores. Stored in capitals; it cannot change after activation.";

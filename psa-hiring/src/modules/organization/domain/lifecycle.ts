import type {
  CycleStatus,
  DescriptionStatus,
  HierarchyStatus,
  PositionStatus,
} from "./values";

// Named lifecycle transitions (packet M2.1 §7.2, §8, §10.3, §11.3,
// §12.3–§12.4). Pure: every function answers from trusted stored state
// and a trusted clock. Callers never pass a target status; they name a
// command, and the command's transition table decides.

/** Closed refusal codes shared by every configuration command. */
export const configurationRefusals = [
  "UNAUTHENTICATED",
  "NOT_AUTHORIZED",
  "REAUTHENTICATION_REQUIRED",
  "INVALID_INPUT",
  "NOT_FOUND",
  "STALE_VERSION",
  "INVALID_TRANSITION",
  "PARENT_NOT_ACTIVE",
  "DUPLICATE_CODE",
  "DESCRIPTION_NOT_PUBLISHED",
  "WINDOW_INVALID",
  "WINDOW_NOT_OPEN",
  "COMMAND_KEY_CONFLICT",
] as const;
export type ConfigurationRefusal = (typeof configurationRefusals)[number];

// ------------------------------------------------ organization/branch/team

export type HierarchyCommand = "activate" | "inactivate";

const hierarchyTransitions: Readonly<
  Record<
    HierarchyCommand,
    Readonly<Partial<Record<HierarchyStatus, HierarchyStatus>>>
  >
> = {
  activate: { DRAFT: "ACTIVE", INACTIVE: "ACTIVE" },
  inactivate: { ACTIVE: "INACTIVE" },
};

export function hierarchyTransition(
  command: HierarchyCommand,
  from: HierarchyStatus,
): HierarchyStatus | null {
  return hierarchyTransitions[command][from] ?? null;
}

/** Ordinary edits: never on archived rows; codes only while DRAFT. */
export function hierarchyEditable(status: HierarchyStatus): boolean {
  return status !== "ARCHIVED";
}

// ---------------------------------------------------------------- position

export type PositionCommand = "activate" | "inactivate" | "retire";

const positionTransitions: Readonly<
  Record<
    PositionCommand,
    Readonly<Partial<Record<PositionStatus, PositionStatus>>>
  >
> = {
  activate: { DRAFT: "ACTIVE", INACTIVE: "ACTIVE" },
  inactivate: { ACTIVE: "INACTIVE" },
  retire: { DRAFT: "RETIRED", ACTIVE: "RETIRED", INACTIVE: "RETIRED" },
};

export function positionTransition(
  command: PositionCommand,
  from: PositionStatus,
): PositionStatus | null {
  return positionTransitions[command][from] ?? null;
}

export function positionEditable(status: PositionStatus): boolean {
  return status !== "RETIRED";
}

// ------------------------------------------------- job-description version

/** Only drafts are edited or published; published content is immutable. */
export function descriptionEditable(status: DescriptionStatus): boolean {
  return status === "DRAFT";
}

// ------------------------------------------------------------ hiring cycle

export type CycleCommand = "publish" | "open" | "close" | "cancel" | "archive";

const cycleTransitions: Readonly<
  Record<CycleCommand, Readonly<Partial<Record<CycleStatus, CycleStatus>>>>
> = {
  publish: { DRAFT: "PUBLISHED" },
  open: { PUBLISHED: "OPEN" },
  close: { OPEN: "CLOSED", PUBLISHED: "CLOSED" },
  cancel: { DRAFT: "CANCELLED", PUBLISHED: "CANCELLED", OPEN: "CANCELLED" },
  archive: { CLOSED: "ARCHIVED", CANCELLED: "ARCHIVED" },
};

export function cycleTransition(
  command: CycleCommand,
  from: CycleStatus,
): CycleStatus | null {
  return cycleTransitions[command][from] ?? null;
}

export function cycleEditable(status: CycleStatus): boolean {
  return status === "DRAFT";
}

/** Closed close/cancel reason codes (never free text). */
export const closeReasons = [
  "POSITIONS_FILLED",
  "NO_LONGER_NEEDED",
  "WINDOW_COMPLETE",
] as const;
export const cancelReasons = [
  "PUBLISHED_IN_ERROR",
  "NO_LONGER_NEEDED",
  "POSITION_CHANGED",
] as const;
/** Reason codes for other approval-level configuration commands. */
export const changeReasons = [
  "ROUTINE_CONFIGURATION",
  "CORRECTION",
  "BUSINESS_CHANGE",
] as const;

export type CloseReason = (typeof closeReasons)[number];
export type CancelReason = (typeof cancelReasons)[number];
export type ChangeReason = (typeof changeReasons)[number];

export function isMember<T extends string>(
  list: readonly T[],
  value: unknown,
): value is T {
  return (
    typeof value === "string" && (list as readonly string[]).includes(value)
  );
}

// ---------------------------------------------------------- the window

export type CycleWindow = Readonly<{
  opensAt: Date;
  closesAt: Date | null;
  openEnded: boolean;
}>;

/** A coherent window: closes strictly after opens, or explicitly open-ended. */
export function windowCoherent(window: CycleWindow): boolean {
  if (Number.isNaN(window.opensAt.getTime())) return false;
  if (window.openEnded) return window.closesAt === null;
  return (
    window.closesAt !== null &&
    !Number.isNaN(window.closesAt.getTime()) &&
    window.closesAt.getTime() > window.opensAt.getTime()
  );
}

/** Inclusive opens-at, exclusive closes-at, evaluated at a trusted instant. */
export function withinWindow(window: CycleWindow, now: Date): boolean {
  const t = now.getTime();
  return (
    window.opensAt.getTime() <= t &&
    (window.closesAt === null || t < window.closesAt.getTime())
  );
}

// ------------------------------------------------ effective availability

export type PublicAvailability =
  /** Draft, published-not-open, cancelled, archived, never-opened, unknown. */
  | "NOT_PUBLIC"
  | "ACCEPTING"
  /** Formerly public: show one generic no-longer-accepting state. */
  | "NO_LONGER_ACCEPTING";

export type AvailabilityFacts = CycleWindow &
  Readonly<{
    status: CycleStatus;
    /** Was the cycle ever opened to the public? */
    everOpened: boolean;
    /** Organization, branch, optional team, and position all ACTIVE. */
    parentsActive: boolean;
  }>;

/**
 * Public availability from trusted stored state and the server clock. At
 * exactly `closesAt` the cycle stops accepting even when no close command
 * has run yet; upcoming (published, not yet open) display is not approved.
 */
export function effectiveAvailability(
  facts: AvailabilityFacts,
  now: Date,
): PublicAvailability {
  switch (facts.status) {
    case "OPEN":
      if (!facts.parentsActive) return "NO_LONGER_ACCEPTING";
      if (
        facts.closesAt !== null &&
        now.getTime() >= facts.closesAt.getTime()
      ) {
        return "NO_LONGER_ACCEPTING";
      }
      return now.getTime() >= facts.opensAt.getTime()
        ? "ACCEPTING"
        : "NOT_PUBLIC";
    case "CLOSED":
      return facts.everOpened ? "NO_LONGER_ACCEPTING" : "NOT_PUBLIC";
    default:
      return "NOT_PUBLIC";
  }
}

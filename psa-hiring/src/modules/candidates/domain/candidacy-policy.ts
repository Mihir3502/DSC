// Person, candidacy, duplicate, and merge rules (packet M2.2 §7–§15;
// DATA_MODEL §6). Pure: every function decides from trusted stored state.

// ------------------------------------------------------------ references

export const referenceAlphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
/** Human support reference: "C-" + 8 Crockford base32 characters. */
export const candidateReferencePattern = /^C-[0-9A-HJKMNP-TV-Z]{8}$/;
/** Route identifier for a candidacy (never the internal UUID). */
export const candidacyPublicIdPattern = /^[0-9a-hjkmnp-tv-z]{12}$/;
export const matchPublicIdPattern = candidacyPublicIdPattern;

export function isCandidacyPublicId(value: unknown): value is string {
  return typeof value === "string" && candidacyPublicIdPattern.test(value);
}

// --------------------------------------------------------------- catalogs

export const candidacySources = [
  "CANDIDATE_SELF_SERVICE",
  "STAFF_ENTERED",
] as const;
export type CandidacySource = (typeof candidacySources)[number];

export const candidacyStages = ["PROSPECT", "APPLICATION_INCOMPLETE"] as const;
export type CandidacyStage = (typeof candidacyStages)[number];

export const candidacyStatuses = ["ACTIVE", "TERMINAL", "ARCHIVED"] as const;
export type CandidacyStatus = (typeof candidacyStatuses)[number];

export const personStatuses = ["ACTIVE", "MERGED", "ARCHIVED"] as const;
export type PersonStatus = (typeof personStatuses)[number];

export const prospectCloseReasons = [
  "NOT_INTERESTED",
  "UNREACHABLE",
  "DUPLICATE_RECORD",
  "NOT_QUALIFIED",
] as const;
export const ownerAssignReasons = [
  "INITIAL_ASSIGNMENT",
  "WORKLOAD_BALANCE",
  "COVERAGE",
] as const;
export const reviewReasons = [
  "SAME_PERSON_CONFIRMED",
  "DIFFERENT_PEOPLE_CONFIRMED",
  "INSUFFICIENT_EVIDENCE",
] as const;
export const mergeReasons = ["CONFIRMED_DUPLICATE_RECORD"] as const;

export function isMember<T extends string>(
  list: readonly T[],
  value: unknown,
): value is T {
  return (
    typeof value === "string" && (list as readonly string[]).includes(value)
  );
}

/** Proposed worker path; W-2 remains the default once classification starts. */
export const proposedWorkerPaths = ["UNDECIDED", "W2", "CONTRACTOR"] as const;

// -------------------------------------------------- stages and visible status

export type StageCommand =
  | "create_prospect"
  | "start_application"
  | "start_application_from_prospect"
  | "close_prospect";

/** The named transition table; anything else is refused. */
export function stageTransition(
  command: StageCommand,
  from: Readonly<{ stage: CandidacyStage; status: CandidacyStatus }> | null,
): Readonly<{ stage: CandidacyStage; status: CandidacyStatus }> | null {
  switch (command) {
    case "create_prospect":
      return from === null ? { stage: "PROSPECT", status: "ACTIVE" } : null;
    case "start_application":
      return from === null
        ? { stage: "APPLICATION_INCOMPLETE", status: "ACTIVE" }
        : null;
    case "start_application_from_prospect":
      return from?.stage === "PROSPECT" && from.status === "ACTIVE"
        ? { stage: "APPLICATION_INCOMPLETE", status: "ACTIVE" }
        : null;
    case "close_prospect":
      return from?.stage === "PROSPECT" && from.status === "ACTIVE"
        ? { stage: "PROSPECT", status: "TERMINAL" }
        : null;
  }
}

/** Plain-language candidate status, mapped separately from internal stage. */
export function candidateVisibleStatus(
  stage: CandidacyStage,
  status: CandidacyStatus,
): "NOT_STARTED" | "APPLICATION_STARTED" | "CLOSED" {
  if (status !== "ACTIVE") return "CLOSED";
  return stage === "APPLICATION_INCOMPLETE"
    ? "APPLICATION_STARTED"
    : "NOT_STARTED";
}

// ---------------------------------------------------- duplicate rules DUP-1

export const DUPLICATE_RULESET = "DUP-1";
export const duplicateSignals = ["EXACT_EMAIL", "EXACT_PHONE"] as const;
export type DuplicateSignal = (typeof duplicateSignals)[number];
export type ConfidenceTier = "HIGH" | "MEDIUM";

export type ComparisonValues = Readonly<{
  emailNormalized: string;
  phoneE164: string | null;
}>;

/**
 * DUP-1: exact normalized email → HIGH; exact E.164 phone → MEDIUM. Names,
 * partial values, and any other attribute never produce a signal. The
 * result is advisory only: it never blocks, links, or merges anything.
 */
export function evaluateDuplicateSignals(
  candidate: ComparisonValues,
  other: ComparisonValues,
): Readonly<{ signals: DuplicateSignal[]; tier: ConfidenceTier }> | null {
  const signals: DuplicateSignal[] = [];
  if (candidate.emailNormalized === other.emailNormalized)
    signals.push("EXACT_EMAIL");
  if (
    candidate.phoneE164 !== null &&
    other.phoneE164 !== null &&
    candidate.phoneE164 === other.phoneE164
  ) {
    signals.push("EXACT_PHONE");
  }
  if (signals.length === 0) return null;
  return { signals, tier: signals.includes("EXACT_EMAIL") ? "HIGH" : "MEDIUM" };
}

/** Canonical pair ordering so a pair is stored once in one direction. */
export function canonicalPair(a: string, b: string): readonly [string, string] {
  if (a === b) throw new Error("a person cannot match itself");
  return a < b ? [a, b] : [b, a];
}

// ------------------------------------------------------------- merge policy

export type MergeSide = Readonly<{
  personId: string;
  status: PersonStatus;
  candidateAccountId: string | null;
  createdAt: Date;
  /** Hiring cycles of this person's ACTIVE candidacies. */
  activeCycleIds: readonly string[];
}>;

export type MergeBlock =
  | "BLOCKED_CASE_NOT_CONFIRMED"
  | "BLOCKED_PERSON_NOT_ACTIVE"
  | "BLOCKED_TWO_CANDIDATE_ACCOUNTS"
  | "BLOCKED_CURRENT_CANDIDACY_COLLISION";

export type MergeDecision =
  | Readonly<{
      kind: "MERGE";
      survivor: MergeSide;
      merged: MergeSide;
      resolutionCodes: string[];
    }>
  | Readonly<{ kind: "BLOCKED"; reason: MergeBlock }>;

/**
 * Merge gates and survivor policy. The survivor is the account-owned
 * person; otherwise the older record (ties: lower ID). Two different
 * candidate accounts, inactive people, or two ACTIVE candidacies for the
 * same hiring cycle block the merge; nothing is resolved silently.
 */
export function decideMerge(
  caseStatus: string,
  a: MergeSide,
  b: MergeSide,
): MergeDecision {
  if (caseStatus !== "CONFIRMED_DUPLICATE") {
    return { kind: "BLOCKED", reason: "BLOCKED_CASE_NOT_CONFIRMED" };
  }
  if (a.status !== "ACTIVE" || b.status !== "ACTIVE") {
    return { kind: "BLOCKED", reason: "BLOCKED_PERSON_NOT_ACTIVE" };
  }
  if (
    a.candidateAccountId !== null &&
    b.candidateAccountId !== null &&
    a.candidateAccountId !== b.candidateAccountId
  ) {
    return { kind: "BLOCKED", reason: "BLOCKED_TWO_CANDIDATE_ACCOUNTS" };
  }
  if (a.activeCycleIds.some((cycle) => b.activeCycleIds.includes(cycle))) {
    return { kind: "BLOCKED", reason: "BLOCKED_CURRENT_CANDIDACY_COLLISION" };
  }
  const byAccount =
    a.candidateAccountId !== null
      ? a
      : b.candidateAccountId !== null
        ? b
        : null;
  const older =
    a.createdAt.getTime() !== b.createdAt.getTime()
      ? a.createdAt < b.createdAt
        ? a
        : b
      : a.personId < b.personId
        ? a
        : b;
  const survivor = byAccount ?? older;
  const merged = survivor === a ? b : a;
  const resolutionCodes = [
    byAccount ? "SURVIVOR_ACCOUNT_OWNED" : "SURVIVOR_OLDEST",
    "SURVIVOR_IDENTITY_KEPT",
    "CANDIDACIES_REPARENTED",
    ...(merged.candidateAccountId ? ["ACCOUNT_LINK_TRANSFERRED"] : []),
  ];
  return { kind: "MERGE", survivor, merged, resolutionCodes };
}

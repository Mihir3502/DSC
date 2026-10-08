// Organization-module value rules (packet M2.1 §7–§12, DATA_MODEL §5).
// Pure and framework-neutral: codes, bounded plain text, content safety,
// timezones, public references, and closed status/worker-path values.

/** Stored code shape: normalized upper case, 2–32 characters. */
export const codePattern = /^[A-Z0-9][A-Z0-9_-]{1,31}$/;

/** Trims and upper-cases a submitted code; null when it is not valid. */
export function normalizeCode(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const value = input.trim().toUpperCase();
  return codePattern.test(value) ? value : null;
}

/** Public URL reference: 12 random Crockford base32 characters. */
export const publicReferencePattern = /^[0-9a-hjkmnp-tv-z]{12}$/;
export const publicReferenceAlphabet = "0123456789abcdefghjkmnpqrstvwxyz";

export function isPublicReference(value: unknown): value is string {
  return typeof value === "string" && publicReferencePattern.test(value);
}

export const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && uuidPattern.test(value);
}

export const hierarchyStatuses = [
  "DRAFT",
  "ACTIVE",
  "INACTIVE",
  "ARCHIVED",
] as const;
export type HierarchyStatus = (typeof hierarchyStatuses)[number];

export const positionStatuses = [
  "DRAFT",
  "ACTIVE",
  "INACTIVE",
  "RETIRED",
] as const;
export type PositionStatus = (typeof positionStatuses)[number];

export const descriptionStatuses = [
  "DRAFT",
  "PUBLISHED",
  "SUPERSEDED",
  "RETIRED",
] as const;
export type DescriptionStatus = (typeof descriptionStatuses)[number];

export const cycleStatuses = [
  "DRAFT",
  "PUBLISHED",
  "OPEN",
  "CLOSED",
  "CANCELLED",
  "ARCHIVED",
] as const;
export type CycleStatus = (typeof cycleStatuses)[number];

/**
 * Which worker paths a reusable position may support. "Contractor
 * eligible" never classifies a person or guarantees 1099 treatment.
 */
export const workerPaths = [
  "W2_ONLY",
  "CONTRACTOR_ELIGIBLE_ONLY",
  "W2_AND_CONTRACTOR_ELIGIBLE",
] as const;
export type WorkerPaths = (typeof workerPaths)[number];

export function isWorkerPaths(value: unknown): value is WorkerPaths {
  return (
    typeof value === "string" &&
    (workerPaths as readonly string[]).includes(value)
  );
}

// ------------------------------------------------------- bounded text

export type TextProblem = "REQUIRED" | "TOO_LONG" | "UNSAFE_CONTENT";

/** C0/C1 controls except tab, line feed, and carriage return. */
const controlCharacters =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/;
/** Bidirectional overrides/isolates and invisible direction marks. */
const bidiCharacters = /[؜‎‏‪-‮⁦-⁩]/;
/** Anything that could be read as markup: tags, comments, declarations. */
const markup = /<\s*\/?\s*[A-Za-z!?]/;
/** Executable or embedding URL schemes. */
const unsafeScheme = /\b(?:javascript|vbscript|data|file)\s*:/i;
/** Template or expression syntax from common engines. */
const templateSyntax = /\{\{|\}\}|\$\{|<%|%>|\{%|%\}|\[\[|\]\]/;

/** Is this text free of markup, unsafe schemes, templates, and controls? */
export function isSafePlainText(value: string, multiline: boolean): boolean {
  const normalized = value.normalize("NFKC");
  if (controlCharacters.test(normalized)) return false;
  if (!multiline && /[\r\n\t]/.test(normalized)) return false;
  if (bidiCharacters.test(normalized)) return false;
  if (markup.test(normalized)) return false;
  if (unsafeScheme.test(normalized)) return false;
  if (templateSyntax.test(normalized)) return false;
  return true;
}

export type TextRule = Readonly<{
  max: number;
  multiline?: boolean;
  optional?: boolean;
}>;

export type TextResult =
  | Readonly<{ ok: true; value: string | null }>
  | Readonly<{ ok: false; problem: TextProblem }>;

/**
 * Validates bounded plain text. The value is trimmed (and line endings
 * normalized for multi-line text) but otherwise stored as entered.
 */
export function checkText(input: unknown, rule: TextRule): TextResult {
  if (input === undefined || input === null) {
    return rule.optional
      ? { ok: true, value: null }
      : { ok: false, problem: "REQUIRED" };
  }
  if (typeof input !== "string") return { ok: false, problem: "REQUIRED" };
  const value = (rule.multiline ? input.replace(/\r\n?/g, "\n") : input).trim();
  if (value.length === 0) {
    return rule.optional
      ? { ok: true, value: null }
      : { ok: false, problem: "REQUIRED" };
  }
  if ([...value].length > rule.max) return { ok: false, problem: "TOO_LONG" };
  if (!isSafePlainText(value, rule.multiline === true)) {
    return { ok: false, problem: "UNSAFE_CONTENT" };
  }
  return { ok: true, value };
}

// ------------------------------------------------------------ timezones

let zones: ReadonlySet<string> | null = null;

/** A supported IANA timezone name (UTC included). */
export function isTimezone(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 64) {
    return false;
  }
  zones ??= new Set(["UTC", ...Intl.supportedValuesOf("timeZone")]);
  return zones.has(value);
}

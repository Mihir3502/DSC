import { z } from "zod";
import {
  hasForbiddenCharacters,
  normalizeContactEmail,
  normalizePhone,
} from "@/modules/candidates/domain/normalization";

// Versioned application templates and draft-answer validation (packet M2.4
// §6, §8; DATA_MODEL §7). Pure and deterministic. A template version is
// data read from an immutable row, so it is parsed strictly before use.
//
// Draft validation is candidate-safe: a value that is present must be
// valid, and a missing required value only keeps the section In progress,
// so a partial draft can always be saved. Problems are closed codes that
// never echo the submitted value.

const code = z.string().regex(/^[a-z][a-z0-9_]{1,39}$/);
const text = z.string().min(1).max(300);

const option = z.strictObject({ value: code, label: text });
const fieldBase = {
  code,
  label: text,
  hint: text.optional(),
  required: z.boolean(),
};

const fieldSchema = z.discriminatedUnion("type", [
  z.strictObject({ ...fieldBase, type: z.literal("short_text") }),
  z.strictObject({ ...fieldBase, type: z.literal("long_text") }),
  z.strictObject({ ...fieldBase, type: z.literal("date") }),
  z.strictObject({ ...fieldBase, type: z.literal("email") }),
  z.strictObject({ ...fieldBase, type: z.literal("phone") }),
  z.strictObject({
    ...fieldBase,
    type: z.literal("single_choice"),
    options: z.array(option).min(2).max(20),
  }),
  z.strictObject({
    ...fieldBase,
    type: z.literal("multi_choice"),
    options: z.array(option).min(2).max(20),
  }),
]);

const sectionSchema = z.strictObject({
  code,
  title: text,
  description: text,
  fields: z.array(fieldSchema).min(1).max(30),
});

export const templateSchema = z
  .strictObject({ sections: z.array(sectionSchema).min(1).max(20) })
  .refine(
    (t) => {
      const sections = t.sections.map((s) => s.code);
      return (
        new Set(sections).size === sections.length &&
        t.sections.every(
          (s) => new Set(s.fields.map((f) => f.code)).size === s.fields.length,
        )
      );
    },
    { message: "section and field codes must be unique" },
  );

export type ApplicationTemplate = z.infer<typeof templateSchema>;
export type TemplateSection = ApplicationTemplate["sections"][number];
export type TemplateField = TemplateSection["fields"][number];

/** Parses an immutable template row; null means it must not be used. */
export function parseTemplate(value: unknown): ApplicationTemplate | null {
  const parsed = templateSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export const SHORT_TEXT_MAX = 200;
export const LONG_TEXT_MAX = 2000;

export type AnswerProblem =
  | "INVALID_FORMAT"
  | "TOO_LONG"
  | "INVALID_CHARACTERS"
  | "INVALID_EMAIL"
  | "INVALID_PHONE"
  | "INVALID_DATE"
  | "INVALID_CHOICE";

export type AnswerValue = string | readonly string[];
export type SectionAnswers = Readonly<Record<string, AnswerValue>>;
export type SectionCompletion = "IN_PROGRESS" | "COMPLETE";

export type SectionValidation =
  | Readonly<{
      ok: true;
      answers: SectionAnswers;
      completion: SectionCompletion;
      missing: readonly string[];
    }>
  | Readonly<{ ok: false; problems: Readonly<Record<string, AnswerProblem>> }>
  /** Not a shape any rendered form produces: refused as a whole. */
  | Readonly<{ ok: false; rejected: true }>;

function validText(value: string, max: number, multiline: boolean) {
  const cleaned = value.normalize("NFC").replace(/\r\n?/g, "\n").trim();
  const checked = multiline ? cleaned.replace(/\n/g, " ") : cleaned;
  if (cleaned.length > max) return { problem: "TOO_LONG" } as const;
  if (hasForbiddenCharacters(checked))
    return { problem: "INVALID_CHARACTERS" } as const;
  return { value: cleaned } as const;
}

function validDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const [year, month, day] = [
    Number(match[1]),
    Number(match[2]),
    Number(match[3]),
  ];
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    year >= 1900 &&
    year <= 2100 &&
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function validateField(
  field: TemplateField,
  raw: unknown,
):
  | Readonly<{ value: AnswerValue | null }>
  | Readonly<{ problem: AnswerProblem }> {
  if (field.type === "multi_choice") {
    if (!Array.isArray(raw)) return { problem: "INVALID_FORMAT" };
    const allowed = new Set(field.options.map((o) => o.value));
    if (
      raw.length > field.options.length ||
      new Set(raw).size !== raw.length ||
      !raw.every((v) => typeof v === "string" && allowed.has(v))
    ) {
      return { problem: "INVALID_CHOICE" };
    }
    return { value: raw.length === 0 ? null : (raw as string[]) };
  }
  if (typeof raw !== "string") return { problem: "INVALID_FORMAT" };
  const max = field.type === "long_text" ? LONG_TEXT_MAX : SHORT_TEXT_MAX;
  const text = validText(raw, max, field.type === "long_text");
  if ("problem" in text) return { problem: text.problem! };
  const value = text.value!;
  if (value === "") return { value: null };
  switch (field.type) {
    case "short_text":
    case "long_text":
      return { value };
    case "date":
      return validDate(value) ? { value } : { problem: "INVALID_DATE" };
    case "email":
      return normalizeContactEmail(value)
        ? { value }
        : { problem: "INVALID_EMAIL" };
    case "phone": {
      const phone = normalizePhone(value);
      return phone.ok ? { value } : { problem: "INVALID_PHONE" };
    }
    case "single_choice":
      return field.options.some((o) => o.value === value)
        ? { value }
        : { problem: "INVALID_CHOICE" };
  }
}

/**
 * Validates one section's answers. Unknown or reserved field names reject
 * the whole submission (no mass assignment); values are validated only for
 * this section; empty values are dropped rather than stored.
 */
export function validateSection(
  section: TemplateSection,
  raw: unknown,
): SectionValidation {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, rejected: true };
  }
  const fields = new Map(section.fields.map((f) => [f.code, f]));
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.some(([name]) => !fields.has(name))) {
    return { ok: false, rejected: true };
  }
  const answers: Record<string, AnswerValue> = {};
  const problems: Record<string, AnswerProblem> = {};
  for (const [name, value] of entries) {
    const result = validateField(fields.get(name)!, value);
    if ("problem" in result) problems[name] = result.problem;
    else if (result.value !== null) answers[name] = result.value;
  }
  if (Object.keys(problems).length > 0) return { ok: false, problems };
  const missing = section.fields
    .filter((f) => f.required && answers[f.code] === undefined)
    .map((f) => f.code);
  return {
    ok: true,
    answers,
    completion: missing.length === 0 ? "COMPLETE" : "IN_PROGRESS",
    missing,
  };
}

/** Reasons a staff member may record for an assisted save (closed set). */
export const assistReasons = [
  "CANDIDATE_REQUESTED_ASSISTANCE",
  "ACCESSIBILITY_ACCOMMODATION",
  "DATA_ENTRY_CORRECTION",
] as const;
export type AssistReason = (typeof assistReasons)[number];

/** Upper bound on a serialized section submission. */
export const MAX_ANSWERS_JSON_LENGTH = 40_000;

export type ApplicationCheck = Readonly<{
  complete: boolean;
  sections: readonly Readonly<{
    code: string;
    title: string;
    complete: boolean;
    /** Labels of required answers still missing or no longer valid. */
    missing: readonly string[];
  }>[];
}>;

/** Whole-application validation: every section against the pinned template. */
export function checkApplication(
  template: ApplicationTemplate,
  answersBySection: Readonly<Record<string, unknown>>,
): ApplicationCheck {
  const sections = template.sections.map((section) => {
    const result = validateSection(
      section,
      answersBySection[section.code] ?? {},
    );
    const labels = (codes: readonly string[]) =>
      section.fields.filter((f) => codes.includes(f.code)).map((f) => f.label);
    const missing = !result.ok
      ? "problems" in result
        ? labels(Object.keys(result.problems))
        : section.fields.map((f) => f.label)
      : labels(result.missing);
    return {
      code: section.code,
      title: section.title,
      complete: missing.length === 0,
      missing,
    };
  });
  return { complete: sections.every((s) => s.complete), sections };
}

/** Normalizes the typed signature; null when it can't be accepted. */
export function normalizeSignature(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const name = raw.normalize("NFC").trim().replace(/\s+/g, " ");
  return name.length >= 2 && name.length <= 200 && !hasForbiddenCharacters(name)
    ? name
    : null;
}

// ------------------------------------------------- return and correction

/** Candidate-visible reasons (M2.7). The wording is a draft for review. */
export const returnReasons = {
  INCOMPLETE_INFORMATION: "Some information is missing",
  INCORRECT_INFORMATION: "Some information looks incorrect",
  UNCLEAR_ANSWER: "An answer needs more detail",
  ATTACHMENT_PROBLEM: "There is a problem with an attachment",
  OTHER: "Something else needs your attention",
} as const;
export type ReturnReason = keyof typeof returnReasons;

export const MAX_INSTRUCTIONS_LENGTH = 1000;

export const isReturnReason = (value: unknown): value is ReturnReason =>
  typeof value === "string" && Object.hasOwn(returnReasons, value);

/** Plain candidate-visible text; null when it can't be accepted. */
export function normalizeInstructions(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const text = raw.normalize("NFC").replace(/\r\n?/g, "\n").trim();
  return text.length >= 1 &&
    text.length <= MAX_INSTRUCTIONS_LENGTH &&
    !hasForbiddenCharacters(text.replace(/\n/g, " "))
    ? text
    : null;
}

/** Section code to the fields staff flagged in it (possibly none). */
export type ReopenedSections = Readonly<Record<string, readonly string[]>>;

/** Keeps only an exact selection from the pinned template; else null. */
export function parseReopenSelection(
  template: ApplicationTemplate,
  raw: unknown,
): ReopenedSections | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw))
    return null;
  const selected: Record<string, readonly string[]> = {};
  for (const [code, fields] of Object.entries(raw)) {
    const section = template.sections.find((s) => s.code === code);
    if (!section || !Array.isArray(fields)) return null;
    const known = new Set(section.fields.map((f) => f.code));
    if (
      new Set(fields).size !== fields.length ||
      !fields.every((f) => typeof f === "string" && known.has(f))
    ) {
      return null;
    }
    selected[code] = fields as string[];
  }
  return selected;
}

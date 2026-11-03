import { normalizeLoginEmail } from "@/modules/identity-access/domain/email";

// Server-side person-identity normalization, version NORM-1 (packet M2.2
// §7, §23; DATA_MODEL §6.1). Pure and deterministic. Display values keep
// what the person entered (trimmed, NFC); comparison values are derived
// only for approved duplicate signals (email, phone). Names are never a
// comparison key on their own.

export const NORMALIZATION_VERSION = "NORM-1";

export type FieldProblem =
  | "REQUIRED"
  | "TOO_LONG"
  | "INVALID_CHARACTERS"
  | "INVALID_EMAIL"
  | "INVALID_PHONE";

/** C0/C1 controls, DEL, zero-width, bidi overrides/isolates, BOM. */
const forbidden = /[\u0000-\u001f\u007f-\u009f؜​-‏‪-‮⁠-⁩﻿]/u;
/**
 * Lawful name characters: letters and combining marks of any script,
 * spaces, apostrophes (straight and typographic), hyphens, and periods.
 * Digits, symbols, markup, and punctuation used for injection are refused.
 */
const nameCharacters = /^[\p{L}\p{M}][\p{L}\p{M} '’\-.]*$/u;

/** True when text holds a control, zero-width, bidi, or BOM character. */
export function hasForbiddenCharacters(value: string): boolean {
  return forbidden.test(value);
}

export type NameResult =
  | Readonly<{ ok: true; value: string | null }>
  | Readonly<{ ok: false; problem: FieldProblem }>;

/** A bounded human name: NFC, whitespace collapsed, script-neutral. */
export function normalizeName(
  input: unknown,
  options: Readonly<{ max: number; optional?: boolean }>,
): NameResult {
  if (input === undefined || input === null || input === "") {
    return options.optional
      ? { ok: true, value: null }
      : { ok: false, problem: "REQUIRED" };
  }
  if (typeof input !== "string") return { ok: false, problem: "REQUIRED" };
  if (input.length > options.max * 4) return { ok: false, problem: "TOO_LONG" };
  if (forbidden.test(input))
    return { ok: false, problem: "INVALID_CHARACTERS" };
  const value = input.normalize("NFC").replace(/\s+/gu, " ").trim();
  if (value.length === 0) {
    return options.optional
      ? { ok: true, value: null }
      : { ok: false, problem: "REQUIRED" };
  }
  if ([...value].length > options.max)
    return { ok: false, problem: "TOO_LONG" };
  if (!nameCharacters.test(value)) {
    return { ok: false, problem: "INVALID_CHARACTERS" };
  }
  return { ok: true, value };
}

export type EmailValue = Readonly<{ display: string; normalized: string }>;

export function normalizeContactEmail(input: unknown): EmailValue | null {
  try {
    const email = normalizeLoginEmail(input);
    return { display: email.display, normalized: email.login };
  } catch {
    return null;
  }
}

export type PhoneValue = Readonly<{ display: string; e164: string | null }>;

/**
 * A phone display value plus an E.164 comparison value when it is a
 * validly formed North American number (NANP) or already in "+<digits>"
 * international form. Anything else keeps only the display value, so it
 * never produces a duplicate signal.
 */
export function normalizePhone(
  input: unknown,
):
  | Readonly<{ ok: true; value: PhoneValue | null }>
  | Readonly<{ ok: false; problem: FieldProblem }> {
  if (input === undefined || input === null || input === "") {
    return { ok: true, value: null };
  }
  if (typeof input !== "string" || input.length > 40) {
    return { ok: false, problem: "INVALID_PHONE" };
  }
  if (forbidden.test(input)) return { ok: false, problem: "INVALID_PHONE" };
  const display = input.normalize("NFKC").trim().replace(/\s+/g, " ");
  if (display === "") return { ok: true, value: null };
  if (!/^\+?[0-9 ().\-]{7,30}$/.test(display)) {
    return { ok: false, problem: "INVALID_PHONE" };
  }
  const digits = display.replace(/\D/g, "");
  let e164: string | null = null;
  if (display.startsWith("+")) {
    if (/^[1-9]\d{7,14}$/.test(digits)) e164 = `+${digits}`;
  } else {
    const national =
      digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
    // NANP: area code and exchange start with 2–9.
    if (/^[2-9]\d{2}[2-9]\d{6}$/.test(national)) e164 = `+1${national}`;
  }
  return { ok: true, value: { display, e164 } };
}

/** Masks contact values for the duplicate-review projection. */
export function maskEmail(normalized: string): string {
  const [local, domain] = normalized.split("@");
  if (!local || !domain) return "•••";
  return `${local.slice(0, 1)}•••@${domain}`;
}

export function maskPhone(e164OrDisplay: string): string {
  const digits = e164OrDisplay.replace(/\D/g, "");
  return digits.length >= 4 ? `•••-${digits.slice(-4)}` : "•••";
}

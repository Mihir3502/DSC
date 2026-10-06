import { z } from "zod";

// One server-owned login-email normalizer used before every account lookup
// or creation (packet M1.1 §7.3):
//   1. trim surrounding whitespace
//   2. Unicode NFC normalization
//   3. reject control characters and invalid/oversized addresses
//   4. locale-independent lowercase for login comparison
// No provider-specific rewriting (no Gmail dot removal or plus stripping).

export const MAX_EMAIL_LENGTH = 254;

const emailShape = z.email().max(MAX_EMAIL_LENGTH);
// C0/C1 control characters, DEL, and bidi/zero-width formatting characters.
const forbiddenCharacters = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/;

export type NormalizedEmail = Readonly<{
  /** Normalized form used for equality and the unique index. */
  login: string;
  /** User-entered form (trimmed, NFC) kept for display only. */
  display: string;
}>;

export class InvalidEmailError extends Error {
  constructor() {
    super("INVALID_EMAIL");
    this.name = "InvalidEmailError";
  }
}

export function normalizeLoginEmail(input: unknown): NormalizedEmail {
  if (typeof input !== "string" || input.length > MAX_EMAIL_LENGTH * 2) {
    throw new InvalidEmailError();
  }
  const display = input.trim().normalize("NFC");
  if (forbiddenCharacters.test(display)) throw new InvalidEmailError();
  const login = display.toLowerCase();
  if (!emailShape.safeParse(login).success) throw new InvalidEmailError();
  return Object.freeze({ login, display });
}

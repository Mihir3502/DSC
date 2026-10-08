// Candidate registration, password, and post-authentication destination
// policy (packet M1.2 §6–7, §9.3). Pure functions only: no Better Auth,
// Next.js, Drizzle, HTTP, or logger imports (enforced by ESLint).

/** Approved bounds, matching the Better Auth configuration (ADR-0002). */
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 256;

export type PasswordProblem =
  | "REQUIRED"
  | "TOO_SHORT"
  | "TOO_LONG"
  | "CONTROL_CHARACTERS"
  | "MISMATCH"
  | "COMPROMISED";

// C0/C1 control characters and DEL. Documented reason: they cannot be typed
// reliably, are altered by some form/clipboard layers, and would make the
// password impossible to re-enter.
const controlCharacters = /[\u0000-\u001f\u007f-\u009f]/;

/**
 * Validates a new password and its confirmation. The password is never
 * trimmed or transformed, there are no composition rules, and the
 * confirmation is compared here only (never stored). Lengths use the same
 * UTF-16 measure as Better Auth so both layers agree.
 */
export function checkNewPassword(
  password: unknown,
  confirmation: unknown,
): PasswordProblem[] {
  if (typeof password !== "string" || password.length === 0) {
    return ["REQUIRED"];
  }
  const problems: PasswordProblem[] = [];
  if (password.length < PASSWORD_MIN_LENGTH) problems.push("TOO_SHORT");
  if (password.length > PASSWORD_MAX_LENGTH) problems.push("TOO_LONG");
  if (controlCharacters.test(password)) problems.push("CONTROL_CHARACTERS");
  if (confirmation !== password) problems.push("MISMATCH");
  return problems;
}

/** Registration entry sources supported before M2 (packet §6.2). */
export const registrationSources = [
  "PUBLIC_POSITION",
  "CANDIDATE_INVITATION",
] as const;
export type RegistrationSource = (typeof registrationSources)[number];

/**
 * Closed registry of post-authentication continuation keys. Browsers submit
 * a key, never a URL; the server resolves it to a same-origin path. M2 may
 * add position/application continuations here.
 */
const continuationDestinations = Object.freeze({
  CANDIDATE_SECURITY: "/candidate/security",
  /** M2.1 start-application handoff boundary (M2.2 creates the candidacy). */
  APPLICATION_START: "/candidate/applications/new",
} as const);
export type ContinuationKey = keyof typeof continuationDestinations;
export const DEFAULT_CONTINUATION: ContinuationKey = "CANDIDATE_SECURITY";

export function isContinuationKey(value: unknown): value is ContinuationKey {
  return (
    typeof value === "string" &&
    Object.prototype.hasOwnProperty.call(continuationDestinations, value)
  );
}

/**
 * Resolves a submitted continuation key to a same-origin relative path.
 * Anything that is not an exact registry key (absolute or protocol-relative
 * URLs, encoded schemes, backslashes, control characters, nested redirect
 * parameters, staff routes) falls back to the candidate default.
 */
export function resolvePostAuthDestination(key: unknown): string {
  return continuationDestinations[
    isContinuationKey(key) ? key : DEFAULT_CONTINUATION
  ];
}

export type RegistrationIntent = Readonly<{
  source: RegistrationSource;
  continuationKey: ContinuationKey;
  /** Normalized invited email; present only for CANDIDATE_INVITATION. */
  boundEmail?: string;
  expiresAt: Date;
}>;

/**
 * An invitation intent may only register its own normalized email; a public
 * intent carries no email binding.
 */
export function intentAllowsEmail(
  intent: RegistrationIntent,
  normalizedEmail: string,
): boolean {
  if (intent.source === "CANDIDATE_INVITATION") {
    return intent.boundEmail === normalizedEmail;
  }
  return intent.boundEmail === undefined;
}

/** Masks an email for display to its signed-in owner: "t•••@example.test". */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at < 1) return "•••";
  return `${email[0]}•••${email.slice(at)}`;
}

/**
 * Coarse, privacy-preserving device label from a user-agent string. Only a
 * browser family and OS family are derived; the full string is never shown.
 */
export function describeDevice(userAgent: string | null | undefined): string {
  if (!userAgent) return "Unknown device";
  const browser = /Edg\//.test(userAgent)
    ? "Edge"
    : /Firefox\//.test(userAgent)
      ? "Firefox"
      : /Chrome\/|Chromium\/|CriOS\//.test(userAgent)
        ? "Chrome"
        : /Safari\//.test(userAgent)
          ? "Safari"
          : "Browser";
  const os = /Android/.test(userAgent)
    ? "Android"
    : /iPhone|iPad|iPod/.test(userAgent)
      ? "iOS"
      : /Mac OS X|Macintosh/.test(userAgent)
        ? "macOS"
        : /Windows/.test(userAgent)
          ? "Windows"
          : /Linux|X11/.test(userAgent)
            ? "Linux"
            : "unknown system";
  return `${browser} on ${os}`;
}

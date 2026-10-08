// Server-owned authentication assurance and named recent-authentication
// policies (packet M1.3 §13, AC-M1.3-09). Pure and framework-neutral: no
// Better Auth, Next.js, Drizzle, HTTP, or logger imports (enforced by
// ESLint), so M1.4–M1.6 and later commands can evaluate it anywhere.
//
// Evidence comes only from the server-side session record. Nothing here
// accepts a client-submitted timestamp, method, or freshness flag.

export const authenticationMethods = [
  "PASSWORD",
  "PASSWORD_TOTP",
  "PASSWORD_BACKUP_CODE",
] as const;
export type AuthenticationMethod = (typeof authenticationMethods)[number];

/** Methods that include a second factor. */
export const mfaMethods: readonly AuthenticationMethod[] = [
  "PASSWORD_TOTP",
  "PASSWORD_BACKUP_CODE",
];

/** The strongest approved method in M1.3 (passkeys are not approved). */
export const strongMethods: readonly AuthenticationMethod[] = ["PASSWORD_TOTP"];

export const assurancePolicies = [
  /** An MFA-complete staff session, however old. */
  "NORMAL_STAFF_SESSION",
  /** MFA (TOTP or backup code) within the recent-auth interval. */
  "RECENT_STAFF_AUTH",
  /** Password + TOTP within the interval; backup codes never qualify. */
  "RECENT_STRONG_AUTH",
] as const;
export type AssurancePolicy = (typeof assurancePolicies)[number];

/**
 * Closed registry of reauthentication purposes and where each continues.
 * Browsers submit a key, never a URL or an action; later work items add
 * purposes here when their commands adopt the primitive.
 */
const reauthenticationDestinations = Object.freeze({
  STAFF_SECURITY: "/staff/security",
  CHANGE_PASSWORD: "/staff/security#password",
  /** M2.1 configuration status changes and publication (ADR-0005 note). */
  CONFIGURATION_CHANGE: "/staff/admin/positions",
} as const);
/**
 * Purposes satisfied only by an inline step-up made by the command that
 * needs them, never through the reauthentication page. M1.4 adds the
 * named purposes its permission catalog requires (ADR-0005).
 */
export const inlineReauthenticationPurposes = [
  "REGENERATE_BACKUP_CODES",
  "PRIVILEGED_ACCESS_CHANGE",
  "RESTRICTED_DATA_ACCESS",
  "HIGH_RISK_APPROVAL",
  "RESTRICTED_EXPORT",
  "BREAK_GLASS",
] as const;
export type InlineReauthenticationPurpose =
  (typeof inlineReauthenticationPurposes)[number];

export type ReauthenticationPurpose =
  keyof typeof reauthenticationDestinations | InlineReauthenticationPurpose;

export function isInlineReauthenticationPurpose(
  value: unknown,
): value is InlineReauthenticationPurpose {
  return (
    typeof value === "string" &&
    (inlineReauthenticationPurposes as readonly string[]).includes(value)
  );
}

export function isReauthenticationPurpose(
  value: unknown,
): value is ReauthenticationPurpose {
  return (
    isInlineReauthenticationPurpose(value) ||
    (typeof value === "string" &&
      Object.prototype.hasOwnProperty.call(reauthenticationDestinations, value))
  );
}

/**
 * Same-origin continuation for a purpose submitted through the
 * reauthentication page. Unknown keys, URLs, and the inline-only
 * backup-code purpose fall back to the security page.
 */
export function reauthenticationDestination(purpose: unknown): string {
  return typeof purpose === "string" &&
    Object.prototype.hasOwnProperty.call(reauthenticationDestinations, purpose)
    ? reauthenticationDestinations[
        purpose as keyof typeof reauthenticationDestinations
      ]
    : reauthenticationDestinations.STAFF_SECURITY;
}

/** Server-side evidence recorded on one session. */
export type AssuranceEvidence = Readonly<{
  accountId: string;
  sessionId: string;
  /** "STAFF" for an MFA-complete staff session. */
  sessionPurpose: string | null;
  method: AuthenticationMethod | null;
  primaryAuthenticatedAt: Date | null;
  mfaAuthenticatedAt: Date | null;
  /** Account version when the session was issued. */
  sessionAccountVersion: number | null;
  /** Account version now (any security change increments it). */
  currentAccountVersion: number;
  reauthentication: Readonly<{
    at: Date;
    method: AuthenticationMethod;
    purpose: string;
  }> | null;
}>;

export type AssuranceRequest = Readonly<{
  policy: AssurancePolicy;
  /** The account and session the command is acting for. */
  accountId: string;
  sessionId: string;
  /** When set, only reauthentication made for this purpose counts. */
  purpose?: ReauthenticationPurpose;
  now: Date;
  recentWindowSeconds: number;
  /** Tolerated future skew of recorded times (server clocks). */
  maxClockSkewSeconds?: number;
}>;

export type AssuranceDenyReason =
  | "NO_EVIDENCE"
  | "ACCOUNT_MISMATCH"
  | "SESSION_MISMATCH"
  | "NOT_MFA_SESSION"
  | "STALE_ACCOUNT_VERSION"
  | "CLOCK_SKEW"
  | "INVALID_REQUEST";

export type AssuranceChallengeReason =
  "REAUTHENTICATION_REQUIRED" | "STRONGER_METHOD_REQUIRED";

export type AssuranceDecision =
  | Readonly<{ kind: "ALLOW"; method: AuthenticationMethod; at: Date }>
  | Readonly<{ kind: "CHALLENGE"; reason: AssuranceChallengeReason }>
  | Readonly<{ kind: "DENY"; reason: AssuranceDenyReason }>;

type AuthEvent = Readonly<{
  at: Date;
  method: AuthenticationMethod;
  purpose: string | null;
}>;

const DEFAULT_SKEW_SECONDS = 5;

/**
 * Evaluates a named policy against server-owned evidence.
 *
 * - DENY when the evidence is missing, belongs to another account/session,
 *   is not an MFA-complete staff session, predates a security change
 *   (account version), or carries impossible future timestamps.
 * - CHALLENGE when the session is valid but not recent/strong enough; the
 *   caller sends the user to reauthenticate.
 * - Freshness is strict: an event exactly `recentWindowSeconds` old is no
 *   longer recent. A sign-in event is dated by the older of its password
 *   and MFA times, so a late MFA step never refreshes an old password.
 */
export function evaluateAssurance(
  evidence: AssuranceEvidence | null,
  request: AssuranceRequest,
): AssuranceDecision {
  if (
    !Number.isFinite(request.recentWindowSeconds) ||
    request.recentWindowSeconds <= 0
  ) {
    return { kind: "DENY", reason: "INVALID_REQUEST" };
  }
  if (!evidence) return { kind: "DENY", reason: "NO_EVIDENCE" };
  if (evidence.accountId !== request.accountId) {
    return { kind: "DENY", reason: "ACCOUNT_MISMATCH" };
  }
  if (evidence.sessionId !== request.sessionId) {
    return { kind: "DENY", reason: "SESSION_MISMATCH" };
  }
  if (
    evidence.sessionPurpose !== "STAFF" ||
    !evidence.method ||
    !mfaMethods.includes(evidence.method) ||
    !evidence.primaryAuthenticatedAt ||
    !evidence.mfaAuthenticatedAt
  ) {
    return { kind: "DENY", reason: "NOT_MFA_SESSION" };
  }
  if (evidence.sessionAccountVersion !== evidence.currentAccountVersion) {
    return { kind: "DENY", reason: "STALE_ACCOUNT_VERSION" };
  }

  const now = request.now.getTime();
  const skewMs = (request.maxClockSkewSeconds ?? DEFAULT_SKEW_SECONDS) * 1000;
  const recorded = [
    evidence.primaryAuthenticatedAt,
    evidence.mfaAuthenticatedAt,
    evidence.reauthentication?.at,
  ].filter((d): d is Date => d instanceof Date);
  if (recorded.some((d) => d.getTime() > now + skewMs)) {
    return { kind: "DENY", reason: "CLOCK_SKEW" };
  }

  const signIn: AuthEvent = {
    at: new Date(
      Math.min(
        evidence.primaryAuthenticatedAt.getTime(),
        evidence.mfaAuthenticatedAt.getTime(),
      ),
    ),
    method: evidence.method,
    purpose: null,
  };

  if (request.policy === "NORMAL_STAFF_SESSION") {
    return { kind: "ALLOW", method: signIn.method, at: signIn.at };
  }
  if (
    request.policy !== "RECENT_STAFF_AUTH" &&
    request.policy !== "RECENT_STRONG_AUTH"
  ) {
    return { kind: "DENY", reason: "INVALID_REQUEST" };
  }

  const events: AuthEvent[] = [signIn];
  if (evidence.reauthentication) events.push(evidence.reauthentication);
  // Purpose-bound requests count only reauthentication made for them.
  const relevant = request.purpose
    ? events.filter((e) => e.purpose === request.purpose)
    : events;
  const windowMs = request.recentWindowSeconds * 1000;
  const recent = relevant.filter((e) => now - e.at.getTime() < windowMs);

  const acceptable =
    request.policy === "RECENT_STRONG_AUTH" ? strongMethods : mfaMethods;
  const satisfying = recent
    .filter((e) => acceptable.includes(e.method))
    .sort((a, b) => b.at.getTime() - a.at.getTime())[0];
  if (satisfying) {
    return { kind: "ALLOW", method: satisfying.method, at: satisfying.at };
  }
  return {
    kind: "CHALLENGE",
    reason:
      recent.length > 0
        ? "STRONGER_METHOD_REQUIRED"
        : "REAUTHENTICATION_REQUIRED",
  };
}

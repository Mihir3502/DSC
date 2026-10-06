import type { AppLogger } from "@/shared/logging";

// Security event port until M1.6 (packet M1.2 §15). Events are typed and
// future-audit-ready, but this adapter writes only an allowlisted
// operational event code and an opaque account reference through the M0.5
// logger. It never receives an email, password, token, cookie, IP, user
// agent, or request body. M1.6 replaces or composes this with atomic,
// immutable audit persistence; PRD-AUTH-007 is not satisfied until then.

export const securityEventCodes = [
  "auth.registration_requested",
  "auth.registration_account_created",
  "auth.verification_sent",
  "auth.verification_completed",
  "auth.verification_failed",
  "auth.sign_in_succeeded",
  "auth.sign_in_failed",
  "auth.sign_out",
  "auth.recovery_requested",
  "auth.recovery_email_sent",
  "auth.recovery_completed",
  "auth.recovery_failed",
  "auth.password_changed",
  "auth.password_change_failed",
  "auth.session_revoked",
  "auth.sessions_revoked",
  "auth.rate_limited",
  // M1.3 staff invitation, activation, MFA, recent auth, and recovery.
  "staff.invitation_issued",
  "staff.invitation_superseded",
  "staff.invitation_revoked",
  "staff.invitation_expired",
  "staff.invitation_accepted",
  "staff.invitation_refused",
  "staff.activation_started",
  "staff.activation_completed",
  "staff.activation_failed",
  "staff.mfa_enrolled",
  "staff.backup_codes_regenerated",
  "staff.mfa_reset",
  "staff.sign_in_first_factor_succeeded",
  "staff.sign_in_first_factor_failed",
  "staff.mfa_challenge_succeeded",
  "staff.mfa_challenge_failed",
  "staff.mfa_locked",
  "staff.backup_code_used",
  "staff.reauth_challenged",
  "staff.reauth_succeeded",
  "staff.reauth_failed",
  "staff.recovery_requested",
  "staff.recovery_verification_started",
  "staff.recovery_identity_verified",
  "staff.recovery_approved",
  "staff.recovery_rejected",
  "staff.recovery_cancelled",
  "staff.recovery_expired",
  "staff.recovery_completed",
  "staff.recovery_denied",
  "staff.session_revoked",
  "staff.sessions_revoked",
  "staff.password_changed",
  "staff.password_change_failed",
  "staff.sign_out",
] as const;
export type SecurityEventCode = (typeof securityEventCodes)[number];

/** Closed failure categories; never raw library codes. */
export type SecurityEventCategory =
  | "invalid_input"
  | "invalid_credentials"
  | "not_eligible"
  | "invalid_intent"
  | "invalid_code"
  | "invalid_link"
  | "rate_limited"
  | "duplicate"
  | "locked"
  | "replayed"
  | "expired"
  | "denied"
  | "challenge"
  | "ok";

export type SecurityEvent = Readonly<{
  code: SecurityEventCode;
  /** Opaque account UUID when known; never an email address. */
  accountRef?: string;
  /** Opaque invitation or recovery-case UUID (M1.3). */
  recordRef?: string;
  category?: SecurityEventCategory;
}>;

export interface SecurityEventPort {
  record(event: SecurityEvent): void;
}

const codes = new Set<string>(securityEventCodes);

export class LogSecurityEvents implements SecurityEventPort {
  constructor(private readonly logger: AppLogger) {}

  record(event: SecurityEvent): void {
    if (!codes.has(event.code)) return;
    this.logger.info(event.code, {
      module: "auth",
      eventCode: event.code,
      resultCode: event.category ?? "ok",
      actorRef: event.accountRef?.replaceAll("-", ""),
      recordRef: event.recordRef?.replaceAll("-", ""),
    });
  }
}

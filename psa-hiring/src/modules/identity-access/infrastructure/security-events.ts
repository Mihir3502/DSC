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
  | "ok";

export type SecurityEvent = Readonly<{
  code: SecurityEventCode;
  /** Opaque account UUID when known; never an email address. */
  accountRef?: string;
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
    });
  }
}

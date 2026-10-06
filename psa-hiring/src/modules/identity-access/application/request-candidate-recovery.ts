import "server-only";
import { clientKeyFrom } from "../infrastructure/action-rate-limiter";
import {
  defaultDependencies,
  tryNormalizeEmail,
  type CandidateAuthDependencies,
} from "./candidate-auth-support";

// Generic password-recovery request (packet M1.2 §12.1, AC-M1.2-03, -06).
// The response is identical whatever the account's existence, type,
// verification, or status. Better Auth creates the single-use hashed reset
// record; the sendResetPassword hook emails only active, verified
// candidates. Nothing here unlocks, enables, or reactivates an account.

export type RequestRecoveryResult =
  | Readonly<{ kind: "SENT" }>
  | Readonly<{ kind: "INVALID_INPUT" }>
  | Readonly<{ kind: "RATE_LIMITED" }>;

export async function requestCandidateRecovery(
  input: Readonly<{ email: unknown }>,
  headers: Headers,
  deps: CandidateAuthDependencies = defaultDependencies(),
): Promise<RequestRecoveryResult> {
  const email = tryNormalizeEmail(input.email);
  if (!email) return { kind: "INVALID_INPUT" };
  deps.events.record({ code: "auth.recovery_requested" });

  // Per-client limit is visible; the per-email cap is silent so an attacker
  // cannot learn anything or block the target's sign-in.
  if (!deps.limiter.consume("sendPerClient", clientKeyFrom(headers))) {
    deps.events.record({ code: "auth.rate_limited", category: "rate_limited" });
    return { kind: "RATE_LIMITED" };
  }
  if (!deps.limiter.consume("recoverySendPerEmail", email.login)) {
    deps.events.record({ code: "auth.rate_limited", category: "rate_limited" });
    return { kind: "SENT" };
  }

  await deps.auth.api.requestPasswordReset({ body: { email: email.login } });
  return { kind: "SENT" };
}

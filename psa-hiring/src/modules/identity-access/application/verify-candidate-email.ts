import "server-only";
import { clientKeyFrom } from "../infrastructure/action-rate-limiter";
import { OTP_LENGTH } from "../infrastructure/auth";
import {
  commandLogger,
  defaultDependencies,
  formString,
  tryNormalizeEmail,
  type CandidateAuthDependencies,
} from "./candidate-auth-support";
import { sendVerificationCode } from "./register-candidate";

// Email verification with a single-use, hashed, attempt-limited code from
// Better Auth's email-OTP plugin (packet M1.2 §10, ADR-0003). Success marks
// the email verified and the plugin hook activates the invited candidate.
// No session is issued: the candidate signs in afterwards.

export type VerifyCandidateEmailResult =
  | Readonly<{ kind: "VERIFIED" }>
  | Readonly<{ kind: "INVALID_INPUT"; email?: "INVALID"; code?: "INVALID" }>
  /** Wrong, expired, used, or exhausted code; same for unknown emails. */
  | Readonly<{ kind: "CODE_INVALID" }>
  | Readonly<{ kind: "RATE_LIMITED" }>;

const codeShape = new RegExp(`^\\d{${OTP_LENGTH}}$`);

export async function verifyCandidateEmail(
  input: Readonly<{ email: unknown; code: unknown }>,
  headers: Headers,
  deps: CandidateAuthDependencies = defaultDependencies(),
): Promise<VerifyCandidateEmailResult> {
  const email = tryNormalizeEmail(input.email);
  // Spaces/dashes are common when codes are copied; digits are unchanged.
  const code = formString(input.code, 64)?.replace(/[\s-]/g, "");
  if (!email || !code || !codeShape.test(code)) {
    return {
      kind: "INVALID_INPUT",
      ...(email ? {} : { email: "INVALID" as const }),
      ...(code && codeShape.test(code) ? {} : { code: "INVALID" as const }),
    };
  }
  if (
    !deps.limiter.consume(
      "verifyPerClientEmail",
      clientKeyFrom(headers),
      email.login,
    )
  ) {
    deps.events.record({ code: "auth.rate_limited", category: "rate_limited" });
    return { kind: "RATE_LIMITED" };
  }

  try {
    await deps.auth.api.verifyEmailOTP({
      body: { email: email.login, otp: code },
    });
  } catch {
    deps.events.record({
      code: "auth.verification_failed",
      category: "invalid_code",
    });
    commandLogger(deps).info("auth.verification_rejected", {
      resultCode: "invalid_code",
    });
    return { kind: "CODE_INVALID" };
  }
  return { kind: "VERIFIED" };
}

export type ResendVerificationResult =
  | Readonly<{ kind: "SENT" }>
  | Readonly<{ kind: "INVALID_INPUT" }>
  | Readonly<{ kind: "RATE_LIMITED" }>;

/** Generic resend: the same response whether or not anything was sent. */
export async function resendVerificationCode(
  input: Readonly<{ email: unknown }>,
  headers: Headers,
  deps: CandidateAuthDependencies = defaultDependencies(),
): Promise<ResendVerificationResult> {
  const email = tryNormalizeEmail(input.email);
  if (!email) return { kind: "INVALID_INPUT" };
  if (!deps.limiter.consume("sendPerClient", clientKeyFrom(headers))) {
    deps.events.record({ code: "auth.rate_limited", category: "rate_limited" });
    return { kind: "RATE_LIMITED" };
  }
  await sendVerificationCode(deps, email.login);
  return { kind: "SENT" };
}

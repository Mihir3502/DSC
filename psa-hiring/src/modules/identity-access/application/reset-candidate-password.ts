import "server-only";
import { canSignInInteractively } from "../domain/account-policy";
import type { PasswordProblem } from "../domain/candidate-registration-policy";
import { clientKeyFrom } from "../infrastructure/action-rate-limiter";
import { findAccountById } from "../infrastructure/account-repository";
import {
  commandLogger,
  defaultDependencies,
  formString,
  newPasswordProblems,
  type CandidateAuthDependencies,
} from "./candidate-auth-support";

// Password reset completion (packet M1.2 §12.2, AC-M1.2-06, -07). Better
// Auth consumes the hashed, purpose-bound reset record atomically (at most
// one reset per token), stores the new hash, sends the password-changed
// notice through onPasswordReset, and revokes every session. Account type,
// status, and verification are never changed; the candidate signs in again.

export type ResetPasswordResult =
  | Readonly<{ kind: "RESET" }>
  | Readonly<{ kind: "INVALID_INPUT"; password: readonly PasswordProblem[] }>
  /** Invalid, expired, used, or wrong-purpose link; one safe state. */
  | Readonly<{ kind: "LINK_INVALID" }>
  | Readonly<{ kind: "RATE_LIMITED" }>;

/** Better Auth reset tokens are 24 alphanumeric characters. */
const resetTokenShape = /^[A-Za-z0-9]{24}$/;

export async function resetCandidatePassword(
  input: Readonly<{
    token: unknown;
    password: unknown;
    passwordConfirmation: unknown;
  }>,
  headers: Headers,
  deps: CandidateAuthDependencies = defaultDependencies(),
): Promise<ResetPasswordResult> {
  const linkInvalid = (): ResetPasswordResult => {
    deps.events.record({
      code: "auth.recovery_failed",
      category: "invalid_link",
    });
    commandLogger(deps).info("auth.reset_rejected", {
      resultCode: "invalid_link",
    });
    return { kind: "LINK_INVALID" };
  };

  if (!deps.limiter.consume("resetPerClient", clientKeyFrom(headers))) {
    deps.events.record({ code: "auth.rate_limited", category: "rate_limited" });
    return { kind: "RATE_LIMITED" };
  }
  const token = formString(input.token, 128);
  if (!token || !resetTokenShape.test(token)) return linkInvalid();

  // Validate the password before touching the token, so a rejected password
  // does not burn the link.
  const problems = await newPasswordProblems(
    deps,
    input.password,
    input.passwordConfirmation,
  );
  if (problems.length > 0) return { kind: "INVALID_INPUT", password: problems };

  const ctx = await deps.auth.$context;
  const identifier = `reset-password:${token}`;
  const record = await ctx.internalAdapter.findVerificationValue(identifier);
  if (!record || new Date(record.expiresAt).getTime() <= Date.now()) {
    return linkInvalid();
  }
  const account = await findAccountById(deps.db, record.value);
  if (
    !account ||
    account.accountType !== "CANDIDATE" ||
    !canSignInInteractively(account)
  ) {
    // Never reset, unlock, or reactivate a non-eligible account.
    await ctx.internalAdapter.consumeVerificationValue(identifier);
    return linkInvalid();
  }

  try {
    await deps.auth.api.resetPassword({
      body: { token, newPassword: input.password as string },
    });
  } catch {
    return linkInvalid();
  }
  return { kind: "RESET" };
}

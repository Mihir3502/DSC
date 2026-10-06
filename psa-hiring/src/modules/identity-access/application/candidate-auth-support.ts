import "server-only";
import { getRequestContext } from "@/shared/logging";
import type { PasswordProblem } from "../domain/candidate-registration-policy";
import { checkNewPassword } from "../domain/candidate-registration-policy";
import { InvalidEmailError, normalizeLoginEmail } from "../domain/email";
import {
  getIdentityRuntime,
  type IdentityRuntime,
} from "../infrastructure/runtime";

// Shared helpers for candidate authentication commands (packet M1.2).

export type CandidateAuthDependencies = IdentityRuntime;

export function defaultDependencies(): CandidateAuthDependencies {
  return getIdentityRuntime();
}

export function commandLogger(deps: CandidateAuthDependencies) {
  return deps.logger.child({
    module: "identity-access",
    correlationId: getRequestContext()?.correlationId,
  });
}

/** Normalized login email, or null for anything invalid. */
export function tryNormalizeEmail(
  input: unknown,
): { login: string; display: string } | null {
  try {
    return normalizeLoginEmail(input);
  } catch (error) {
    if (error instanceof InvalidEmailError) return null;
    throw error;
  }
}

/** Password policy plus the compromised-password port (fails closed). */
export async function newPasswordProblems(
  deps: CandidateAuthDependencies,
  password: unknown,
  confirmation: unknown,
): Promise<PasswordProblem[]> {
  const problems = checkNewPassword(password, confirmation);
  if (problems.length > 0) return problems;
  return (await deps.compromised.isCompromised(password as string))
    ? ["COMPROMISED"]
    : [];
}

const dummyHashes = new WeakMap<object, Promise<string>>();

/**
 * Spends the same password-verification work as a real sign-in or account
 * creation when no credential is checked, so response timing does not
 * reveal whether an account exists or is a candidate.
 */
export async function equalizePasswordWork(
  deps: CandidateAuthDependencies,
  password: string,
): Promise<void> {
  const ctx = await deps.auth.$context;
  let hash = dummyHashes.get(deps.auth);
  if (!hash) {
    hash = ctx.password.hash("TEST dummy timing-equalization passphrase");
    dummyHashes.set(deps.auth, hash);
  }
  await ctx.password.verify({ hash: await hash, password });
}

/** Set-Cookie values from a Better Auth response (never logged). */
export function setCookiesOf(response: Response): string[] {
  return response.headers.getSetCookie();
}

/** Lowercase, bounded string from untrusted form input. */
export function formString(value: unknown, max = 1024): string | undefined {
  return typeof value === "string" && value.length <= max ? value : undefined;
}

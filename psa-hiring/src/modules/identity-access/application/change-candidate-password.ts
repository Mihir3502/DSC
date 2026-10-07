import "server-only";
import type { PasswordProblem } from "../domain/candidate-registration-policy";
import { findAccountEmail } from "../infrastructure/account-repository";
import {
  defaultDependencies,
  formString,
  newPasswordProblems,
  setCookiesOf,
  type CandidateAuthDependencies,
} from "./candidate-auth-support";
import {
  authorizeAccountSelfService,
  correlationOf,
  refusalOf,
  selfServiceAction,
  type SelfServiceRefusal,
} from "./authorize-self-service";
import { resolveCurrentAccount } from "./current-account";

// Authenticated password change (packet M1.2 §13.1). Requires the current
// password, uses Better Auth's maintained change-password API, revokes every
// other session, and rotates the current one (new cookie). Recent-auth
// step-up and MFA are M1.3 and are not implemented here. M1.5: the
// CANDIDATE_PASSWORD_CHANGE self-service policy is evaluated first.

export type ChangePasswordResult =
  | Readonly<{ kind: "CHANGED"; setCookies: readonly string[] }>
  | Readonly<{ kind: "INVALID_INPUT"; password: readonly PasswordProblem[] }>
  | Readonly<{ kind: "CURRENT_PASSWORD_INVALID" }>
  | SelfServiceRefusal
  | Readonly<{ kind: "RATE_LIMITED" }>;

export async function changeCandidatePassword(
  input: Readonly<{
    currentPassword: unknown;
    password: unknown;
    passwordConfirmation: unknown;
  }>,
  headers: Headers,
  deps: CandidateAuthDependencies = defaultDependencies(),
): Promise<ChangePasswordResult> {
  const correlationId = correlationOf(headers);
  const principal = await resolveCurrentAccount(headers, deps);
  const decision = await authorizeAccountSelfService(
    principal,
    "CANDIDATE_PASSWORD_CHANGE",
    deps,
    { correlationId },
  );
  if (decision.decision === "DENY") return refusalOf(decision);
  if (!principal) return { kind: "UNAUTHENTICATED" };
  if (!deps.limiter.consume("changePasswordPerAccount", principal.accountId)) {
    deps.events.record({ code: "auth.rate_limited", category: "rate_limited" });
    return { kind: "RATE_LIMITED" };
  }
  const problems = await newPasswordProblems(
    deps,
    input.password,
    input.passwordConfirmation,
  );
  if (problems.length > 0) return { kind: "INVALID_INPUT", password: problems };
  const currentPassword = formString(input.currentPassword, 4096);
  if (!currentPassword) return { kind: "CURRENT_PASSWORD_INVALID" };

  const response = await deps.auth.api.changePassword({
    body: {
      currentPassword,
      newPassword: input.password as string,
      revokeOtherSessions: true,
    },
    headers,
    asResponse: true,
  });
  if (!response.ok) {
    deps.events.record({
      code: "auth.password_change_failed",
      category: "invalid_credentials",
      accountRef: principal.accountId,
    });
    return { kind: "CURRENT_PASSWORD_INVALID" };
  }

  const to = await findAccountEmail(deps.db, principal.accountId);
  if (to) deps.email.enqueue({ template: "PASSWORD_CHANGED", to });
  deps.events.record({
    code: "auth.password_changed",
    accountRef: principal.accountId,
    permissionCode: selfServiceAction("CANDIDATE_PASSWORD_CHANGE"),
    policyVersion: decision.policyVersion,
    correlationId,
  });
  return { kind: "CHANGED", setCookies: setCookiesOf(response) };
}

import "server-only";
import { canSignInInteractively } from "../domain/account-policy";
import { resolvePostAuthDestination } from "../domain/candidate-registration-policy";
import { clientKeyFrom } from "../infrastructure/action-rate-limiter";
import {
  activateVerifiedCandidate,
  findAccountByEmail,
} from "../infrastructure/account-repository";
import {
  commandLogger,
  defaultDependencies,
  equalizePasswordWork,
  formString,
  setCookiesOf,
  tryNormalizeEmail,
  type CandidateAuthDependencies,
} from "./candidate-auth-support";

// Candidate sign-in and sign-out (packet M1.2 §11, AC-M1.2-09). One generic
// failure covers unknown emails, wrong passwords, staff/service accounts at
// the candidate entry, and invited/unverified/restricted accounts. Sessions
// are created only by Better Auth, and only after the session-creation hook
// approves the account.

export type SignInCandidateResult =
  | Readonly<{
      kind: "SIGNED_IN";
      /** Same-origin path from the closed continuation registry. */
      destination: string;
      /** Set-Cookie values for the delivery layer; never logged. */
      setCookies: readonly string[];
    }>
  | Readonly<{ kind: "INVALID_CREDENTIALS" }>
  | Readonly<{ kind: "RATE_LIMITED" }>;

export async function signInCandidate(
  input: Readonly<{ email: unknown; password: unknown; next?: unknown }>,
  headers: Headers,
  deps: CandidateAuthDependencies = defaultDependencies(),
): Promise<SignInCandidateResult> {
  const log = commandLogger(deps);
  const password = formString(input.password, 4096) ?? "";
  const email = tryNormalizeEmail(input.email);
  const client = clientKeyFrom(headers);

  if (
    !deps.limiter.consume("signInPerClient", client) ||
    !deps.limiter.consume(
      "signInPerClientEmail",
      client,
      email?.login ?? "invalid",
    )
  ) {
    deps.events.record({ code: "auth.rate_limited", category: "rate_limited" });
    return { kind: "RATE_LIMITED" };
  }

  const fail = async (accountRef?: string): Promise<SignInCandidateResult> => {
    deps.events.record({
      code: "auth.sign_in_failed",
      category: "invalid_credentials",
      accountRef,
    });
    log.info("auth.sign_in_rejected", { resultCode: "invalid_credentials" });
    return { kind: "INVALID_CREDENTIALS" };
  };

  if (!email || password.length === 0) {
    await equalizePasswordWork(deps, password || "-");
    return fail();
  }

  let account = await findAccountByEmail(deps.db, email.login);
  if (!account || account.accountType !== "CANDIDATE") {
    // Staff and service accounts cannot sign in here (M1.3 owns staff
    // sign-in); they get the same work and response as an unknown email.
    await equalizePasswordWork(deps, password);
    return fail();
  }

  // Repair the approved transition if verification committed but the
  // follow-up activation did not (it is a conditional, idempotent UPDATE).
  if (account.status === "INVITED" && account.emailVerified) {
    if (await activateVerifiedCandidate(deps.db, account.id)) {
      account = await findAccountByEmail(deps.db, email.login);
      if (!account) return fail();
    }
  }
  if (!canSignInInteractively(account)) {
    await equalizePasswordWork(deps, password);
    return fail(account.id);
  }

  const response = await deps.auth.api.signInEmail({
    body: { email: email.login, password, rememberMe: true },
    headers,
    asResponse: true,
  });
  if (!response.ok) return fail(account.id);

  deps.events.record({
    code: "auth.sign_in_succeeded",
    accountRef: account.id,
  });
  return {
    kind: "SIGNED_IN",
    destination: resolvePostAuthDestination(input.next),
    setCookies: setCookiesOf(response),
  };
}

export type SignOutResult = Readonly<{ setCookies: readonly string[] }>;

/**
 * Revokes the current server session and clears the cookie. Repeating it,
 * or calling it without a session, is safe and returns the same result.
 */
export async function signOutCandidate(
  headers: Headers,
  deps: CandidateAuthDependencies = defaultDependencies(),
): Promise<SignOutResult> {
  let setCookies: string[] = [];
  try {
    const response = await deps.auth.api.signOut({ headers, asResponse: true });
    setCookies = setCookiesOf(response);
  } catch {
    // No or invalid session: nothing to revoke.
  }
  deps.events.record({ code: "auth.sign_out" });
  return { setCookies };
}

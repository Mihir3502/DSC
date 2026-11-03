import { randomUUID } from "node:crypto";
import { authorizationDependencies } from "@/modules/identity-access/application/authorization-support";
import {
  resolveCurrentAccount,
  type Principal,
} from "@/modules/identity-access/application/current-account";
import { signInCandidate } from "@/modules/identity-access/application/sign-in-candidate";
import type {
  CandidateActor,
  CandidateDependencies,
} from "@/modules/candidates/application/candidate-runtime";
import type { CandidateResult } from "@/modules/candidates/application/candidate-commands";
import { createTestAccount, TEST_PASSWORD } from "../../fixtures/auth/accounts";
import { CookieJar } from "../../fixtures/auth/cookie-jar";
import { headers, type AuthorizationHarness } from "./authorization";

// M2.2 candidate integration support: real verified candidate accounts and
// sessions, signed start-application handoffs, and dependencies wired to
// the production authorization adapters. Synthetic data only.

export function candidateDeps(
  h: AuthorizationHarness,
  overrides: Partial<CandidateDependencies> = {},
): CandidateDependencies {
  return {
    ...authorizationDependencies(h.runtime),
    bootstrap: h.runtime.assignmentHarness,
    limiter: h.runtime.limiter,
    ...overrides,
  };
}

export type CandidateSession = Readonly<{
  email: string;
  accountId: string;
  jar: CookieJar;
  principal: Principal;
  actor: CandidateActor;
}>;

export async function candidateSession(
  h: AuthorizationHarness,
  options: Readonly<{ email?: string; emailVerified?: boolean }> = {},
): Promise<CandidateSession> {
  const account = await createTestAccount(h.runtime.auth, {
    accountType: "CANDIDATE",
    emailVerified: options.emailVerified ?? true,
    ...(options.email ? { email: options.email } : {}),
  });
  const signed = await signInCandidate(
    { email: account.email, password: TEST_PASSWORD, next: undefined },
    headers(),
    h.runtime,
  );
  const jar = new CookieJar();
  if (signed.kind === "SIGNED_IN") jar.apply(signed.setCookies);
  const principal = await resolveCurrentAccount(headers(jar), h.runtime);
  if (!principal) throw new Error("no candidate principal");
  return {
    email: account.email,
    accountId: account.id,
    jar,
    principal,
    actor: { kind: "CANDIDATE", principal },
  };
}

export const handoffFor = (h: AuthorizationHarness, publicReference: string) =>
  h.runtime.intents.issueApplicationHandoff(publicReference);

export const ckey = () => randomUUID();

export function outcome(result: CandidateResult): string {
  return result.kind === "DONE" || result.kind === "UNCHANGED"
    ? result.outcome
    : result.kind === "REFUSED"
      ? result.reason
      : "INVALID_INPUT";
}

import "server-only";
import {
  defaultDependencies,
  tryNormalizeEmail,
  type CandidateAuthDependencies,
} from "./candidate-auth-support";
import { APPLICATION_HANDOFF_TTL_SECONDS } from "../infrastructure/registration-intent-repository";

// Registration-intent issuance (packet M1.2 §6.2). The public form receives
// a signed, short-lived PUBLIC_POSITION intent. Candidate invitations are
// issued server-side only; staff issuance arrives with M1.3+ authorization,
// so for now the only callers are tests and the local-only script.

/** A fresh signed public intent for the /register page. */
export function issuePublicRegistrationIntent(
  deps: CandidateAuthDependencies = defaultDependencies(),
): string {
  return deps.intents.issuePublic();
}

/**
 * Issues a single-use invitation bound to the normalized email and returns
 * the registration link (capability in the fragment only). Server-only:
 * never expose this through a route until M1.4/M1.5 authorization exists.
 */
export async function issueCandidateInvitation(
  email: string,
  deps: CandidateAuthDependencies = defaultDependencies(),
): Promise<string> {
  const normalized = tryNormalizeEmail(email);
  if (!normalized) throw new Error("invalid invitation email");
  const token = await deps.intents.issueInvitation(normalized.login);
  return `${new URL(deps.env.BETTER_AUTH_URL).origin}/register#intent=${token}`;
}

/** Cookie that carries the M2.1 start-application handoff (never a URL). */
export function applicationHandoffCookie(
  deps: CandidateAuthDependencies = defaultDependencies(),
) {
  const secure = deps.env.secureCookies;
  return Object.freeze({
    name: `${secure ? "__Secure-" : ""}psa.application_handoff`,
    secure,
    maxAgeSeconds: APPLICATION_HANDOFF_TTL_SECONDS,
  });
}

/** A signed handoff for a hiring cycle the caller already found accepting. */
export function issueApplicationHandoff(
  publicReference: string,
  deps: CandidateAuthDependencies = defaultDependencies(),
): string {
  return deps.intents.issueApplicationHandoff(publicReference);
}

/** The public reference bound to a valid, unexpired handoff, or null. */
export function verifyApplicationHandoff(
  token: unknown,
  deps: CandidateAuthDependencies = defaultDependencies(),
): string | null {
  return deps.intents.verifyApplicationHandoff(token);
}

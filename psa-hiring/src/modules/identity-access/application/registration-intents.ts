import "server-only";
import {
  defaultDependencies,
  tryNormalizeEmail,
  type CandidateAuthDependencies,
} from "./candidate-auth-support";

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

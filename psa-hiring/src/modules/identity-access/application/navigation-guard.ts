import "server-only";
import { resolveCurrentAccount } from "./current-account";
import {
  defaultDependencies,
  type CandidateAuthDependencies,
} from "./candidate-auth-support";

// Route-group navigation guards (packet M1.5 §8). Convenience only:
//
// - They let an ineligible browser fail early: no principal → sign in; a
//   principal of the other audience (or a service account) → the same
//   safe not-found as an unknown page.
// - They return a navigation hint, never an authorization result. Nothing
//   they compute is passed to, cached for, or trusted by the page, query,
//   or action behind them, each of which resolves the principal again and
//   calls the application authorization boundary itself.
// - They resolve silently and emit no events, so a request rejected by the
//   guard and the page produces one denial record, not two.
// - They read no business or restricted data.

export type NavigationAudience = "CANDIDATE" | "STAFF";

export type NavigationHint = "PROCEED" | "SIGN_IN" | "HIDDEN";

export async function navigationHint(
  headers: Headers,
  audience: NavigationAudience,
  deps: CandidateAuthDependencies = defaultDependencies(),
): Promise<NavigationHint> {
  const principal = await resolveCurrentAccount(headers, deps, {
    silent: true,
  });
  if (!principal) return "SIGN_IN";
  if (principal.accountType !== audience) return "HIDDEN";
  if (audience === "CANDIDATE" && !principal.emailVerified) return "SIGN_IN";
  return "PROCEED";
}

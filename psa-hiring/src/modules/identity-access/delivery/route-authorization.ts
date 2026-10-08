import "server-only";
import { cookies, headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import {
  SAFE_DEFAULT_DESTINATION,
  safeDestination,
} from "@/shared/security/safe-redirect";
import {
  navigationHint,
  type NavigationAudience,
} from "../application/navigation-guard";
import {
  outcomeForResult,
  type ApplicationResultKind,
  type DeliveryOutcome,
} from "./authorization-error-mapper";

// Next.js delivery adapters for pages, layouts, and Server Actions (packet
// M1.5 §8, §17, ADR-0011). Thin: they translate typed outcomes into
// redirect/not-found behavior and never decide authorization themselves.

const signInFor: Readonly<Record<NavigationAudience, string>> = {
  CANDIDATE: "/sign-in",
  STAFF: "/staff/sign-in",
};

/**
 * Route-group guard for a candidate/staff layout. Navigation convenience
 * only (see application/navigation-guard.ts): the page below must still
 * call its application query, which authorizes again.
 */
export async function guardNavigation(
  audience: NavigationAudience,
): Promise<void> {
  const hint = await navigationHint(await liveRequestHeaders(), audience);
  if (hint === "SIGN_IN") safeRedirect(signInFor[audience]);
  if (hint === "HIDDEN") notFound();
}

/**
 * Request headers whose Cookie header reflects the live cookie store, so a
 * render in the same Server Action request (for example after a password
 * change rotated the session) sees the new session, as pages do.
 */
async function liveRequestHeaders(): Promise<Headers> {
  const result = new Headers(await headers());
  const cookie = (await cookies()).toString();
  if (cookie) result.set("cookie", cookie);
  else result.delete("cookie");
  return result;
}

/** Redirects only to an exact registered destination (else the root). */
export function safeRedirect(destination: string): never {
  redirect(safeDestination(destination, SAFE_DEFAULT_DESTINATION));
}

/** Where a staff step-up continues for the current M1 surfaces. */
const reauthenticationFor = "/staff/reauthenticate?purpose=CHANGE_PASSWORD";

/**
 * Enforces a denial outcome for a page or Server Action of the given
 * audience: sign in, safe not-found, or the allowlisted reauthentication
 * page. Outcomes that render an in-page state (validation, conflict, rate
 * limit, forbidden, system error) are returned to the caller instead.
 */
export function enforceAccessOutcome(
  outcome: DeliveryOutcome,
  audience: NavigationAudience,
): Exclude<
  DeliveryOutcome,
  {
    kind: "AUTHENTICATION_REQUIRED" | "NOT_FOUND" | "REAUTHENTICATION_REQUIRED";
  }
> {
  switch (outcome.kind) {
    case "AUTHENTICATION_REQUIRED":
      return safeRedirect(signInFor[audience]);
    case "NOT_FOUND":
      return notFound();
    case "REAUTHENTICATION_REQUIRED":
      return audience === "STAFF"
        ? safeRedirect(reauthenticationFor)
        : notFound();
    default:
      return outcome;
  }
}

/**
 * Terminal refusal for an M2.1 configuration page or action: a required
 * step-up continues on the reauthentication page for the configuration
 * purpose (ADR-0005 note); every other outcome is refuseAccess.
 */
export function refuseConfigurationAccess(kind: ApplicationResultKind): never {
  if (kind === "REAUTHENTICATION_REQUIRED") {
    safeRedirect("/staff/reauthenticate?purpose=CONFIGURATION_CHANGE");
  }
  return refuseAccess(kind, "STAFF");
}

/**
 * Terminal refusal for a page or Server Action: the application result is
 * mapped through the single outcome mapper and enforced; any outcome that
 * has no in-page state here falls back to the safe not-found.
 */
export function refuseAccess(
  kind: ApplicationResultKind,
  audience: NavigationAudience,
): never {
  enforceAccessOutcome(outcomeForResult(kind), audience);
  notFound();
}

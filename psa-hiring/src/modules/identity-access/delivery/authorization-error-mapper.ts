import type { PublicErrorCode } from "@/shared/errors";
import type { DenyDecision } from "../domain/authorization-decision";
import type { DenialReason } from "../domain/authorization-vocabulary";
import type { SelfServiceDeny } from "../domain/self-service-policy";

// One typed mapping from internal outcomes to external behavior (packet
// M1.5 §17.1, ADR-0011). Pure. Page, Server Action, Route Handler, file,
// search, job, and provider adapters all use it, so the same internal
// outcome always produces the same safe external result.
//
// Internal M1.4/self-service reason codes stay internal: the external
// result carries none of them, nor any assignment, scope, policy fact,
// resource state, owner, or role.

export type DeliveryOutcome =
  | Readonly<{ kind: "AUTHENTICATION_REQUIRED" }>
  /** Wrong audience, hidden, unknown, wrong-scope, or invalid identifier. */
  | Readonly<{ kind: "NOT_FOUND" }>
  /** Only when the caller may already know the resource exists. */
  | Readonly<{ kind: "FORBIDDEN" }>
  | Readonly<{ kind: "REAUTHENTICATION_REQUIRED" }>
  | Readonly<{ kind: "INVALID_INPUT" }>
  | Readonly<{ kind: "CONFLICT" }>
  | Readonly<{ kind: "RATE_LIMITED" }>
  | Readonly<{ kind: "SYSTEM_ERROR" }>;

/**
 * Whether the caller already knows the resource exists. Only a resource
 * the caller is itself entitled to see (for example its own account, or a
 * record it just viewed under the same decision) is KNOWN; everything
 * else is UNKNOWN and every non-authentication denial becomes NOT_FOUND.
 */
export type ExistenceKnowledge = "KNOWN" | "UNKNOWN";

const authenticationReasons = new Set<DenialReason>([
  "UNAUTHENTICATED",
  "ACCOUNT_INACTIVE",
]);

/** Maps an M1.4 or self-service denial. */
export function outcomeForDenial(
  decision: Pick<DenyDecision | SelfServiceDeny, "reasonCode">,
  existence: ExistenceKnowledge,
): DeliveryOutcome {
  if (authenticationReasons.has(decision.reasonCode)) {
    return { kind: "AUTHENTICATION_REQUIRED" };
  }
  if (existence === "UNKNOWN") return { kind: "NOT_FOUND" };
  if (decision.reasonCode === "RECENT_AUTH_REQUIRED") {
    return { kind: "REAUTHENTICATION_REQUIRED" };
  }
  return { kind: "FORBIDDEN" };
}

/** Application result kinds used by the current M1 commands/queries. */
export type ApplicationResultKind =
  | "UNAUTHENTICATED"
  | "NOT_PERMITTED"
  | "REAUTHENTICATION_REQUIRED"
  | "NOT_FOUND"
  | "INVALID_INPUT"
  | "CONFLICT"
  | "RATE_LIMITED";

export function outcomeForResult(kind: ApplicationResultKind): DeliveryOutcome {
  switch (kind) {
    case "UNAUTHENTICATED":
      return { kind: "AUTHENTICATION_REQUIRED" };
    // A wrong-audience or unavailable self-service policy is a hidden
    // surface, indistinguishable from an unknown route.
    case "NOT_PERMITTED":
    case "NOT_FOUND":
      return { kind: "NOT_FOUND" };
    case "REAUTHENTICATION_REQUIRED":
      return { kind: "REAUTHENTICATION_REQUIRED" };
    case "INVALID_INPUT":
      return { kind: "INVALID_INPUT" };
    case "CONFLICT":
      return { kind: "CONFLICT" };
    case "RATE_LIMITED":
      return { kind: "RATE_LIMITED" };
  }
}

/** JSON/action status and stable public code for an outcome. */
export function publicCodeForOutcome(
  outcome: DeliveryOutcome,
): PublicErrorCode {
  switch (outcome.kind) {
    case "AUTHENTICATION_REQUIRED":
      return "UNAUTHENTICATED";
    case "NOT_FOUND":
      return "NOT_FOUND";
    case "FORBIDDEN":
      return "FORBIDDEN";
    case "REAUTHENTICATION_REQUIRED":
      return "REAUTHENTICATION_REQUIRED";
    case "INVALID_INPUT":
      return "VALIDATION_FAILED";
    case "CONFLICT":
      return "CONFLICT";
    case "RATE_LIMITED":
      return "RATE_LIMITED";
    case "SYSTEM_ERROR":
      return "INTERNAL_ERROR";
  }
}

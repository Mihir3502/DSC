import type {
  AuthorizationDecision,
  AuthorizationRequest,
  DenyDecision,
  WorkflowFacts,
} from "../../domain/authorization-decision";
import {
  isUuid,
  type Operation,
  type SensitivityLevel,
} from "../../domain/authorization-vocabulary";
import type { SeparationFacts } from "../../domain/separation-of-duties-policy";

// Minimal resource authorization envelope (packet M1.5 §10, ADR-0011).
//
// Owning modules (M2+) implement EnvelopeSource with a dedicated query that
// selects only these authorization facts by opaque ID, never the record's
// payload or restricted columns. The object-authorization pattern is:
//
//   validate opaque ID → load envelope → authorize (M1.4) → only then load
//   the explicit authorized projection.
//
// Invalid ID format, unknown ID, wrong resource type, soft-hidden record,
// and any authorization denial all produce the same NOT_FOUND result for
// the caller; only the internal reason (for telemetry/future audit)
// differs. No envelope field is ever returned to a browser.

export type ResourceEnvelope = Readonly<{
  id: string;
  resourceType: string;
  sensitivity: SensitivityLevel;
  /** Soft-hidden/withdrawn/archived from this audience. */
  hidden: boolean;
  /** Closed workflow facts from the owning domain, when its policy needs them. */
  workflow?: WorkflowFacts;
  /** Creator/proposer/subject/approver facts for separation rules. */
  separation?: SeparationFacts;
  /** Optimistic-concurrency version, rechecked at the command boundary. */
  version: number;
}>;

export interface EnvelopeSource {
  /** Minimal envelope by opaque ID; null when it does not exist. */
  loadEnvelope(id: string): Promise<ResourceEnvelope | null>;
}

export type EnvelopeAccessRequest = Readonly<{
  principal: Readonly<{
    accountId: string;
    accountType: string;
    sessionId: string;
  }> | null;
  /** Untrusted opaque identifier from the URL/body. */
  resourceId: unknown;
  /** The resource type the route expects (server constant). */
  resourceType: string;
  /** Server-chosen permission for this exact query/command. */
  permission: string;
  operation: Operation;
  correlationId?: string;
}>;

/** Internal refusal reasons (never shown to the caller). */
export type EnvelopeRefusal =
  "INVALID_ID" | "UNKNOWN_ID" | "WRONG_TYPE" | "HIDDEN" | "DENIED";

export type EnvelopeAccessResult =
  | Readonly<{ kind: "AUTHORIZED"; envelope: ResourceEnvelope }>
  | Readonly<{
      kind: "NOT_FOUND";
      internal: EnvelopeRefusal;
      decision?: DenyDecision;
    }>
  /** Sign in again: the session itself is not eligible. */
  | Readonly<{ kind: "UNAUTHENTICATED" }>;

/** The M1.4 decision function (authorize bound to its dependencies). */
export type Authorizer = (
  request: AuthorizationRequest,
) => Promise<AuthorizationDecision>;

export async function authorizeEnvelopeAccess(
  request: EnvelopeAccessRequest,
  source: EnvelopeSource,
  decide: Authorizer,
): Promise<EnvelopeAccessResult> {
  const notFound = (internal: EnvelopeRefusal, decision?: DenyDecision) =>
    Object.freeze({ kind: "NOT_FOUND" as const, internal, decision });
  if (!request.principal) return { kind: "UNAUTHENTICATED" };
  if (!isUuid(request.resourceId)) return notFound("INVALID_ID");
  const envelope = await source.loadEnvelope(request.resourceId);
  if (!envelope || envelope.id !== request.resourceId) {
    return notFound("UNKNOWN_ID");
  }
  if (envelope.resourceType !== request.resourceType) {
    return notFound("WRONG_TYPE");
  }
  if (envelope.hidden) return notFound("HIDDEN");
  const decision = await decide({
    principal: request.principal,
    permission: request.permission,
    operation: request.operation,
    resource: {
      kind: "RECORD",
      id: envelope.id,
      sensitivity: envelope.sensitivity,
    },
    ...(envelope.workflow ? { workflow: envelope.workflow } : {}),
    ...(envelope.separation ? { separation: envelope.separation } : {}),
    ...(request.correlationId ? { correlationId: request.correlationId } : {}),
  });
  if (decision.decision === "ALLOW") {
    return Object.freeze({ kind: "AUTHORIZED", envelope });
  }
  if (
    decision.reasonCode === "UNAUTHENTICATED" ||
    decision.reasonCode === "ACCOUNT_INACTIVE"
  ) {
    return { kind: "UNAUTHENTICATED" };
  }
  return notFound("DENIED", decision);
}

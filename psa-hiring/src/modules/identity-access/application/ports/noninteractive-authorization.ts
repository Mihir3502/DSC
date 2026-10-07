import { isUuid } from "../../domain/authorization-vocabulary";

// Enforcement contract for noninteractive callers (packet M1.5 §16,
// ADR-0011). M1 has no background job or provider callback; later
// milestones implement these ports. Production registries are empty, so
// every service operation and callback denies until a reviewed entry and
// a real adapter exist.
//
// - A service principal is noninteractive, purpose bound, and narrowly
//   permissioned by a reviewed registry entry; it never uses interactive
//   pages or self-service policies, and SERVICE accounts never resolve an
//   interactive principal (M1.1).
// - A job payload never carries authority. Its fields are an exact,
//   reviewed allowlist of opaque references; any role, scope, permission,
//   actor, impersonation, field-selection, or projection key rejects the
//   job, so an end user's identity cannot be replayed through a queue.
// - Jobs reload current configuration and authority immediately before
//   protected work and fail closed after revocation (`isRevoked`).
// - A provider callback first authenticates the provider independently
//   (signature/timestamp/replay, implemented by the adapter), then the
//   affected application operation is authorized on its own resource
//   loaded server-side. Provider-supplied IDs, events, and states are
//   untrusted input.

export type ServicePrincipal = Readonly<{
  kind: "SERVICE";
  /** Reviewed service code, e.g. a future outbox worker. */
  serviceCode: string;
  purpose: string;
}>;

export type ServiceOperationGrant = Readonly<{
  serviceCode: string;
  purpose: string;
  /** The exact application operation this service may run. */
  operation: string;
}>;

/** Reviewed service grants; empty until a job type is approved. */
export const productionServiceGrants: readonly ServiceOperationGrant[] =
  Object.freeze([]);

export type ServiceDecision =
  | Readonly<{ decision: "ALLOW"; operation: string }>
  | Readonly<{
      decision: "DENY";
      reasonCode: "UNKNOWN_SERVICE" | "PURPOSE_MISMATCH" | "REVOKED";
    }>;

export type ServiceAuthorizationDependencies = Readonly<{
  grants: readonly ServiceOperationGrant[];
  /** Reloaded current state: is this service/configuration revoked now? */
  isRevoked: (serviceCode: string) => Promise<boolean>;
}>;

export async function authorizeServiceOperation(
  principal: ServicePrincipal,
  operation: string,
  deps: ServiceAuthorizationDependencies,
): Promise<ServiceDecision> {
  const grant = deps.grants.find(
    (g) => g.serviceCode === principal.serviceCode && g.operation === operation,
  );
  if (!grant) return { decision: "DENY", reasonCode: "UNKNOWN_SERVICE" };
  if (grant.purpose !== principal.purpose) {
    return { decision: "DENY", reasonCode: "PURPOSE_MISMATCH" };
  }
  if (await deps.isRevoked(principal.serviceCode)) {
    return { decision: "DENY", reasonCode: "REVOKED" };
  }
  return { decision: "ALLOW", operation };
}

/** Keys that would carry authority or field selection: always rejected. */
export const forbiddenPayloadKeys: readonly string[] = Object.freeze([
  "actor",
  "actorId",
  "actorRole",
  "role",
  "roles",
  "roleCode",
  "scope",
  "scopes",
  "permission",
  "permissions",
  "impersonate",
  "onBehalfOf",
  "accountType",
  "status",
  "fields",
  "select",
  "include",
  "projection",
  "policy",
  "assurance",
  "decision",
]);

export type JobPayloadSpec = Readonly<{
  /** Exact allowlist: each key is an opaque UUID reference. */
  references: readonly string[];
  /** Exact allowlist of closed code fields with their allowed values. */
  codes?: Readonly<Record<string, readonly string[]>>;
}>;

export type ParsedJobPayload =
  | Readonly<{ kind: "ACCEPTED"; values: Readonly<Record<string, string>> }>
  | Readonly<{
      kind: "REJECTED";
      reason:
        "NOT_AN_OBJECT" | "FORBIDDEN_KEY" | "UNKNOWN_KEY" | "INVALID_VALUE";
    }>;

export function parseJobPayload(
  payload: unknown,
  spec: JobPayloadSpec,
): ParsedJobPayload {
  if (
    typeof payload !== "object" ||
    payload === null ||
    Array.isArray(payload) ||
    Object.getPrototypeOf(payload) !== Object.prototype
  ) {
    return { kind: "REJECTED", reason: "NOT_AN_OBJECT" };
  }
  const values: Record<string, string> = {};
  const forbidden = new Set(forbiddenPayloadKeys.map((k) => k.toLowerCase()));
  for (const [key, value] of Object.entries(payload)) {
    if (forbidden.has(key.toLowerCase())) {
      return { kind: "REJECTED", reason: "FORBIDDEN_KEY" };
    }
    if (spec.references.includes(key)) {
      if (!isUuid(value)) return { kind: "REJECTED", reason: "INVALID_VALUE" };
      values[key] = value;
      continue;
    }
    const allowed =
      spec.codes && Object.hasOwn(spec.codes, key)
        ? spec.codes[key]
        : undefined;
    if (!allowed) return { kind: "REJECTED", reason: "UNKNOWN_KEY" };
    if (typeof value !== "string" || !allowed.includes(value)) {
      return { kind: "REJECTED", reason: "INVALID_VALUE" };
    }
    values[key] = value;
  }
  return { kind: "ACCEPTED", values: Object.freeze(values) };
}

/** Implemented per provider (signature, timestamp, replay protection). */
export interface ProviderCallbackAuthenticator {
  authenticate(
    request: Request,
  ): Promise<Readonly<{ providerCode: string; eventId: string }> | null>;
}

/** Authorizes the affected operation on a server-loaded resource. */
export type CallbackOperationAuthorizer = (
  providerCode: string,
  payload: Readonly<Record<string, string>>,
) => Promise<"ALLOW" | "DENY">;

export type ProviderCallbackResult =
  | Readonly<{ kind: "ACCEPTED"; values: Readonly<Record<string, string>> }>
  /** Unauthenticated provider: generic 401, nothing processed. */
  | Readonly<{ kind: "UNAUTHENTICATED" }>
  /** Authenticated provider, unusable or unauthorized payload: generic 404. */
  | Readonly<{ kind: "REJECTED" }>;

export async function authorizeProviderCallback(
  request: Request,
  body: unknown,
  spec: JobPayloadSpec,
  authenticator: ProviderCallbackAuthenticator,
  authorizeOperation: CallbackOperationAuthorizer,
): Promise<ProviderCallbackResult> {
  const provider = await authenticator.authenticate(request);
  if (!provider) return { kind: "UNAUTHENTICATED" };
  const parsed = parseJobPayload(body, spec);
  if (parsed.kind === "REJECTED") return { kind: "REJECTED" };
  const verdict = await authorizeOperation(
    provider.providerCode,
    parsed.values,
  );
  return verdict === "ALLOW"
    ? { kind: "ACCEPTED", values: parsed.values }
    : { kind: "REJECTED" };
}

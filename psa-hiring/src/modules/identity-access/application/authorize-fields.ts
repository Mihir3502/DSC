import "server-only";
import type {
  AuthorizationDecision,
  AuthorizationRequest,
} from "../domain/authorization-decision";
import type {
  Operation,
  SensitivityLevel,
} from "../domain/authorization-vocabulary";
import {
  project,
  type ProjectionContract,
  type ProjectionResult,
} from "../presentation/authorized-projector";
import {
  permissionsReferenced,
  sensitivityForPermission,
  type FieldRule,
  type ProjectionAudience,
} from "../presentation/field-policy";

// Field authorization for one resource (packet M1.5 §12, ADR-0011).
//
// For each distinct permission a contract's field rules can consult, the
// M1.4 service is asked whether the principal holds it for THIS resource
// now (scope, sensitivity, workflow, separation, recent authentication all
// apply). The resulting set of allowed codes is the only input to the pure
// field policy; nothing comes from the request. The resource-level read
// permission must already have been allowed by the caller.

export type FieldAuthorizationRequest = Readonly<{
  principal: AuthorizationRequest["principal"];
  audience: ProjectionAudience;
  resource: Readonly<{ id: string; sensitivity: SensitivityLevel }>;
  /** Operation of each field permission (read-type permissions only). */
  operation?: Extract<Operation, "READ">;
  /** Server-chosen safe purpose for permissions that require one. */
  purposeCode?: string;
  correlationId?: string;
}>;

export async function authorizeFields(
  rules: readonly FieldRule[],
  request: FieldAuthorizationRequest,
  decide: (request: AuthorizationRequest) => Promise<AuthorizationDecision>,
): Promise<ReadonlySet<string>> {
  const allowed = new Set<string>();
  // One decision per (permission, representation classification).
  const checks = new Map<string, SensitivityLevel>();
  for (const rule of rules) {
    for (const permission of permissionsReferenced([rule])) {
      const level = sensitivityForPermission(rule, permission);
      if (level) checks.set(`${permission}|${level}`, level);
    }
  }
  const results = new Map<string, boolean>();
  for (const [key, level] of checks) {
    const permission = key.slice(0, key.indexOf("|"));
    const decision = await decide({
      principal: request.principal,
      permission,
      operation: request.operation ?? "READ",
      resource: { kind: "RECORD", id: request.resource.id, sensitivity: level },
      ...(request.purposeCode ? { reasonCode: request.purposeCode } : {}),
      ...(request.correlationId
        ? { correlationId: request.correlationId }
        : {}),
    });
    results.set(key, decision.decision === "ALLOW");
  }
  // A permission counts only if it was allowed at every classification
  // where a rule uses it (never the most permissive one).
  for (const permission of permissionsReferenced(rules)) {
    const keys = [...checks.keys()].filter((k) =>
      k.startsWith(`${permission}|`),
    );
    if (keys.length > 0 && keys.every((k) => results.get(k) === true)) {
      allowed.add(permission);
    }
  }
  return allowed;
}

/** Authorizes a contract's fields for the resource, then projects it. */
export async function projectAuthorized<S, O extends object>(
  contract: ProjectionContract<S, O>,
  source: S,
  request: FieldAuthorizationRequest,
  decide: (request: AuthorizationRequest) => Promise<AuthorizationDecision>,
): Promise<ProjectionResult<O>> {
  const rules = Object.values(contract.fields).map(
    (f) => (f as { rule: FieldRule }).rule,
  );
  const allowed = await authorizeFields(rules, request, decide);
  return project(contract, source, {
    audience: request.audience,
    purpose: contract.purpose,
    allowed,
  });
}

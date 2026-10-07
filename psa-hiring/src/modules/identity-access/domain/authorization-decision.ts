import {
  isHoldCategory,
  isOperation,
  isScopeType,
  isSensitivityLevel,
  isUuid,
  workflowPolicyCodes,
  type DenialReason,
  type HoldCategory,
  type Operation,
  type RoleCode,
  type ScopeType,
  type SensitivityLevel,
  type WorkflowPolicyCode,
} from "./authorization-vocabulary";
import type { SeparationFacts } from "./separation-of-duties-policy";

// Framework-neutral authorization request/decision contracts (packet M1.4
// §11, ADR-0005). The request carries only server-owned identity and typed
// facts from the owning domain. It cannot carry roles, permissions grants,
// scopes, membership, approvers, account status, assurance, policy
// versions, or a decision: unknown keys make the request invalid, so a
// client-supplied claim can never even be read.

/** The server-resolved principal (from resolveCurrentAccount). */
export type AuthorizationPrincipal = Readonly<{
  accountId: string;
  accountType: string;
  sessionId: string;
}>;

export type AuthorizationResource =
  /** A business record, placed by the owning module's resolver. */
  | Readonly<{ kind: "RECORD"; id: string; sensitivity: SensitivityLevel }>
  /** An administrative target that is itself a scope. */
  | Readonly<{
      kind: "SCOPE";
      scopeType: ScopeType;
      id: string;
      sensitivity: SensitivityLevel;
    }>;

export type WorkflowFacts = Readonly<{
  policy: WorkflowPolicyCode;
  /** Closed state value supplied by the owning domain. */
  state: string;
  transition?: string;
}>;

export type AuthorizationRequest = Readonly<{
  principal: AuthorizationPrincipal | null;
  permission: string;
  operation: Operation;
  resource: AuthorizationResource;
  workflow?: WorkflowFacts;
  separation?: SeparationFacts;
  holdCategory?: HoldCategory;
  elevation?: "NONE" | "BREAK_GLASS";
  /** Safe purpose/reason code when the permission requires one. */
  reasonCode?: string;
  correlationId?: string;
}>;

export type AllowDecision = Readonly<{
  decision: "ALLOW";
  permissionCode: string;
  effectiveRoleCode: RoleCode;
  /** Staff only; null for the candidate ownership relationship. */
  effectiveAssignmentId: string | null;
  effectiveScopeType: ScopeType | null;
  effectiveScopeReferenceId: string | null;
  policyVersion: string;
  reasonCode: "ALLOWED";
}>;

export type DenyDecision = Readonly<{
  decision: "DENY";
  /** The requested code if it is a catalog code, otherwise "unknown". */
  permissionCode: string;
  policyVersion: string;
  reasonCode: DenialReason;
  /** Present for RECENT_AUTH_REQUIRED so M1.5 can offer a step-up. */
  challenge?: "REAUTHENTICATION_REQUIRED" | "STRONGER_METHOD_REQUIRED";
}>;

export type AuthorizationDecision = AllowDecision | DenyDecision;

const requestKeys = new Set([
  "principal",
  "permission",
  "operation",
  "resource",
  "workflow",
  "separation",
  "holdCategory",
  "elevation",
  "reasonCode",
  "correlationId",
]);
const recordKeys = new Set(["kind", "id", "sensitivity"]);
const scopeKeys = new Set(["kind", "scopeType", "id", "sensitivity"]);
const workflowKeys = new Set(["policy", "state", "transition"]);
const separationKeys = new Set([
  "proposerAccountId",
  "resultEnteredByAccountId",
  "changedByAccountIds",
  "priorApproverAccountIds",
  "evaluationSigned",
  "documentedActorAccountIds",
]);

export const stateTokenPattern = /^[A-Z][A-Z0-9_]{0,63}$/;
export const reasonCodePattern = /^[A-Z][A-Z0-9_]{1,63}$/;

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" &&
  v !== null &&
  !Array.isArray(v) &&
  Object.getPrototypeOf(v) === Object.prototype;

const onlyKeys = (v: Record<string, unknown>, keys: Set<string>) =>
  Object.keys(v).every((k) => keys.has(k));

const isIdList = (v: unknown) => Array.isArray(v) && v.every(isUuid);

function validResource(v: unknown): boolean {
  if (!isPlainObject(v) || !isUuid(v.id) || !isSensitivityLevel(v.sensitivity))
    return false;
  if (v.kind === "RECORD") return onlyKeys(v, recordKeys);
  if (v.kind === "SCOPE")
    return onlyKeys(v, scopeKeys) && isScopeType(v.scopeType);
  return false;
}

function validSeparation(v: unknown): boolean {
  if (!isPlainObject(v) || !onlyKeys(v, separationKeys)) return false;
  return (
    (v.proposerAccountId === undefined || isUuid(v.proposerAccountId)) &&
    (v.resultEnteredByAccountId === undefined ||
      isUuid(v.resultEnteredByAccountId)) &&
    (v.changedByAccountIds === undefined || isIdList(v.changedByAccountIds)) &&
    (v.priorApproverAccountIds === undefined ||
      isIdList(v.priorApproverAccountIds)) &&
    (v.evaluationSigned === undefined ||
      typeof v.evaluationSigned === "boolean") &&
    (v.documentedActorAccountIds === undefined ||
      isIdList(v.documentedActorAccountIds))
  );
}

function validWorkflow(v: unknown): boolean {
  return (
    isPlainObject(v) &&
    onlyKeys(v, workflowKeys) &&
    (workflowPolicyCodes as readonly unknown[]).includes(v.policy) &&
    typeof v.state === "string" &&
    stateTokenPattern.test(v.state) &&
    (v.transition === undefined ||
      (typeof v.transition === "string" &&
        stateTokenPattern.test(v.transition)))
  );
}

/**
 * Structural validation of a request. A malformed request, or one carrying
 * any key outside the contract (for example `roles`, `scopes`, `isAdmin`,
 * `assurance`, `decision`), is INVALID_CONTEXT and denies.
 */
export function isWellFormedRequest(request: unknown): boolean {
  if (!isPlainObject(request) || !onlyKeys(request, requestKeys)) return false;
  const r = request;
  if (typeof r.permission !== "string" || !isOperation(r.operation)) {
    return false;
  }
  if (!validResource(r.resource)) return false;
  if (r.workflow !== undefined && !validWorkflow(r.workflow)) return false;
  if (r.separation !== undefined && !validSeparation(r.separation))
    return false;
  if (r.holdCategory !== undefined && !isHoldCategory(r.holdCategory)) {
    return false;
  }
  if (
    r.elevation !== undefined &&
    r.elevation !== "NONE" &&
    r.elevation !== "BREAK_GLASS"
  ) {
    return false;
  }
  if (
    r.reasonCode !== undefined &&
    (typeof r.reasonCode !== "string" || !reasonCodePattern.test(r.reasonCode))
  ) {
    return false;
  }
  if (r.correlationId !== undefined && typeof r.correlationId !== "string") {
    return false;
  }
  if (r.principal !== null) {
    const p = r.principal;
    if (
      typeof p !== "object" ||
      p === null ||
      !isUuid((p as Record<string, unknown>).accountId) ||
      !isUuid((p as Record<string, unknown>).sessionId) ||
      typeof (p as Record<string, unknown>).accountType !== "string"
    ) {
      return false;
    }
  }
  return true;
}

export function deny(
  permissionCode: string,
  policyVersion: string,
  reasonCode: DenialReason,
  challenge?: DenyDecision["challenge"],
): DenyDecision {
  return Object.freeze({
    decision: "DENY",
    permissionCode,
    policyVersion,
    reasonCode,
    ...(challenge ? { challenge } : {}),
  });
}

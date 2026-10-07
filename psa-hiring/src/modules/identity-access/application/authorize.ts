import "server-only";
import type { Database } from "@/shared/database";
import type { AppLogger } from "@/shared/logging";
import {
  evaluateAssurance,
  type AssuranceEvidence,
} from "../domain/authentication-assurance";
import {
  deny,
  isWellFormedRequest,
  reasonCodePattern,
  type AllowDecision,
  type AuthorizationDecision,
  type AuthorizationPrincipal,
  type AuthorizationRequest,
  type DenyDecision,
} from "../domain/authorization-decision";
import {
  isRoleCode,
  isScopeType,
  isSensitivityLevel,
  isUuid,
  type DenialReason,
  type RoleCode,
  type ScopeType,
  type SensitivityLevel,
} from "../domain/authorization-vocabulary";
import {
  canonicalCondition,
  parseGrantCondition,
  type GrantCondition,
} from "../domain/grant-condition";
import {
  allowedScopeTypesByRole,
  compareLeastPrivilege,
} from "../domain/role-assignment";
import {
  isValidDescriptor,
  isValidPlacement,
  placementOfScope,
  scopeContains,
  sensitivityPermits,
  type ResourcePlacement,
  type ScopeDescriptor,
} from "../domain/scope-policy";
import type {
  DualControlConfiguration,
  SeparationOfDutiesPolicy,
} from "../domain/separation-of-duties-policy";
import {
  AUTHORIZATION_CATALOG_VERSION,
  AUTHORIZATION_POLICY_VERSION,
  permissionRow,
} from "../policy/authorization-catalog";
import {
  findPermission,
  type PermissionDefinition,
} from "../policy/permission-catalog";
import { grantCatalog } from "../policy/role-permission-catalog";
import type { WorkflowPolicyRegistry } from "../policy/workflow-policies";
import {
  DatabaseAuthorizationFacts,
  type Executor,
} from "../infrastructure/authorization-repository";
import type { SecurityEventPort } from "../infrastructure/security-events";
import type {
  AuthorizationFactsSource,
  GrantFact,
  PermissionFact,
} from "./ports/authorization-facts";
import type {
  CandidateOwnershipResolver,
  ResolverContext,
  ScopeResourceResolver,
} from "./ports/scope-resource-resolver";

// Central deny-by-default authorization service (packet M1.4 §6, §11,
// ADR-0005). One framework-neutral entry point evaluates:
//
//   authenticated principal AND active account
//   AND current valid role assignment (or candidate ownership relationship)
//   AND role grants the permission AND resource within effective scope
//   AND sensitivity permits AND workflow state permits
//   AND separation of duties passes AND required recent auth present
//
// Every fact is read from server-owned state at evaluation time. The
// result is always an explicit ALLOW or DENY with a closed reason code;
// normal denials never throw. Unexpected failures deny POLICY_UNAVAILABLE.
// M1.5 adapters decide how a denial is shown (401/403/404/step-up).

export type AuthorizationPorts = Readonly<{
  resolver: ScopeResourceResolver;
  ownership: CandidateOwnershipResolver;
  workflow: WorkflowPolicyRegistry;
  separation: SeparationOfDutiesPolicy;
  dualControl: DualControlConfiguration;
  clock: () => Date;
}>;

export type AuthorizationDependencies = AuthorizationPorts &
  Readonly<{
    db: Database;
    events: SecurityEventPort;
    logger: AppLogger;
    /** M1.3 recent-authentication window (AUTH_STAFF_RECENT_AUTH_SECONDS). */
    recentWindowSeconds: number;
  }>;

type Candidate = Readonly<{
  id: string;
  assignmentId: string;
  roleCode: RoleCode;
  scopeType: ScopeType;
  scopeReferenceId: string;
  effectiveFrom: Date;
}>;

const POLICY = AUTHORIZATION_POLICY_VERSION;

/** Authorizes against current committed state (queries/reads). */
export function authorize(
  request: AuthorizationRequest,
  deps: AuthorizationDependencies,
): Promise<AuthorizationDecision> {
  return evaluateAuthorization(
    request,
    new DatabaseAuthorizationFacts(deps.db),
    deps,
  );
}

/**
 * Authorizes inside the protected command's own transaction. The subject's
 * account row is held FOR SHARE until the transaction ends, so a
 * concurrent revocation/restriction (FOR UPDATE on the same row) either
 * committed first and is seen here, or waits until this command commits:
 * a command never commits on authority revoked before its boundary.
 */
export function authorizeInTransaction(
  tx: Executor,
  request: AuthorizationRequest,
  deps: AuthorizationDependencies,
): Promise<AuthorizationDecision> {
  return evaluateAuthorization(
    request,
    new DatabaseAuthorizationFacts(tx, { lockSubject: true }),
    deps,
  );
}

/** The decision pipeline over an injected facts source (unit-testable). */
export async function evaluateAuthorization(
  request: AuthorizationRequest,
  facts: AuthorizationFactsSource,
  deps: Omit<AuthorizationDependencies, "db">,
): Promise<AuthorizationDecision> {
  const definition = isWellFormedRequest(request)
    ? findPermission(request.permission)
    : null;
  const code = definition?.code ?? "unknown";
  try {
    const decision = await decide(request, definition, facts, deps);
    if (decision.decision === "DENY")
      await report(decision, definition, request, deps);
    return decision;
  } catch {
    // Never surface a raw error, SQL, or resolver failure.
    const decision = deny(code, POLICY, "POLICY_UNAVAILABLE");
    await report(decision, definition, request, deps);
    return decision;
  }
}

type Refuse = (
  reason: DenialReason,
  challenge?: DenyDecision["challenge"],
) => DenyDecision;

/** Steps 1–2 shared by record decisions and query-scope decisions. */
type Preflight =
  | Readonly<{ ok: false; decision: DenyDecision }>
  | Readonly<{
      ok: true;
      definition: PermissionDefinition;
      accountType: "STAFF" | "CANDIDATE";
      evidence: AssuranceEvidence | null;
      now: Date;
      context: ResolverContext;
      no: Refuse;
    }>;

async function preflight(
  request: Pick<
    AuthorizationRequest,
    "principal" | "operation" | "correlationId"
  > &
    Partial<Pick<AuthorizationRequest, "reasonCode" | "workflow">>,
  definition: PermissionDefinition | null,
  facts: AuthorizationFactsSource,
  deps: Omit<AuthorizationDependencies, "db">,
): Promise<Preflight> {
  const code = definition?.code ?? "unknown";
  const no: Refuse = (reason, challenge) =>
    deny(code, POLICY, reason, challenge);
  const fail = (reason: DenialReason) =>
    ({ ok: false, decision: no(reason) }) as const;
  if (!request.principal) return fail("UNAUTHENTICATED");
  if (!definition) return fail("PERMISSION_UNKNOWN");
  if (definition.status !== "ACTIVE") return fail("PERMISSION_MISSING");
  if (request.operation !== definition.operation)
    return fail("INVALID_CONTEXT");
  if (definition.requiresReason && request.reasonCode === undefined) {
    return fail("INVALID_CONTEXT");
  }
  if (definition.workflowPolicy === null && request.workflow !== undefined) {
    return fail("INVALID_CONTEXT");
  }

  const now = deps.clock();
  const principal = request.principal;
  const account = await facts.loadAccount(principal.accountId);
  if (
    !account ||
    account.status !== "ACTIVE" ||
    account.accountType !== principal.accountType ||
    (account.accountType !== "STAFF" && account.accountType !== "CANDIDATE")
  ) {
    return fail("ACCOUNT_INACTIVE");
  }

  // The session itself must still exist and be valid now: a revoked or
  // stale browser session cannot carry a decision.
  const evidence = await facts.loadAssurance(
    principal.accountId,
    principal.sessionId,
  );
  if (account.accountType === "STAFF") {
    const base = evaluateAssurance(evidence, {
      policy: "NORMAL_STAFF_SESSION",
      accountId: principal.accountId,
      sessionId: principal.sessionId,
      now,
      recentWindowSeconds: 1,
    });
    if (base.kind !== "ALLOW") return fail("UNAUTHENTICATED");
  } else if (
    !evidence ||
    (evidence.sessionPurpose !== null && evidence.sessionPurpose !== "STANDARD")
  ) {
    return fail("UNAUTHENTICATED");
  }

  // 2. The stored catalog row must match the reviewed manifest exactly.
  const stored = await facts.loadPermission(definition.code);
  if (!stored || !matchesManifest(stored, definition)) {
    policyUnavailable(definition, deps);
    return fail("POLICY_UNAVAILABLE");
  }

  return {
    ok: true,
    definition,
    accountType: account.accountType,
    evidence,
    now,
    context: { correlationId: request.correlationId },
    no,
  };
}

async function decide(
  request: AuthorizationRequest,
  definition: PermissionDefinition | null,
  facts: AuthorizationFactsSource,
  deps: Omit<AuthorizationDependencies, "db">,
): Promise<AuthorizationDecision> {
  // 1. Request shape and identity, before any resource facts are loaded.
  if (!isWellFormedRequest(request)) {
    return deny("unknown", POLICY, "INVALID_CONTEXT");
  }
  const ready = await preflight(request, definition, facts, deps);
  if (!ready.ok) return ready.decision;
  const { now, context, evidence, no } = ready;
  return ready.accountType === "CANDIDATE"
    ? decideCandidate(request, ready.definition, facts, deps, now, context, no)
    : decideStaff(
        request,
        ready.definition,
        facts,
        deps,
        now,
        context,
        evidence,
        no,
      );
}

async function decideCandidate(
  request: AuthorizationRequest,
  definition: PermissionDefinition,
  facts: AuthorizationFactsSource,
  deps: Omit<AuthorizationDependencies, "db">,
  now: Date,
  context: ResolverContext,
  no: (reason: DenialReason) => DenyDecision,
): Promise<AuthorizationDecision> {
  // Candidates hold only candidate-self permissions, through the ownership
  // relationship. They never use a staff permission or assignment.
  if (definition.domain !== "CANDIDATE_SELF") return no("PERMISSION_MISSING");
  const grants = (await facts.loadCandidateGrants(definition.code)).filter(
    (g) => {
      const condition = validGrantCondition(g, definition.code);
      return condition?.kind === "CANDIDATE_OWNERSHIP";
    },
  );
  if (grants.length === 0) return no("PERMISSION_MISSING");
  if (request.resource.kind !== "RECORD") return no("INVALID_CONTEXT");
  const principal = request.principal!;
  const ownership = await deps.ownership.owns(
    principal.accountId,
    request.resource.id,
    now,
    context,
  );
  if (ownership === "UNAVAILABLE") return no("OWNERSHIP_UNAVAILABLE");
  if (ownership !== "OWNER") return no("SCOPE_MISMATCH");
  if (
    !sensitivityPermits(definition.maxSensitivity, request.resource.sensitivity)
  ) {
    return no("SENSITIVITY_DENIED");
  }
  const workflow = checkWorkflow(request, definition, deps);
  if (workflow) return no(workflow);
  return allow(definition, "CANDIDATE", null);
}

async function decideStaff(
  request: AuthorizationRequest,
  definition: PermissionDefinition,
  facts: AuthorizationFactsSource,
  deps: Omit<AuthorizationDependencies, "db">,
  now: Date,
  context: ResolverContext,
  evidence: AssuranceEvidence | null,
  no: Refuse,
): Promise<AuthorizationDecision> {
  const principal = request.principal!;
  if (definition.domain === "CANDIDATE_SELF") return no("PERMISSION_MISSING");

  // 3. Current effective assignments whose role grants the permission.
  const effective = await effectiveCandidates(
    principal.accountId,
    definition,
    facts,
    deps,
    now,
    no,
  );
  if (!Array.isArray(effective)) return effective as DenyDecision;
  const candidates = effective;

  // 4. Resource placement from the owning module (never the request).
  const resource = request.resource;
  let placement: ResourcePlacement;
  if (resource.kind === "RECORD") {
    const resolved = await deps.resolver.resolveResource(
      resource.id,
      now,
      context,
    );
    if (resolved.status === "UNAVAILABLE") return no("SCOPE_UNAVAILABLE");
    if (resolved.status !== "FOUND" || !isValidPlacement(resolved.placement)) {
      return no("SCOPE_MISMATCH");
    }
    placement = resolved.placement;
  } else {
    const resolved = await deps.resolver.resolveScope(
      resource.scopeType,
      resource.id,
      now,
      context,
    );
    if (resolved.status === "UNAVAILABLE") return no("SCOPE_UNAVAILABLE");
    if (
      resolved.status !== "ACTIVE" ||
      !isValidDescriptor(resolved.descriptor, resource.scopeType, resource.id)
    ) {
      return no("SCOPE_MISMATCH");
    }
    placement = placementOfScope(resolved.descriptor);
  }

  // 5. Scope containment and grant conditions, per assignment.
  const inScope: Candidate[] = [];
  let scopeUnavailable = false;
  let conditionUnmet = false;
  for (const candidate of candidates) {
    const scope = await deps.resolver.resolveScope(
      candidate.scopeType,
      candidate.scopeReferenceId,
      now,
      context,
    );
    if (scope.status === "UNAVAILABLE") {
      scopeUnavailable = true;
      continue;
    }
    if (
      scope.status !== "ACTIVE" ||
      !isValidDescriptor(
        scope.descriptor,
        candidate.scopeType,
        candidate.scopeReferenceId,
      ) ||
      !scopeContains(scope.descriptor, placement, {
        actorAccountId: principal.accountId,
        category: resource.sensitivity,
      })
    ) {
      continue;
    }
    if (
      !(await conditionHolds(
        candidate.condition,
        request,
        scope.descriptor,
        deps,
        now,
        context,
      ))
    ) {
      conditionUnmet = true;
      continue;
    }
    inScope.push(candidate);
  }
  if (inScope.length === 0) {
    if (conditionUnmet) return no("CONDITION_UNMET");
    return no(scopeUnavailable ? "SCOPE_UNAVAILABLE" : "SCOPE_MISMATCH");
  }

  // 6. Sensitivity (an upper bound, never a grant) and 7. workflow state.
  if (!sensitivityPermits(definition.maxSensitivity, resource.sensitivity)) {
    return no("SENSITIVITY_DENIED");
  }
  const workflow = checkWorkflow(request, definition, deps);
  if (workflow) return no(workflow);

  // 8. Separation of duties and 9. recent authentication, per candidate in
  // least-privilege order; the first fully sufficient one is used.
  const epoch = await facts.loadSubjectEpoch(principal.accountId);
  let firstDenial: DenyDecision | null = null;
  for (const candidate of inScope) {
    const separation = deps.separation.evaluate({
      actorAccountId: principal.accountId,
      actorPrincipalType: "STAFF",
      effectiveRoleCode: candidate.roleCode,
      operation: definition.operation,
      permissionDomain: definition.domain,
      policy: definition.separationPolicy,
      dualControlHook: definition.dualControlHook,
      subjectAccountIds:
        resource.kind === "RECORD" ? placement.subjectAccountIds : null,
      facts: request.separation ?? {},
      elevation: request.elevation ?? "NONE",
      dualControl: deps.dualControl,
    });
    if (separation.kind === "DENY") {
      firstDenial ??= no(separation.reason);
      continue;
    }
    const assurance = assuranceDenial(
      definition,
      candidate,
      principal,
      evidence,
      epoch,
      now,
      deps,
      no,
    );
    if (assurance) {
      firstDenial ??= assurance;
      continue;
    }
    return allow(definition, candidate.roleCode, candidate);
  }
  return firstDenial ?? no("POLICY_UNAVAILABLE");
}

type ConditionedCandidate = Candidate & { condition: GrantCondition | null };

/**
 * The principal's currently effective assignments whose role grants the
 * permission, validated against the reviewed manifest and ordered least
 * privilege first; or a denial.
 */
async function effectiveCandidates(
  accountId: string,
  definition: PermissionDefinition,
  facts: AuthorizationFactsSource,
  deps: Omit<AuthorizationDependencies, "db">,
  now: Date,
  no: Refuse,
): Promise<ConditionedCandidate[] | DenyDecision> {
  const rows = await facts.loadStaffGrants(accountId, definition.code, now);
  let tampered = false;
  const candidates: ConditionedCandidate[] = [];
  for (const row of rows) {
    const condition = validGrantCondition(row, definition.code);
    if (
      condition === undefined ||
      condition?.kind === "CANDIDATE_OWNERSHIP" ||
      !isRoleCode(row.roleCode) ||
      row.roleCode === "CANDIDATE" ||
      !row.assignmentId ||
      !isScopeType(row.scopeType) ||
      // A role acts only through its approved scope types (ADR-0005: the
      // auditor only through AUDIT_ASSIGNMENT, the administrator only
      // ORGANIZATION). A stored row outside that set bypassed proposal
      // validation and is treated as tampering, never as authority (M1.7).
      !allowedScopeTypesByRole[row.roleCode].includes(row.scopeType) ||
      !row.scopeReferenceId ||
      !row.effectiveFrom
    ) {
      tampered = true;
      continue;
    }
    candidates.push({
      id: row.assignmentId,
      assignmentId: row.assignmentId,
      roleCode: row.roleCode,
      scopeType: row.scopeType,
      scopeReferenceId: row.scopeReferenceId,
      effectiveFrom: row.effectiveFrom,
      condition,
    });
  }
  if (tampered) policyUnavailable(definition, deps);
  if (candidates.length === 0) {
    if (tampered) return no("POLICY_UNAVAILABLE");
    return (await facts.hasIneffectiveAssignment(
      accountId,
      definition.code,
      now,
    ))
      ? no("ASSIGNMENT_INACTIVE")
      : no("PERMISSION_MISSING");
  }
  candidates.sort(compareLeastPrivilege);
  return candidates;
}

/** Recent-authentication check for one assignment, or null when satisfied. */
function assuranceDenial(
  definition: PermissionDefinition,
  candidate: Candidate,
  principal: NonNullable<AuthorizationRequest["principal"]>,
  evidence: AssuranceEvidence | null,
  epoch: Awaited<ReturnType<AuthorizationFactsSource["loadSubjectEpoch"]>>,
  now: Date,
  deps: Omit<AuthorizationDependencies, "db">,
  no: Refuse,
): DenyDecision | null {
  if (!definition.recentAuth) return null;
  const assurance = evaluateAssurance(evidence, {
    policy: definition.recentAuth.policy,
    accountId: principal.accountId,
    sessionId: principal.sessionId,
    purpose: definition.recentAuth.purpose,
    now,
    recentWindowSeconds: deps.recentWindowSeconds,
  });
  if (assurance.kind !== "ALLOW") {
    return no(
      "RECENT_AUTH_REQUIRED",
      assurance.kind === "CHALLENGE"
        ? assurance.reason
        : "REAUTHENTICATION_REQUIRED",
    );
  }
  // Privilege expansion never reuses step-up made before it.
  const floor = Math.max(
    candidate.effectiveFrom.getTime(),
    epoch?.versionChangedAt.getTime() ?? 0,
  );
  if (assurance.at.getTime() < floor) {
    return no("RECENT_AUTH_REQUIRED", "REAUTHENTICATION_REQUIRED");
  }
  return null;
}

async function conditionHolds(
  condition: GrantCondition | null,
  request: AuthorizationRequest,
  scope: ScopeDescriptor,
  deps: Omit<AuthorizationDependencies, "db">,
  now: Date,
  context: ResolverContext,
): Promise<boolean> {
  if (!condition) return true;
  const actor = request.principal!.accountId;
  switch (condition.kind) {
    case "DESIGNATION":
      return (
        (await deps.resolver.hasDesignation(
          actor,
          condition.designation,
          scope,
          now,
          context,
        )) === true
      );
    case "PARTICIPANT":
      return (
        request.resource.kind === "RECORD" &&
        (await deps.resolver.hasRelationship(
          actor,
          request.resource.id,
          condition.relationship,
          now,
          context,
        )) === true
      );
    case "HOLD_CATEGORY":
      return (
        request.holdCategory !== undefined &&
        condition.categories.includes(request.holdCategory)
      );
    case "CANDIDATE_OWNERSHIP":
      return false;
  }
}

function checkWorkflow(
  request: AuthorizationRequest,
  definition: PermissionDefinition,
  deps: Omit<AuthorizationDependencies, "db">,
): DenialReason | null {
  if (definition.workflowPolicy === null) return null;
  const facts = request.workflow;
  if (!facts || facts.policy !== definition.workflowPolicy) {
    return "WORKFLOW_STATE_DENIED";
  }
  const policy = deps.workflow.get(definition.workflowPolicy);
  if (!policy) return "POLICY_UNAVAILABLE";
  if (!policy.states.includes(facts.state)) return "WORKFLOW_STATE_DENIED";
  return policy.permits(definition.code, facts.state, facts.transition) === true
    ? null
    : "WORKFLOW_STATE_DENIED";
}

/**
 * Parses a stored grant condition and checks it against the reviewed
 * manifest. Returns `undefined` for anything not in the manifest
 * (tampering/drift), so the grant is ignored.
 */
function validGrantCondition(
  row: GrantFact,
  permissionCode: string,
): GrantCondition | null | undefined {
  const parsed = parseGrantCondition(row.condition);
  if (parsed === "INVALID") return undefined;
  const expected = grantCatalog.find(
    (g) =>
      g.roleCode === row.roleCode &&
      g.permissionCode === permissionCode &&
      g.status === "ACTIVE",
  );
  if (!expected) return undefined;
  return canonicalCondition(expected.condition) === canonicalCondition(parsed)
    ? parsed
    : undefined;
}

function matchesManifest(
  stored: PermissionFact,
  definition: PermissionDefinition,
): boolean {
  if (
    !Number.isInteger(stored.catalogVersion) ||
    stored.catalogVersion < 1 ||
    stored.catalogVersion > AUTHORIZATION_CATALOG_VERSION
  ) {
    return false;
  }
  const expected = permissionRow(definition) as Record<string, unknown>;
  const actual = stored as Record<string, unknown>;
  return Object.keys(expected).every((key) => expected[key] === actual[key]);
}

function allow(
  definition: PermissionDefinition,
  roleCode: RoleCode,
  candidate: Candidate | null,
): AllowDecision {
  return Object.freeze({
    decision: "ALLOW",
    permissionCode: definition.code,
    effectiveRoleCode: roleCode,
    effectiveAssignmentId: candidate?.assignmentId ?? null,
    effectiveScopeType: candidate?.scopeType ?? null,
    effectiveScopeReferenceId: candidate?.scopeReferenceId ?? null,
    policyVersion: POLICY,
    reasonCode: "ALLOWED",
  });
}

function policyUnavailable(
  definition: PermissionDefinition,
  deps: Omit<AuthorizationDependencies, "db">,
) {
  // Operational telemetry only (catalog: LOG_ONLY); the denial itself is
  // persisted once by report() when the permission is high risk.
  void deps.events.record({
    code: "authz.policy_unavailable",
    category: "denied",
    permissionCode: definition.code,
    policyVersion: POLICY,
  });
}

/**
 * Bounded denial telemetry for every denial; a high-risk denial is also
 * persisted exactly once as a durable audit event (ADR-0012) through a
 * bounded standalone append. A failed append never changes the decision:
 * the result is still DENY and only a safe alert is raised. Only catalog
 * codes and the opaque account reference are recorded, never resource
 * IDs, scope IDs, or policy facts. Route guards never emit (they only map
 * outcomes), so one denial produces one event.
 */
async function report(
  decision: DenyDecision,
  definition: PermissionDefinition | null,
  request: AuthorizationRequest,
  deps: Omit<AuthorizationDependencies, "db">,
) {
  const accountRef =
    isWellFormedRequest(request) && request.principal
      ? request.principal.accountId
      : undefined;
  deps.logger.info("authz.denied", {
    module: "authz",
    action: definition?.code,
    reasonCode: decision.reasonCode,
    policyVersion: decision.policyVersion,
  });
  if (definition?.highRisk && accountRef) {
    await deps.events.record({
      code: "authz.high_risk_denied",
      actorRef: accountRef,
      permissionCode: definition.code,
      reasonCode: decision.reasonCode,
      policyVersion: decision.policyVersion,
      correlationId: request.correlationId,
    });
  }
}

// ------------------------------------------------------------ query scope
//
// List/search authorization (packet M1.5 §14, ADR-0011). A list has no
// single record to place, so instead of a per-record decision the service
// returns the typed scope constraints under which the principal currently
// holds the permission. Repositories apply them as SQL predicates before
// pagination or materialization; each returned row is then rechecked with
// authorize(). The constraint is built only from current server-owned
// assignments and resolver descriptors, never from a browser-selected
// scope (a later scope selector may only intersect, never widen).

export type QueryScopeRequest = Readonly<{
  principal: AuthorizationPrincipal | null;
  permission: string;
  operation: "READ" | "EXPORT";
  /** Classification of the data the list returns (owning module). */
  sensitivity: SensitivityLevel;
  /** Server-chosen safe purpose code when the permission requires one. */
  reasonCode?: string;
  correlationId?: string;
}>;

/** One SQL-expressible boundary from one effective assignment. */
export type ScopeConstraint =
  | Readonly<{ type: "ORGANIZATION"; organizationId: string }>
  | Readonly<{ type: "BRANCH"; organizationId: string; branchId: string }>
  | Readonly<{
      type: "TEAM";
      organizationId: string;
      branchId: string;
      teamId: string;
    }>
  | Readonly<{
      type: "ASSIGNED_RECORDS";
      organizationId: string;
      assignmentSetId: string;
    }>
  | Readonly<{
      type: "AUDIT_ASSIGNMENT";
      organizationId: string;
      recordGroupIds: readonly string[];
      /** Inclusive start / exclusive end of record dates. */
      recordsFrom: Date;
      recordsTo: Date;
    }>;

export type QueryConstraint =
  /** Candidate self-service: rows owned by this account only. */
  | Readonly<{ kind: "OWNER"; accountId: string }>
  /** Staff: the union of these scopes, minus the actor's own file. */
  | Readonly<{
      kind: "SCOPES";
      scopes: readonly ScopeConstraint[];
      excludeSubjectAccountId: string;
    }>;

export type QueryScopeDecision =
  | Readonly<{
      decision: "ALLOW";
      permissionCode: string;
      policyVersion: string;
      reasonCode: "ALLOWED";
      effectiveRoleCodes: readonly RoleCode[];
      constraint: QueryConstraint;
    }>
  | DenyDecision;

const queryKeys = new Set([
  "principal",
  "permission",
  "operation",
  "sensitivity",
  "reasonCode",
  "correlationId",
]);

function isWellFormedQuery(request: unknown): request is QueryScopeRequest {
  if (
    typeof request !== "object" ||
    request === null ||
    Object.getPrototypeOf(request) !== Object.prototype
  ) {
    return false;
  }
  const r = request as Record<string, unknown>;
  if (!Object.keys(r).every((k) => queryKeys.has(k))) return false;
  if (typeof r.permission !== "string") return false;
  if (r.operation !== "READ" && r.operation !== "EXPORT") return false;
  if (!isSensitivityLevel(r.sensitivity)) return false;
  if (
    r.reasonCode !== undefined &&
    (typeof r.reasonCode !== "string" || !reasonCodePattern.test(r.reasonCode))
  ) {
    return false;
  }
  if (r.correlationId !== undefined && typeof r.correlationId !== "string") {
    return false;
  }
  if (r.principal === null) return true;
  const p = r.principal as Record<string, unknown> | undefined;
  return (
    typeof p === "object" &&
    p !== null &&
    isUuid(p.accountId) &&
    isUuid(p.sessionId) &&
    typeof p.accountType === "string"
  );
}

function constraintOf(descriptor: ScopeDescriptor): ScopeConstraint {
  switch (descriptor.type) {
    case "ORGANIZATION":
      return { type: "ORGANIZATION", organizationId: descriptor.id };
    case "BRANCH":
      return {
        type: "BRANCH",
        organizationId: descriptor.organizationId,
        branchId: descriptor.id,
      };
    case "TEAM":
      return {
        type: "TEAM",
        organizationId: descriptor.organizationId,
        branchId: descriptor.branchId,
        teamId: descriptor.id,
      };
    case "ASSIGNED_RECORDS":
      return {
        type: "ASSIGNED_RECORDS",
        organizationId: descriptor.organizationId,
        assignmentSetId: descriptor.id,
      };
    case "AUDIT_ASSIGNMENT":
      return {
        type: "AUDIT_ASSIGNMENT",
        organizationId: descriptor.organizationId,
        recordGroupIds: [...descriptor.recordGroupIds],
        recordsFrom: descriptor.recordsFrom,
        recordsTo: descriptor.recordsTo,
      };
  }
}

/** Authorizes a list/search query against current committed state. */
export function authorizeQueryScope(
  request: QueryScopeRequest,
  deps: AuthorizationDependencies,
): Promise<QueryScopeDecision> {
  return evaluateQueryScope(
    request,
    new DatabaseAuthorizationFacts(deps.db),
    deps,
  );
}

/** The query-scope pipeline over an injected facts source. */
export async function evaluateQueryScope(
  request: QueryScopeRequest,
  facts: AuthorizationFactsSource,
  deps: Omit<AuthorizationDependencies, "db">,
): Promise<QueryScopeDecision> {
  const definition = isWellFormedQuery(request)
    ? findPermission(request.permission)
    : null;
  let decision: QueryScopeDecision;
  try {
    decision = isWellFormedQuery(request)
      ? await decideQueryScope(request, definition, facts, deps)
      : deny("unknown", POLICY, "INVALID_CONTEXT");
  } catch {
    decision = deny(
      definition?.code ?? "unknown",
      POLICY,
      "POLICY_UNAVAILABLE",
    );
  }
  if (decision.decision === "DENY") {
    deps.logger.info("authz.denied", {
      module: "authz",
      action: definition?.code,
      reasonCode: decision.reasonCode,
      policyVersion: decision.policyVersion,
    });
  }
  return decision;
}

async function decideQueryScope(
  request: QueryScopeRequest,
  definition: PermissionDefinition | null,
  facts: AuthorizationFactsSource,
  deps: Omit<AuthorizationDependencies, "db">,
): Promise<QueryScopeDecision> {
  const ready = await preflight(request, definition, facts, deps);
  if (!ready.ok) return ready.decision;
  const { now, context, evidence, no } = ready;
  const def = ready.definition;
  const principal = request.principal!;
  // A list has no single workflow state to evaluate.
  if (def.workflowPolicy !== null) return no("WORKFLOW_STATE_DENIED");
  if (!sensitivityPermits(def.maxSensitivity, request.sensitivity)) {
    return no("SENSITIVITY_DENIED");
  }

  if (ready.accountType === "CANDIDATE") {
    if (def.domain !== "CANDIDATE_SELF") return no("PERMISSION_MISSING");
    const grants = (await facts.loadCandidateGrants(def.code)).filter(
      (g) => validGrantCondition(g, def.code)?.kind === "CANDIDATE_OWNERSHIP",
    );
    if (grants.length === 0) return no("PERMISSION_MISSING");
    // Ownership is bound from the server principal; each row is still
    // rechecked through the ownership resolver.
    return Object.freeze({
      decision: "ALLOW",
      permissionCode: def.code,
      policyVersion: POLICY,
      reasonCode: "ALLOWED",
      effectiveRoleCodes: Object.freeze(["CANDIDATE" as const]),
      constraint: Object.freeze({
        kind: "OWNER",
        accountId: principal.accountId,
      }),
    });
  }

  if (def.domain === "CANDIDATE_SELF") return no("PERMISSION_MISSING");
  const effective = await effectiveCandidates(
    principal.accountId,
    def,
    facts,
    deps,
    now,
    no,
  );
  if (!Array.isArray(effective)) return effective as DenyDecision;

  const epoch = await facts.loadSubjectEpoch(principal.accountId);
  const scopes: ScopeConstraint[] = [];
  const roles = new Set<RoleCode>();
  let firstDenial: DenyDecision | null = null;
  let scopeUnavailable = false;
  let conditionUnmet = false;
  for (const candidate of effective) {
    const scope = await deps.resolver.resolveScope(
      candidate.scopeType,
      candidate.scopeReferenceId,
      now,
      context,
    );
    if (scope.status === "UNAVAILABLE") {
      scopeUnavailable = true;
      continue;
    }
    if (
      scope.status !== "ACTIVE" ||
      !isValidDescriptor(
        scope.descriptor,
        candidate.scopeType,
        candidate.scopeReferenceId,
      )
    ) {
      continue;
    }
    const descriptor = scope.descriptor;
    if (
      descriptor.type === "AUDIT_ASSIGNMENT" &&
      (descriptor.auditorAccountId !== principal.accountId ||
        !descriptor.categories.includes(request.sensitivity))
    ) {
      continue;
    }
    // Only conditions provable for a whole scope are list-expressible.
    // Participant/hold conditions need the individual record and never
    // widen a list; they apply only through per-record decisions.
    const condition = candidate.condition;
    if (condition) {
      const holds =
        condition.kind === "DESIGNATION" &&
        (await deps.resolver.hasDesignation(
          principal.accountId,
          condition.designation,
          descriptor,
          now,
          context,
        )) === true;
      if (!holds) {
        conditionUnmet = true;
        continue;
      }
    }
    const separation = deps.separation.evaluate({
      actorAccountId: principal.accountId,
      actorPrincipalType: "STAFF",
      effectiveRoleCode: candidate.roleCode,
      operation: def.operation,
      permissionDomain: def.domain,
      policy: def.separationPolicy,
      dualControlHook: def.dualControlHook,
      subjectAccountIds: null,
      facts: {},
      elevation: "NONE",
      dualControl: deps.dualControl,
    });
    if (separation.kind === "DENY") {
      firstDenial ??= no(separation.reason);
      continue;
    }
    const assurance = assuranceDenial(
      def,
      candidate,
      principal,
      evidence,
      epoch,
      now,
      deps,
      no,
    );
    if (assurance) {
      firstDenial ??= assurance;
      continue;
    }
    scopes.push(constraintOf(descriptor));
    roles.add(candidate.roleCode);
  }
  if (scopes.length === 0) {
    return (
      firstDenial ??
      no(
        conditionUnmet
          ? "CONDITION_UNMET"
          : scopeUnavailable
            ? "SCOPE_UNAVAILABLE"
            : "SCOPE_MISMATCH",
      )
    );
  }
  return Object.freeze({
    decision: "ALLOW",
    permissionCode: def.code,
    policyVersion: POLICY,
    reasonCode: "ALLOWED",
    effectiveRoleCodes: Object.freeze([...roles].sort()),
    constraint: Object.freeze({
      kind: "SCOPES",
      scopes: Object.freeze(scopes),
      // Own candidacy/worker file never appears in a staff list.
      excludeSubjectAccountId: principal.accountId,
    }),
  });
}

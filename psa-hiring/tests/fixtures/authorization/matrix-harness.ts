import { expect } from "vitest";
import type { AppLogger, LogContext } from "@/shared/logging";
import {
  evaluateAuthorization,
  evaluateQueryScope,
  type AuthorizationDependencies,
  type QueryScopeRequest,
} from "@/modules/identity-access/application/authorize";
import type {
  AccountFact,
  AuthorizationFactsSource,
  GrantFact,
  PermissionFact,
  SubjectEpoch,
} from "@/modules/identity-access/application/ports/authorization-facts";
import type { AssuranceEvidence } from "@/modules/identity-access/domain/authentication-assurance";
import type {
  AuthorizationDecision,
  AuthorizationRequest,
} from "@/modules/identity-access/domain/authorization-decision";
import type {
  RoleCode,
  ScopeType,
} from "@/modules/identity-access/domain/authorization-vocabulary";
import { allowedScopeTypesByRole } from "@/modules/identity-access/domain/role-assignment";
import {
  MandatorySeparationOfDutiesPolicy,
  restrictiveDualControl,
} from "@/modules/identity-access/domain/separation-of-duties-policy";
import { SyntheticCandidateOwnership } from "@/modules/identity-access/infrastructure/scope-resolvers";
import type { SecurityEvent } from "@/modules/identity-access/infrastructure/security-events";
import { permissionRow } from "@/modules/identity-access/policy/authorization-catalog";
import {
  findPermission,
  type PermissionDefinition,
} from "@/modules/identity-access/policy/permission-catalog";
import { grantCatalog } from "@/modules/identity-access/policy/role-permission-catalog";
import type {
  WorkflowPolicy,
  WorkflowPolicyRegistry,
} from "@/modules/identity-access/policy/workflow-policies";
import { NOW, at, record, scope, syntheticHierarchy, u } from "../scopes";

// In-memory M1.7 authorization matrix harness (packet M1.7 §8, §10–§15,
// §19). Runs the real central decision pipeline (evaluateAuthorization /
// evaluateQueryScope) over a multi-account facts source and the accepted
// synthetic resolvers. No database, no network, no real data. The same
// rules run against PostgreSQL in tests/integration/authorization/*.

const a = (n: number) => u("ac0c7000", n);

/** Synthetic persona accounts and sessions (packet §8). */
export const account = {
  ACTOR: a(1),
  OTHER_STAFF: a(2),
  AUDITOR: a(3),
  OTHER_AUDITOR: a(4),
  ADMIN: a(5),
  CANDIDATE_A: a(10),
  CANDIDATE_B: a(11),
  CANDIDATE_INCOMPLETE: a(12),
  SERVICE: a(20),
  INACTIVE_STAFF: a(21),
  PASSWORD_ONLY_STAFF: a(22),
} as const;
export const sessionOf = (accountId: string) =>
  `${accountId.slice(0, 8)}-5e55-4000-8000-${accountId.slice(-12)}`;

export const principalOf = (
  accountId: string,
  accountType: "STAFF" | "CANDIDATE" | "SERVICE" = "STAFF",
) => ({ accountId, accountType, sessionId: sessionOf(accountId) });

export type MatrixAssignment = {
  assignmentId: string;
  accountId: string;
  roleCode: RoleCode;
  scopeType: ScopeType;
  scopeReferenceId: string;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  status: "ACTIVE" | "REVOKED" | "SUPERSEDED" | "PROPOSED";
};

const grantKey = (role: string, permission: string) => `${role}|${permission}`;
const catalogGrants = new Map(
  grantCatalog
    .filter((g) => g.status === "ACTIVE")
    .map((g) => [grantKey(g.roleCode, g.permissionCode), g]),
);

/** Multi-account in-memory facts with assignment lifecycle and tampering. */
export class MatrixFacts implements AuthorizationFactsSource {
  accounts = new Map<string, AccountFact>();
  evidence = new Map<string, AssuranceEvidence>();
  assignments: MatrixAssignment[] = [];
  epochs = new Map<string, SubjectEpoch>();
  retiredRoles = new Set<string>();
  removedGrants = new Set<string>();
  permissionOverrides = new Map<string, Partial<PermissionFact>>();
  conditionOverride: unknown = undefined;

  async loadAccount(accountId: string) {
    return this.accounts.get(accountId) ?? null;
  }
  async loadAssurance(accountId: string, sessionId: string) {
    const e = this.evidence.get(sessionId);
    return e && e.accountId === accountId ? e : null;
  }
  async loadSubjectEpoch(accountId: string) {
    return this.epochs.get(accountId) ?? null;
  }
  async loadPermission(code: string): Promise<PermissionFact | null> {
    const definition = findPermission(code);
    if (!definition) return null;
    return {
      ...permissionRow(definition),
      catalogVersion: 1,
      ...this.permissionOverrides.get(code),
    };
  }
  grant(role: string, permission: string) {
    if (this.removedGrants.has(grantKey(role, permission))) return undefined;
    return catalogGrants.get(grantKey(role, permission));
  }
  private effective(x: MatrixAssignment, when: Date) {
    return (
      x.status === "ACTIVE" &&
      !this.retiredRoles.has(x.roleCode) &&
      x.effectiveFrom.getTime() <= when.getTime() &&
      (x.effectiveTo === null || when.getTime() < x.effectiveTo.getTime())
    );
  }
  async loadStaffGrants(
    accountId: string,
    code: string,
    when: Date,
  ): Promise<GrantFact[]> {
    return this.assignments
      .filter(
        (x) =>
          x.accountId === accountId &&
          this.effective(x, when) &&
          this.grant(x.roleCode, code),
      )
      .map((x) => ({
        assignmentId: x.assignmentId,
        roleCode: x.roleCode,
        scopeType: x.scopeType,
        scopeReferenceId: x.scopeReferenceId,
        effectiveFrom: x.effectiveFrom,
        condition:
          this.conditionOverride !== undefined
            ? this.conditionOverride
            : (this.grant(x.roleCode, code)!.condition ?? null),
      }));
  }
  async hasIneffectiveAssignment(accountId: string, code: string, when: Date) {
    return this.assignments.some(
      (x) =>
        x.accountId === accountId &&
        !this.effective(x, when) &&
        catalogGrants.has(grantKey(x.roleCode, code)),
    );
  }
  async loadCandidateGrants(code: string): Promise<GrantFact[]> {
    const grant = this.grant("CANDIDATE", code);
    return grant
      ? [
          {
            assignmentId: null,
            roleCode: "CANDIDATE",
            scopeType: null,
            scopeReferenceId: null,
            effectiveFrom: null,
            condition: grant.condition,
          },
        ]
      : [];
  }
}

/** An MFA-complete staff session, optionally with purpose-bound step-up. */
export function staffSession(
  accountId: string,
  overrides: Partial<AssuranceEvidence> = {},
): AssuranceEvidence {
  return {
    accountId,
    sessionId: sessionOf(accountId),
    sessionPurpose: "STAFF",
    method: "PASSWORD_TOTP",
    primaryAuthenticatedAt: at(-3600),
    mfaAuthenticatedAt: at(-3600),
    sessionAccountVersion: 1,
    currentAccountVersion: 1,
    reauthentication: null,
    ...overrides,
  };
}

export function candidateSession(accountId: string): AssuranceEvidence {
  return {
    ...staffSession(accountId),
    sessionPurpose: "STANDARD",
    method: "PASSWORD",
  };
}

export function captureLogger() {
  const lines: { event: string; context?: LogContext }[] = [];
  const logger: AppLogger = {
    debug: (event, context) => lines.push({ event, context }),
    info: (event, context) => lines.push({ event, context }),
    warn: (event, context) => lines.push({ event, context }),
    error: (event, context) => lines.push({ event, context }),
    child: () => logger,
  };
  return { logger, lines };
}

/** Synthetic closed workflow states for the named policy (packet §14). */
export const workflowStates = {
  allowed: ["OPEN", "IN_REVIEW"],
  disallowed: ["ON_HOLD"],
  terminal: ["WITHDRAWN", "ARCHIVED"],
  superseded: ["SUPERSEDED"],
} as const;
export const syntheticWorkflow: WorkflowPolicy = {
  code: "CANDIDACY_WORKFLOW",
  states: Object.values(workflowStates).flat(),
  permits: (_code, state) =>
    (workflowStates.allowed as readonly string[]).includes(state),
};

/** A fresh, fully isolated in-memory world for one matrix row. */
export function matrixWorld(
  options: {
    workflow?: WorkflowPolicyRegistry;
    recentWindowSeconds?: number;
  } = {},
) {
  const facts = new MatrixFacts();
  const staff = [
    account.ACTOR,
    account.OTHER_STAFF,
    account.AUDITOR,
    account.OTHER_AUDITOR,
    account.ADMIN,
    account.PASSWORD_ONLY_STAFF,
  ];
  for (const id of staff) {
    facts.accounts.set(id, { id, accountType: "STAFF", status: "ACTIVE" });
    facts.evidence.set(sessionOf(id), staffSession(id));
  }
  facts.evidence.set(
    sessionOf(account.PASSWORD_ONLY_STAFF),
    staffSession(account.PASSWORD_ONLY_STAFF, { method: "PASSWORD" }),
  );
  facts.accounts.set(account.INACTIVE_STAFF, {
    id: account.INACTIVE_STAFF,
    accountType: "STAFF",
    status: "LOCKED",
  });
  facts.evidence.set(
    sessionOf(account.INACTIVE_STAFF),
    staffSession(account.INACTIVE_STAFF),
  );
  for (const id of [account.CANDIDATE_A, account.CANDIDATE_B]) {
    facts.accounts.set(id, { id, accountType: "CANDIDATE", status: "ACTIVE" });
    facts.evidence.set(sessionOf(id), candidateSession(id));
  }
  facts.accounts.set(account.CANDIDATE_INCOMPLETE, {
    id: account.CANDIDATE_INCOMPLETE,
    accountType: "CANDIDATE",
    status: "INVITED",
  });
  facts.evidence.set(
    sessionOf(account.CANDIDATE_INCOMPLETE),
    candidateSession(account.CANDIDATE_INCOMPLETE),
  );
  facts.accounts.set(account.SERVICE, {
    id: account.SERVICE,
    accountType: "SERVICE",
    status: "ACTIVE",
  });
  facts.evidence.set(sessionOf(account.SERVICE), staffSession(account.SERVICE));

  const resolver = syntheticHierarchy({
    auditor: account.AUDITOR,
    otherAuditor: account.OTHER_AUDITOR,
    ownFileSubject: account.ACTOR,
    candidateA: account.CANDIDATE_A,
    candidateB: account.CANDIDATE_B,
  });
  const ownership = new SyntheticCandidateOwnership("test")
    .addOwnership(account.CANDIDATE_A, record.IN_TEAM)
    .addOwnership(account.CANDIDATE_B, record.IN_BRANCH);
  const events: SecurityEvent[] = [];
  const { logger, lines } = captureLogger();
  const deps: Omit<AuthorizationDependencies, "db"> = {
    resolver,
    ownership,
    workflow:
      options.workflow ?? new Map([["CANDIDACY_WORKFLOW", syntheticWorkflow]]),
    separation: new MandatorySeparationOfDutiesPolicy(),
    dualControl: restrictiveDualControl,
    clock: () => NOW,
    events: {
      record: async (e: SecurityEvent) => (events.push(e), true),
      recordInTransaction: async (_tx: unknown, e: SecurityEvent) => {
        events.push(e);
      },
    },
    logger,
    recentWindowSeconds: options.recentWindowSeconds ?? 300,
  };
  let n = 0;
  const assign = (
    accountId: string,
    roleCode: RoleCode,
    scopeType: ScopeType,
    scopeReferenceId: string,
    overrides: Partial<MatrixAssignment> = {},
  ) => {
    const assignmentId = u("a5519000", (n += 1));
    facts.assignments.push({
      assignmentId,
      accountId,
      roleCode,
      scopeType,
      scopeReferenceId,
      effectiveFrom: at(-86_400),
      effectiveTo: null,
      status: "ACTIVE",
      ...overrides,
    });
    return assignmentId;
  };
  const decide = (request: AuthorizationRequest) =>
    evaluateAuthorization(request, facts, deps);
  const query = (request: QueryScopeRequest) =>
    evaluateQueryScope(request, facts, deps);
  return {
    facts,
    resolver,
    ownership,
    deps,
    events,
    lines,
    assign,
    decide,
    query,
  };
}
export type MatrixWorld = ReturnType<typeof matrixWorld>;

/** The broadest-but-valid home scope for a role (packet §10). */
export function homeScope(role: RoleCode): { type: ScopeType; id: string } {
  const allowed = allowedScopeTypesByRole[role];
  if (allowed.includes("AUDIT_ASSIGNMENT")) {
    return { type: "AUDIT_ASSIGNMENT", id: scope.AUDIT };
  }
  return { type: "ORGANIZATION", id: scope.ORG };
}

/** Separation facts where every other party is a different actor. */
export const validSeparation = {
  proposerAccountId: account.OTHER_STAFF,
  resultEnteredByAccountId: account.OTHER_STAFF,
  changedByAccountIds: [account.OTHER_STAFF],
  priorApproverAccountIds: [account.OTHER_STAFF],
  evaluationSigned: false,
  documentedActorAccountIds: [account.OTHER_STAFF],
} as const;

/**
 * Configures `world` so that `role` holds every fact required by
 * `permission` for actorId, and returns the satisfying request (packet
 * §10: "add required valid scope/state/separation/assurance facts").
 */
export function satisfyingRequest(
  world: MatrixWorld,
  role: RoleCode,
  definition: PermissionDefinition,
  actorId: string = role === "AUDITOR_READ_ONLY"
    ? account.AUDITOR
    : account.ACTOR,
): AuthorizationRequest {
  const grant = world.facts.grant(role, definition.code);
  const condition = grant?.condition ?? null;
  if (role === "CANDIDATE") {
    return {
      principal: principalOf(account.CANDIDATE_A, "CANDIDATE"),
      permission: definition.code,
      operation: definition.operation,
      resource: {
        kind: "RECORD",
        id: record.IN_TEAM,
        sensitivity: definition.maxSensitivity,
      },
      ...(definition.workflowPolicy
        ? { workflow: { policy: definition.workflowPolicy, state: "OPEN" } }
        : {}),
      ...(definition.requiresReason ? { reasonCode: "MATRIX_TEST" } : {}),
    };
  }
  const home = homeScope(role);
  world.assign(actorId, role, home.type, home.id);
  if (condition?.kind === "DESIGNATION") {
    world.resolver.addDesignation(actorId, condition.designation, home.id);
  }
  if (condition?.kind === "PARTICIPANT") {
    world.resolver.addRelationship(
      actorId,
      record.IN_TEAM,
      condition.relationship,
    );
  }
  if (definition.recentAuth) {
    world.facts.evidence.set(
      sessionOf(actorId),
      staffSession(actorId, {
        reauthentication: {
          at: at(-10),
          method: "PASSWORD_TOTP",
          purpose: definition.recentAuth.purpose ?? "STAFF_SECURITY",
        },
      }),
    );
  }
  return {
    principal: principalOf(actorId),
    permission: definition.code,
    operation: definition.operation,
    resource: {
      kind: "RECORD",
      id: record.IN_TEAM,
      sensitivity: definition.maxSensitivity,
    },
    separation: validSeparation,
    ...(condition?.kind === "HOLD_CATEGORY"
      ? { holdCategory: condition.categories[0] }
      : {}),
    ...(definition.workflowPolicy
      ? { workflow: { policy: definition.workflowPolicy, state: "OPEN" } }
      : {}),
    ...(definition.requiresReason ? { reasonCode: "MATRIX_TEST" } : {}),
  };
}

export function expectAllow(
  decision: AuthorizationDecision,
  role: RoleCode,
): void {
  expect(decision, JSON.stringify(decision)).toMatchObject({
    decision: "ALLOW",
    effectiveRoleCode: role,
  });
}

export function expectDeny(
  decision: Readonly<{ decision: string; reasonCode: string }>,
  reason?: string,
): void {
  expect(decision.decision, JSON.stringify(decision)).toBe("DENY");
  if (reason) expect(decision.reasonCode).toBe(reason);
}

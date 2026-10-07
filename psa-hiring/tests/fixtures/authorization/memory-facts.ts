import type { AppLogger, LogContext } from "@/shared/logging";
import type { AuthorizationDependencies } from "@/modules/identity-access/application/authorize";
import type {
  AccountFact,
  AuthorizationFactsSource,
  GrantFact,
  PermissionFact,
  SubjectEpoch,
} from "@/modules/identity-access/application/ports/authorization-facts";
import type { AssuranceEvidence } from "@/modules/identity-access/domain/authentication-assurance";
import type {
  RoleCode,
  ScopeType,
} from "@/modules/identity-access/domain/authorization-vocabulary";
import {
  MandatorySeparationOfDutiesPolicy,
  restrictiveDualControl,
} from "@/modules/identity-access/domain/separation-of-duties-policy";
import {
  SyntheticCandidateOwnership,
  SyntheticScopeResolver,
} from "@/modules/identity-access/infrastructure/scope-resolvers";
import type { SecurityEvent } from "@/modules/identity-access/infrastructure/security-events";
import { permissionRow } from "@/modules/identity-access/policy/authorization-catalog";
import { findPermission } from "@/modules/identity-access/policy/permission-catalog";
import { grantCatalog } from "@/modules/identity-access/policy/role-permission-catalog";

// In-memory M1.4 facts and synthetic hierarchy for M1.5 contract unit
// tests (list/search scope, fields, envelopes, documents). Synthetic IDs
// only; APP_ENV=test adapters. The same scenarios run against real
// PostgreSQL in tests/integration/authorization/route-object-field.test.ts.

export const sid = (n: number) =>
  `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;

export const ids = {
  ORG: sid(1),
  ORG2: sid(2),
  BRANCH: sid(3),
  BRANCH2: sid(4),
  TEAM: sid(5),
  SET: sid(6),
  AUDIT: sid(7),
  GROUP: sid(8),
  ORG2_BRANCH: sid(9),
  RECORD: sid(30),
  RECORD_BRANCH2: sid(31),
  RECORD_ORG2: sid(32),
  RECORD_OWN_FILE: sid(33),
  STAFF: sid(40),
  SESSION: sid(41),
  CANDIDATE: sid(43),
  CANDIDATE_SESSION: sid(44),
  CANDIDATE_B: sid(45),
} as const;

export const NOW = new Date("2026-10-06T12:00:00.000Z");
export const ago = (s: number) => new Date(NOW.getTime() - s * 1000);
const later = (s: number) => new Date(NOW.getTime() + s * 1000);

type Assignment = Readonly<{
  assignmentId: string;
  roleCode: RoleCode;
  scopeType: ScopeType;
  scopeReferenceId: string;
  effectiveFrom: Date;
}>;

export class MemoryFacts implements AuthorizationFactsSource {
  accounts = new Map<string, AccountFact>();
  evidence = new Map<string, AssuranceEvidence>();
  assignments: Assignment[] = [];
  epoch: SubjectEpoch | null = null;

  async loadAccount(accountId: string) {
    return this.accounts.get(accountId) ?? null;
  }
  async loadAssurance(accountId: string, sessionId: string) {
    const e = this.evidence.get(sessionId);
    return e && e.accountId === accountId ? e : null;
  }
  async loadSubjectEpoch() {
    return this.epoch;
  }
  async loadPermission(code: string): Promise<PermissionFact | null> {
    const definition = findPermission(code);
    return definition
      ? { ...permissionRow(definition), catalogVersion: 1 }
      : null;
  }
  private grant(roleCode: string, code: string) {
    return grantCatalog.find(
      (g) =>
        g.roleCode === roleCode &&
        g.permissionCode === code &&
        g.status === "ACTIVE",
    );
  }
  async loadStaffGrants(accountId: string, code: string): Promise<GrantFact[]> {
    if (accountId !== ids.STAFF) return [];
    return this.assignments
      .filter((a) => this.grant(a.roleCode, code))
      .map((a) => ({
        assignmentId: a.assignmentId,
        roleCode: a.roleCode,
        scopeType: a.scopeType,
        scopeReferenceId: a.scopeReferenceId,
        effectiveFrom: a.effectiveFrom,
        condition: this.grant(a.roleCode, code)!.condition ?? null,
      }));
  }
  async hasIneffectiveAssignment() {
    return false;
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

export function staffEvidence(
  overrides: Partial<AssuranceEvidence> = {},
): AssuranceEvidence {
  return {
    accountId: ids.STAFF,
    sessionId: ids.SESSION,
    sessionPurpose: "STAFF",
    method: "PASSWORD_TOTP",
    primaryAuthenticatedAt: ago(3600),
    mfaAuthenticatedAt: ago(3600),
    sessionAccountVersion: 1,
    currentAccountVersion: 1,
    reauthentication: null,
    ...overrides,
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

export const staffPrincipal = {
  accountId: ids.STAFF,
  accountType: "STAFF",
  sessionId: ids.SESSION,
} as const;
export const candidatePrincipal = {
  accountId: ids.CANDIDATE,
  accountType: "CANDIDATE",
  sessionId: ids.CANDIDATE_SESSION,
} as const;

export function memoryAuthorization() {
  const facts = new MemoryFacts();
  facts.accounts.set(ids.STAFF, {
    id: ids.STAFF,
    accountType: "STAFF",
    status: "ACTIVE",
  });
  facts.accounts.set(ids.CANDIDATE, {
    id: ids.CANDIDATE,
    accountType: "CANDIDATE",
    status: "ACTIVE",
  });
  facts.evidence.set(ids.SESSION, staffEvidence());
  facts.evidence.set(ids.CANDIDATE_SESSION, {
    ...staffEvidence({
      accountId: ids.CANDIDATE,
      sessionId: ids.CANDIDATE_SESSION,
    }),
    sessionPurpose: "STANDARD",
    method: "PASSWORD",
  });
  const resolver = new SyntheticScopeResolver("test")
    .addOrganization(ids.ORG)
    .addOrganization(ids.ORG2)
    .addBranch(ids.BRANCH, ids.ORG)
    .addBranch(ids.BRANCH2, ids.ORG)
    .addBranch(ids.ORG2_BRANCH, ids.ORG2)
    .addTeam(ids.TEAM, ids.BRANCH)
    .addAssignmentSet(ids.SET, ids.ORG)
    .addAuditAssignment(ids.AUDIT, {
      organizationId: ids.ORG,
      auditorAccountId: ids.STAFF,
      categories: ["CONFIDENTIAL_PERSONNEL"],
      recordGroupIds: [ids.GROUP],
      recordsFrom: new Date("2026-01-01T00:00:00Z"),
      recordsTo: new Date("2026-07-01T00:00:00Z"),
      startsAt: ago(86_400),
      endsAt: later(86_400),
    })
    .addRecord(ids.RECORD, {
      organizationId: ids.ORG,
      branchId: ids.BRANCH,
      teamId: ids.TEAM,
      assignmentSetIds: [ids.SET],
      recordGroupIds: [ids.GROUP],
      recordedAt: new Date("2026-03-01T00:00:00Z"),
      subjectAccountIds: [ids.CANDIDATE],
    })
    .addRecord(ids.RECORD_BRANCH2, {
      organizationId: ids.ORG,
      branchId: ids.BRANCH2,
      subjectAccountIds: [ids.CANDIDATE_B],
    })
    .addRecord(ids.RECORD_ORG2, {
      organizationId: ids.ORG2,
      branchId: ids.ORG2_BRANCH,
      subjectAccountIds: [],
    })
    .addRecord(ids.RECORD_OWN_FILE, {
      organizationId: ids.ORG,
      branchId: ids.BRANCH,
      teamId: ids.TEAM,
      subjectAccountIds: [ids.STAFF],
    });
  const ownership = new SyntheticCandidateOwnership("test").addOwnership(
    ids.CANDIDATE,
    ids.RECORD,
  );
  const events: SecurityEvent[] = [];
  const { logger, lines } = captureLogger();
  const deps: Omit<AuthorizationDependencies, "db"> = {
    resolver,
    ownership,
    workflow: new Map(),
    separation: new MandatorySeparationOfDutiesPolicy(),
    dualControl: restrictiveDualControl,
    clock: () => NOW,
    events: { record: (e: SecurityEvent) => events.push(e) },
    logger,
    recentWindowSeconds: 300,
  };
  let n = 100;
  const assign = (roleCode: RoleCode, scopeType: ScopeType, ref: string) => {
    facts.assignments.push({
      assignmentId: sid((n += 1)),
      roleCode,
      scopeType,
      scopeReferenceId: ref,
      effectiveFrom: ago(86_400),
    });
  };
  return { facts, deps, events, lines, assign, resolver, ownership };
}

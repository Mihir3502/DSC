import "server-only";
import {
  withAuditedTransaction,
  type EffectiveAuthority,
} from "@/modules/audit";
import { pgErrorCode } from "@/shared/database/errors";
import type { Principal } from "./current-account";
import {
  isRoleCode,
  isScopeType,
  isUuid,
  type AssignmentReasonCode,
  type RevocationReasonCode,
  type RoleCode,
  type ScopeType,
} from "../domain/authorization-vocabulary";
import type { AuthorizationRequest } from "../domain/authorization-decision";
import {
  decideApproval,
  decideRejection,
  decideRevocation,
  findOverlap,
  validateProposal,
  type AssignmentRefusal,
} from "../domain/role-assignment";
import { isValidDescriptor } from "../domain/scope-policy";
import { AUTHORIZATION_POLICY_VERSION } from "../policy/authorization-catalog";
import { findPermission } from "../policy/permission-catalog";
import {
  bumpAccountVersion,
  deleteAllSessions,
  lockAccountForUpdate,
} from "../infrastructure/account-repository";
import type { AssignmentHarnessGate } from "../infrastructure/assignment-harness";
import type { Executor } from "../infrastructure/authorization-repository";
import {
  activateAssignment,
  bumpAuthorizationVersion,
  endAssignment,
  findAssignment,
  findRoleByCode,
  insertProposedAssignment,
  listOpenAssignments,
  listSubjectAssignments,
  type StoredAssignment,
} from "../infrastructure/role-assignment-repository";
import type { SecurityEvent } from "../infrastructure/security-events";
import {
  authorizeInTransaction,
  type AuthorizationDependencies,
} from "./authorize";

// Role/scope assignment commands (packet M1.4 §9, §13.3, §15, ADR-0005).
// Application commands only: no Route Handler, Server Action, page, or CLI
// exposes them in M1.4 (a guard test enforces this).
//
// Every command:
// - authorizes the actor inside its own transaction through the central
//   service (role_assignment.propose/approve/revoke/read), which requires
//   current staff MFA, the named recent-auth policy, and an administrative
//   scope containing the target scope;
// - locks the subject's account row FOR UPDATE, serializing against
//   authorization reads (FOR SHARE), restrictions, and other changes;
// - never lets a subject create, approve, extend, or revoke their own
//   access, and never lets a requester approve their own request;
// - uses optimistic `version` checks for competing changes.
//
// Approval, revocation, and supersession increment the subject's
// authorization epoch and account version and delete the subject's
// sessions in the same transaction (privilege change ⇒ fresh MFA session).
// Their audit events (with the actor's effective authority and record
// versions) are appended inside that same transaction (M1.6, ADR-0012):
// the change and its evidence commit or roll back together.

export type AssignmentActor =
  | Readonly<{ kind: "ACCOUNT"; principal: Principal }>
  /** Test harness only; refused unless NonproductionAssignmentHarness. */
  | Readonly<{ kind: "BOOTSTRAP"; reason: "TEST_HARNESS"; accountId: string }>;

export type RoleAssignmentDependencies = AuthorizationDependencies &
  Readonly<{ harness: AssignmentHarnessGate }>;

export type AssignmentResult =
  | Readonly<{ kind: "PROPOSED"; assignmentId: string; version: number }>
  | Readonly<{ kind: "APPROVED"; assignmentId: string; version: number }>
  | Readonly<{ kind: "REJECTED"; assignmentId: string; version: number }>
  | Readonly<{ kind: "REVOKED"; assignmentId: string; version: number }>
  | Readonly<{ kind: "REFUSED"; reason: AssignmentRefusal }>;

export type ProposeAssignmentInput = Readonly<{
  subjectAccountId: string;
  roleCode: string;
  scopeType: string;
  scopeReferenceId: string;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  reasonCode: string;
  reasonReference?: string | null;
}>;

class Refusal extends Error {
  constructor(readonly reason: AssignmentRefusal) {
    super(reason);
  }
}

const refuse = (reason: AssignmentRefusal): never => {
  throw new Refusal(reason);
};

/** Per-attempt facts gathered while authorizing the actor. */
type RunContext = {
  effective: EffectiveAuthority | null;
  /** A high-risk denial event was already recorded by the authorizer. */
  deniedRecorded: boolean;
};

/** Actor facts for an event: the acting account, or the test harness. */
function actorFacts(actor: AssignmentActor) {
  return actor.kind === "ACCOUNT"
    ? ({ actorRef: actor.principal.accountId } as const)
    : ({ systemActor: "TEST_HARNESS" } as const);
}

function actorId(actor: AssignmentActor): string {
  return actor.kind === "ACCOUNT" ? actor.principal.accountId : actor.accountId;
}

/** Authorizes the actor for a role_assignment.* permission on a scope. */
async function authorizeActor(
  tx: Executor,
  actor: AssignmentActor,
  permission:
    | "role_assignment.propose"
    | "role_assignment.approve"
    | "role_assignment.revoke"
    | "role_assignment.read",
  scopeType: ScopeType,
  scopeReferenceId: string,
  reasonCode: string | undefined,
  deps: RoleAssignmentDependencies,
  ctx: RunContext,
): Promise<void> {
  if (actor.kind === "BOOTSTRAP") {
    if (
      actor.reason !== "TEST_HARNESS" ||
      !deps.harness.allowsBootstrap() ||
      !isUuid(actor.accountId)
    ) {
      refuse("NOT_AUTHORIZED");
    }
    return;
  }
  const request: AuthorizationRequest = {
    principal: {
      accountId: actor.principal.accountId,
      accountType: actor.principal.accountType,
      sessionId: actor.principal.sessionId,
    },
    permission,
    operation: permission === "role_assignment.read" ? "READ" : "ADMINISTER",
    resource: {
      kind: "SCOPE",
      scopeType,
      id: scopeReferenceId,
      sensitivity: "INTERNAL",
    },
    ...(reasonCode ? { reasonCode } : {}),
  };
  const decision = await authorizeInTransaction(tx, request, deps);
  if (decision.decision !== "ALLOW") {
    ctx.deniedRecorded = findPermission(permission)?.highRisk === true;
    refuse("NOT_AUTHORIZED");
    return;
  }
  ctx.effective = {
    roleCode: decision.effectiveRoleCode,
    assignmentId: decision.effectiveAssignmentId,
    scopeType: decision.effectiveScopeType,
    scopeReferenceId: decision.effectiveScopeReferenceId,
  };
}

/** The target scope must resolve ACTIVE now through an approved adapter. */
async function requireResolvedScope(
  scopeType: ScopeType,
  scopeReferenceId: string,
  subjectAccountId: string,
  now: Date,
  deps: RoleAssignmentDependencies,
) {
  const resolved = await deps.resolver.resolveScope(
    scopeType,
    scopeReferenceId,
    now,
    {},
  );
  if (
    resolved.status !== "ACTIVE" ||
    !isValidDescriptor(resolved.descriptor, scopeType, scopeReferenceId)
  ) {
    refuse("SCOPE_UNRESOLVED");
  }
  // An audit assignment belongs to exactly one auditor.
  if (
    resolved.status === "ACTIVE" &&
    resolved.descriptor.type === "AUDIT_ASSIGNMENT" &&
    resolved.descriptor.auditorAccountId !== subjectAccountId
  ) {
    refuse("SCOPE_UNRESOLVED");
  }
}

/** Privilege change: epoch, account version, and sessions, atomically. */
async function applySubjectChange(
  tx: Executor,
  subjectAccountId: string,
  now: Date,
  events: SecurityEvent[],
) {
  const version = await bumpAuthorizationVersion(tx, subjectAccountId, now);
  await bumpAccountVersion(tx, subjectAccountId, now);
  await deleteAllSessions(tx, subjectAccountId);
  events.push({
    code: "authz.subject_version_changed",
    accountRef: subjectAccountId,
    ...(version > 1 ? { previousVersion: version - 1 } : {}),
    newVersion: version,
    policyVersion: AUTHORIZATION_POLICY_VERSION,
  });
}

async function run(
  deps: RoleAssignmentDependencies,
  actor: AssignmentActor,
  refusal: Readonly<{ recordRef?: string; roleCode?: string }>,
  body: (
    tx: Executor,
    events: SecurityEvent[],
    ctx: RunContext,
  ) => Promise<AssignmentResult>,
): Promise<AssignmentResult> {
  const ctx: RunContext = { effective: null, deniedRecorded: false };
  try {
    return await withAuditedTransaction(deps, async (tx, audit) => {
      ctx.effective = null;
      ctx.deniedRecorded = false;
      const events: SecurityEvent[] = [];
      const result = await body(tx, events, ctx);
      for (const event of events) {
        await audit.append({
          ...event,
          ...actorFacts(actor),
          ...(ctx.effective && event.code !== "authz.subject_version_changed"
            ? { effective: ctx.effective }
            : {}),
        });
      }
      return result;
    });
  } catch (error) {
    const reason: AssignmentRefusal =
      error instanceof Refusal
        ? error.reason
        : (() => {
            const code = pgErrorCode(error);
            // Serialization/deadlock and lost races resolve as stale.
            if (code === "40001" || code === "40P01") return "STALE_VERSION";
            // Constraint violations are refusals, never raw errors.
            if (code?.startsWith("23")) return "INVALID_STATE";
            throw error;
          })();
    // One event per refusal: an authorization denial of a high-risk
    // permission was already recorded once by the authorization service.
    if (!(reason === "NOT_AUTHORIZED" && ctx.deniedRecorded)) {
      await deps.events.record({
        code: "authz.assignment_refused",
        category: "denied",
        ...(actor.kind === "ACCOUNT"
          ? { accountRef: actor.principal.accountId }
          : {}),
        ...(refusal.recordRef && isUuid(refusal.recordRef)
          ? { recordRef: refusal.recordRef }
          : {}),
        ...(refusal.roleCode ? { roleCode: refusal.roleCode } : {}),
        reasonCode: reason,
        policyVersion: AUTHORIZATION_POLICY_VERSION,
      });
    }
    return { kind: "REFUSED", reason };
  }
}

/**
 * Proposes a new assignment (PROPOSED; grants nothing until approved).
 * With `replacesAssignmentId`, proposes the successor in a
 * revoke-and-create change of role, scope, or effective dates.
 */
export function proposeRoleAssignment(
  input: ProposeAssignmentInput & Readonly<{ replacesAssignmentId?: string }>,
  actor: AssignmentActor,
  deps: RoleAssignmentDependencies,
): Promise<AssignmentResult> {
  const roleCode = isRoleCode(input.roleCode) ? input.roleCode : null;
  return run(
    deps,
    actor,
    { roleCode: roleCode ?? undefined },
    async (tx, events, ctx) => {
      if (!roleCode) refuse("ROLE_UNAVAILABLE");
      if (!isScopeType(input.scopeType)) refuse("SCOPE_NOT_ALLOWED_FOR_ROLE");
      if (!isUuid(input.scopeReferenceId)) refuse("SCOPE_UNRESOLVED");
      if (!isUuid(input.subjectAccountId)) refuse("SUBJECT_NOT_STAFF");
      const scopeType = input.scopeType as ScopeType;
      const now = deps.clock();
      const creator = actorId(actor);

      await authorizeActor(
        tx,
        actor,
        "role_assignment.propose",
        scopeType,
        input.scopeReferenceId,
        input.reasonCode,
        deps,
        ctx,
      );
      const subject = await lockAccountForUpdate(tx, input.subjectAccountId);
      const role = await findRoleByCode(tx, roleCode!);
      const problem = validateProposal({
        actorAccountId: creator,
        subject,
        role,
        scopeType,
        scopeReferenceId: input.scopeReferenceId,
        effectiveFrom: input.effectiveFrom,
        effectiveTo: input.effectiveTo,
        reasonCode: input.reasonCode,
        reasonReference: input.reasonReference,
      });
      if (problem) refuse(problem);
      await requireResolvedScope(
        scopeType,
        input.scopeReferenceId,
        input.subjectAccountId,
        now,
        deps,
      );

      let replaced: StoredAssignment | null = null;
      if (input.replacesAssignmentId !== undefined) {
        replaced = await findAssignment(tx, input.replacesAssignmentId, true);
        if (
          !replaced ||
          replaced.userAccountId !== input.subjectAccountId ||
          replaced.status !== "ACTIVE"
        ) {
          refuse("INVALID_STATE");
        }
      }
      const open = await listOpenAssignments(tx, input.subjectAccountId);
      if (
        findOverlap(
          {
            userAccountId: input.subjectAccountId,
            roleCode: roleCode!,
            scopeType,
            scopeReferenceId: input.scopeReferenceId,
            effectiveFrom: input.effectiveFrom,
            effectiveTo: input.effectiveTo,
          },
          open,
          replaced ? [replaced.id] : [],
        )
      ) {
        refuse("OVERLAPPING_ASSIGNMENT");
      }

      const assignmentId = await insertProposedAssignment(tx, {
        userAccountId: input.subjectAccountId,
        roleId: role!.id,
        scopeType,
        scopeReferenceId: input.scopeReferenceId,
        effectiveFrom: input.effectiveFrom,
        effectiveTo: input.effectiveTo,
        reasonCode: input.reasonCode as AssignmentReasonCode,
        reasonReference: input.reasonReference ?? null,
        createdByUserId: creator,
        replacesAssignmentId: replaced?.id ?? null,
        now,
      });
      events.push({
        code: "authz.assignment_proposed",
        accountRef: input.subjectAccountId,
        recordRef: assignmentId,
        roleCode: roleCode!,
        scopeType,
        reasonCode: input.reasonCode,
        newVersion: 1,
        policyVersion: AUTHORIZATION_POLICY_VERSION,
      });
      return { kind: "PROPOSED", assignmentId, version: 1 };
    },
  );
}

/** Revoke-and-create: proposes a successor; approval supersedes the old. */
export function replaceRoleAssignment(
  replacesAssignmentId: string,
  input: ProposeAssignmentInput,
  actor: AssignmentActor,
  deps: RoleAssignmentDependencies,
): Promise<AssignmentResult> {
  return proposeRoleAssignment({ ...input, replacesAssignmentId }, actor, deps);
}

/** PROPOSED → ACTIVE by a distinct authorized approver. */
export function approveRoleAssignment(
  input: Readonly<{ assignmentId: string; expectedVersion: number }>,
  actor: AssignmentActor,
  deps: RoleAssignmentDependencies,
): Promise<AssignmentResult> {
  return run(
    deps,
    actor,
    { recordRef: input.assignmentId },
    async (tx, events, ctx) => {
      const now = deps.clock();
      const approver = actorId(actor);
      const assignment = await findAssignment(tx, input.assignmentId, true);
      if (!assignment) refuse("NOT_FOUND");
      const a = assignment!;
      await authorizeActor(
        tx,
        actor,
        "role_assignment.approve",
        a.scopeType,
        a.scopeReferenceId,
        "ASSIGNMENT_APPROVAL",
        deps,
        ctx,
      );
      const subject = await lockAccountForUpdate(tx, a.userAccountId);
      if (!subject || subject.accountType !== "STAFF")
        refuse("SUBJECT_NOT_STAFF");
      if (subject!.status !== "ACTIVE" && subject!.status !== "INVITED") {
        refuse("SUBJECT_NOT_STAFF");
      }
      const problem = decideApproval(a, approver, input.expectedVersion, now);
      if (problem) refuse(problem);
      const role = await findRoleByCode(tx, a.roleCode);
      if (!role || role.status !== "ACTIVE" || role.principalType !== "STAFF") {
        refuse("ROLE_UNAVAILABLE");
      }
      await requireResolvedScope(
        a.scopeType,
        a.scopeReferenceId,
        a.userAccountId,
        now,
        deps,
      );
      const open = await listOpenAssignments(tx, a.userAccountId);
      const activeOnly = open.filter((row) => row.status === "ACTIVE");
      if (
        findOverlap(a, activeOnly, [
          a.id,
          ...(a.replacesAssignmentId ? [a.replacesAssignmentId] : []),
        ])
      ) {
        refuse("OVERLAPPING_ASSIGNMENT");
      }

      if (a.replacesAssignmentId) {
        const replaced = await findAssignment(tx, a.replacesAssignmentId, true);
        if (!replaced || replaced.status !== "ACTIVE") refuse("INVALID_STATE");
        const superseded = await endAssignment(tx, {
          assignmentId: replaced!.id,
          from: "ACTIVE",
          to: "SUPERSEDED",
          expectedVersion: replaced!.version,
          actorId: approver,
          reasonCode: "SUPERSEDED",
          supersededById: a.id,
          now,
        });
        if (!superseded) refuse("STALE_VERSION");
        events.push({
          code: "authz.assignment_superseded",
          accountRef: a.userAccountId,
          recordRef: replaced!.id,
          roleCode: replaced!.roleCode,
          scopeType: replaced!.scopeType,
          reasonCode: "SUPERSEDED",
          previousVersion: replaced!.version,
          newVersion: replaced!.version + 1,
          policyVersion: AUTHORIZATION_POLICY_VERSION,
        });
      }
      if (
        !(await activateAssignment(
          tx,
          a.id,
          input.expectedVersion,
          approver,
          now,
        ))
      ) {
        refuse("STALE_VERSION");
      }
      events.push({
        code: "authz.assignment_approved",
        accountRef: a.userAccountId,
        recordRef: a.id,
        roleCode: a.roleCode,
        scopeType: a.scopeType,
        previousVersion: input.expectedVersion,
        newVersion: input.expectedVersion + 1,
        policyVersion: AUTHORIZATION_POLICY_VERSION,
      });
      await applySubjectChange(tx, a.userAccountId, now, events);
      return {
        kind: "APPROVED",
        assignmentId: a.id,
        version: input.expectedVersion + 1,
      };
    },
  );
}

/** PROPOSED → REJECTED. Grants nothing, so no session effect. */
export function rejectRoleAssignment(
  input: Readonly<{
    assignmentId: string;
    expectedVersion: number;
    reasonCode: string;
  }>,
  actor: AssignmentActor,
  deps: RoleAssignmentDependencies,
): Promise<AssignmentResult> {
  return run(
    deps,
    actor,
    { recordRef: input.assignmentId },
    async (tx, events, ctx) => {
      const now = deps.clock();
      const assignment = await findAssignment(tx, input.assignmentId, true);
      if (!assignment) refuse("NOT_FOUND");
      const a = assignment!;
      await authorizeActor(
        tx,
        actor,
        "role_assignment.approve",
        a.scopeType,
        a.scopeReferenceId,
        input.reasonCode,
        deps,
        ctx,
      );
      const problem = decideRejection(
        a,
        actorId(actor),
        input.expectedVersion,
        input.reasonCode,
      );
      if (problem) refuse(problem);
      const ended = await endAssignment(tx, {
        assignmentId: a.id,
        from: "PROPOSED",
        to: "REJECTED",
        expectedVersion: input.expectedVersion,
        actorId: actorId(actor),
        reasonCode: input.reasonCode as RevocationReasonCode,
        now,
      });
      if (!ended) refuse("STALE_VERSION");
      events.push({
        code: "authz.assignment_rejected",
        accountRef: a.userAccountId,
        recordRef: a.id,
        roleCode: a.roleCode,
        scopeType: a.scopeType,
        reasonCode: input.reasonCode,
        previousVersion: input.expectedVersion,
        newVersion: input.expectedVersion + 1,
        policyVersion: AUTHORIZATION_POLICY_VERSION,
      });
      return {
        kind: "REJECTED",
        assignmentId: a.id,
        version: input.expectedVersion + 1,
      };
    },
  );
}

/** ACTIVE → REVOKED. Takes effect on the very next decision. */
export function revokeRoleAssignment(
  input: Readonly<{
    assignmentId: string;
    expectedVersion: number;
    reasonCode: string;
  }>,
  actor: AssignmentActor,
  deps: RoleAssignmentDependencies,
): Promise<AssignmentResult> {
  return run(
    deps,
    actor,
    { recordRef: input.assignmentId },
    async (tx, events, ctx) => {
      const now = deps.clock();
      const assignment = await findAssignment(tx, input.assignmentId, true);
      if (!assignment) refuse("NOT_FOUND");
      const a = assignment!;
      await authorizeActor(
        tx,
        actor,
        "role_assignment.revoke",
        a.scopeType,
        a.scopeReferenceId,
        input.reasonCode,
        deps,
        ctx,
      );
      await lockAccountForUpdate(tx, a.userAccountId);
      const problem = decideRevocation(
        a,
        actorId(actor),
        input.expectedVersion,
        input.reasonCode,
      );
      if (problem) refuse(problem);
      const ended = await endAssignment(tx, {
        assignmentId: a.id,
        from: "ACTIVE",
        to: "REVOKED",
        expectedVersion: input.expectedVersion,
        actorId: actorId(actor),
        reasonCode: input.reasonCode as RevocationReasonCode,
        now,
      });
      if (!ended) refuse("STALE_VERSION");
      events.push({
        code: "authz.assignment_revoked",
        accountRef: a.userAccountId,
        recordRef: a.id,
        roleCode: a.roleCode,
        scopeType: a.scopeType,
        reasonCode: input.reasonCode,
        previousVersion: input.expectedVersion,
        newVersion: input.expectedVersion + 1,
        policyVersion: AUTHORIZATION_POLICY_VERSION,
      });
      await applySubjectChange(tx, a.userAccountId, now, events);
      return {
        kind: "REVOKED",
        assignmentId: a.id,
        version: input.expectedVersion + 1,
      };
    },
  );
}

export type AssignmentSummary = Readonly<{
  assignmentId: string;
  roleCode: RoleCode;
  scopeType: ScopeType;
  scopeReferenceId: string;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  status: string;
  version: number;
}>;

/**
 * Lists a subject's assignments for an explicitly authorized caller: each
 * row is returned only if the caller holds role_assignment.read on its
 * scope. Never includes reason references or actor identities.
 */
export async function listRoleAssignments(
  subjectAccountId: string,
  actor: Readonly<{ kind: "ACCOUNT"; principal: Principal }>,
  deps: RoleAssignmentDependencies,
): Promise<readonly AssignmentSummary[]> {
  if (!isUuid(subjectAccountId)) return [];
  // A read: no mutation or success event, but denials raised inside are
  // deferred until the transaction settles (withAuditedTransaction).
  return withAuditedTransaction(deps, async (tx) => {
    const rows = await listSubjectAssignments(tx, subjectAccountId);
    const visible: AssignmentSummary[] = [];
    for (const row of rows) {
      try {
        await authorizeActor(
          tx,
          actor,
          "role_assignment.read",
          row.scopeType,
          row.scopeReferenceId,
          undefined,
          deps,
          { effective: null, deniedRecorded: false },
        );
      } catch (error) {
        if (error instanceof Refusal) continue;
        throw error;
      }
      visible.push(
        Object.freeze({
          assignmentId: row.id,
          roleCode: row.roleCode,
          scopeType: row.scopeType,
          scopeReferenceId: row.scopeReferenceId,
          effectiveFrom: row.effectiveFrom,
          effectiveTo: row.effectiveTo,
          status: row.status,
          version: row.version,
        }),
      );
    }
    return visible;
  });
}

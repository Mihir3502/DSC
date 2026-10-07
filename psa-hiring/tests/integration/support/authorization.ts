import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { expect } from "vitest";
import {
  beginStaffActivation,
  completeStaffActivation,
  verifyStaffEnrollment,
} from "@/modules/identity-access/application/activate-staff-account";
import {
  authorizationDependencies,
  roleAssignmentDependencies,
} from "@/modules/identity-access/application/authorization-support";
import type { Principal } from "@/modules/identity-access/application/current-account";
import { issueStaffInvitation } from "@/modules/identity-access/application/issue-staff-invitation";
import {
  resolveCurrentStaff,
  verifyStaffStepUp,
} from "@/modules/identity-access/application/reauthenticate-staff";
import {
  approveRoleAssignment,
  proposeRoleAssignment,
  type AssignmentActor,
} from "@/modules/identity-access/application/role-assignments";
import {
  completeStaffMfa,
  signInStaff,
} from "@/modules/identity-access/application/sign-in-staff";
import type { ReauthenticationPurpose } from "@/modules/identity-access/domain/authentication-assurance";
import type {
  RoleCode,
  ScopeType,
} from "@/modules/identity-access/domain/authorization-vocabulary";
import { FixedWindowRateLimiter } from "@/modules/identity-access/infrastructure/action-rate-limiter";
import { NonproductionAssignmentHarness } from "@/modules/identity-access/infrastructure/assignment-harness";
import { parseAuthEnv } from "@/modules/identity-access/infrastructure/auth-env";
import { InMemoryEmailCapture } from "@/modules/identity-access/infrastructure/auth-email";
import {
  createIdentityRuntime,
  type IdentityRuntime,
} from "@/modules/identity-access/infrastructure/runtime";
import {
  SyntheticCandidateOwnership,
  SyntheticScopeResolver,
} from "@/modules/identity-access/infrastructure/scope-resolvers";
import type { SecurityEvent } from "@/modules/identity-access/infrastructure/security-events";
import { createAuditRecorder, type EventRecorder } from "@/modules/audit";
import { NonproductionHarnessGate } from "@/modules/identity-access/infrastructure/staff-administration-gate";
import type { WorkflowPolicyRegistry } from "@/modules/identity-access/policy/workflow-policies";
import { getDatabase } from "@/shared/database";
import { createLogger } from "@/shared/logging";
import { nextTestEmail } from "../../fixtures/auth/accounts";
import { CookieJar } from "../../fixtures/auth/cookie-jar";
import { secretFromManualKey, totpCode } from "../../fixtures/auth/totp";
import { createMemoryDestination } from "../../fixtures/canaries";
import {
  adminClient,
  assertNoSecrets,
  buildHarnessEnv,
  createOwnedDatabase,
  runDbScript,
  type HarnessContext,
  type OwnedDatabase,
} from "./harness";

// Shared M1.4 integration support: a test-only identity runtime with the
// deterministic synthetic scope resolver and assignment harness, real
// staff activation/sign-in/step-up through the M1.3 commands, and
// bootstrap grants. APP_ENV=test only (the adapters refuse otherwise).
// Synthetic data only.

export const BASE = "http://127.0.0.1:3100";
export const STAFF_PASSWORD = "TEST staff long passphrase 0001";

export const syntheticId = (n: number) =>
  `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;

/** A deterministic synthetic organization hierarchy. */
export const scopes = {
  ORG: syntheticId(1),
  ORG2: syntheticId(2),
  BRANCH: syntheticId(3),
  BRANCH2: syntheticId(4),
  TEAM: syntheticId(5),
  SET: syntheticId(6),
  ORG2_BRANCH: syntheticId(9),
  RECORD: syntheticId(30),
  RECORD_BRANCH2: syntheticId(31),
  RECORD_ORG2: syntheticId(32),
} as const;

export function headers(jar?: CookieJar): Headers {
  const h = new Headers({
    origin: BASE,
    "x-forwarded-for": `198.51.100.${Math.floor(Math.random() * 250) + 1}`,
    "user-agent": `TEST-agent-${randomUUID()}`,
  });
  const cookie = jar?.header();
  if (cookie) h.set("cookie", cookie);
  return h;
}

export type StaffMember = {
  email: string;
  accountId: string;
  secret: string;
  /** Next unused TOTP step offset (codes are single-use). */
  nextOffset: number;
};

export type AuthorizationHarness = Readonly<{
  runtime: IdentityRuntime;
  resolver: SyntheticScopeResolver;
  ownership: SyntheticCandidateOwnership;
  events: SecurityEvent[];
  logs: ReturnType<typeof createMemoryDestination>;
  capture: InMemoryEmailCapture;
}>;

/** Wraps a recorder, capturing each event before it is persisted. */
export function capturingRecorder(
  inner: EventRecorder,
  events: SecurityEvent[],
): EventRecorder {
  return {
    record(event) {
      events.push(event);
      return inner.record(event);
    },
    recordInTransaction(tx, event) {
      events.push(event);
      return inner.recordInTransaction(tx, event);
    },
  };
}

export function createAuthorizationHarness(
  options: { workflow?: WorkflowPolicyRegistry } = {},
): AuthorizationHarness {
  const capture = new InMemoryEmailCapture();
  const logs = createMemoryDestination();
  const logger = createLogger({ destination: logs });
  const resolver = new SyntheticScopeResolver(process.env.APP_ENV)
    .addOrganization(scopes.ORG)
    .addOrganization(scopes.ORG2)
    .addBranch(scopes.BRANCH, scopes.ORG)
    .addBranch(scopes.BRANCH2, scopes.ORG)
    .addBranch(scopes.ORG2_BRANCH, scopes.ORG2)
    .addTeam(scopes.TEAM, scopes.BRANCH)
    .addAssignmentSet(scopes.SET, scopes.ORG)
    .addRecord(scopes.RECORD, {
      organizationId: scopes.ORG,
      branchId: scopes.BRANCH,
      teamId: scopes.TEAM,
      assignmentSetIds: [scopes.SET],
    })
    .addRecord(scopes.RECORD_BRANCH2, {
      organizationId: scopes.ORG,
      branchId: scopes.BRANCH2,
    })
    .addRecord(scopes.RECORD_ORG2, {
      organizationId: scopes.ORG2,
      branchId: scopes.ORG2_BRANCH,
    });
  const ownership = new SyntheticCandidateOwnership(process.env.APP_ENV);
  const events: SecurityEvent[] = [];
  const durable = createAuditRecorder({ db: getDatabase(), logger });
  const base = createIdentityRuntime({
    env: parseAuthEnv(process.env),
    db: getDatabase(),
    logger,
    transport: capture,
    limiter: new FixedWindowRateLimiter(),
    staffAdmin: new NonproductionHarnessGate("test"),
    authorization: {
      resolver,
      ownership,
      ...(options.workflow ? { workflow: options.workflow } : {}),
    },
    assignmentHarness: new NonproductionAssignmentHarness(process.env.APP_ENV),
    // Every event (including Better Auth hook events) is captured for
    // assertions and then persisted by the real durable recorder.
    events: capturingRecorder(durable, events),
  });
  return { runtime: base, resolver, ownership, events, logs, capture };
}

export const authzDeps = (h: AuthorizationHarness) =>
  authorizationDependencies(h.runtime);
export const assignmentDeps = (h: AuthorizationHarness) =>
  roleAssignmentDependencies(h.runtime);

/** Invite → password → TOTP → backup codes → ACTIVE staff account. */
export async function activateStaff(
  h: AuthorizationHarness,
  label: string,
): Promise<StaffMember> {
  const email = nextTestEmail(label);
  expect(
    await issueStaffInvitation(
      { email, actor: { kind: "BOOTSTRAP", reason: "TEST_HARNESS" } },
      h.runtime,
    ),
  ).toEqual({ kind: "ACCEPTED" });
  const message = await h.capture.waitFor(email, "STAFF_INVITATION", 1);
  const token = /#invite=([A-Za-z0-9_-]{43})/.exec(message.text)![1]!;
  const jar = new CookieJar();
  const begun = await beginStaffActivation(
    { token, password: STAFF_PASSWORD, passwordConfirmation: STAFF_PASSWORD },
    headers(jar),
    h.runtime,
  );
  if (begun.kind !== "ENROLLMENT_STARTED") throw new Error(begun.kind);
  jar.apply(begun.setCookies);
  const secret = secretFromManualKey(begun.enrollment.manualKey);
  const verified = await verifyStaffEnrollment(
    { code: await totpCode(secret, 0), password: STAFF_PASSWORD },
    headers(jar),
    h.runtime,
  );
  if (verified.kind !== "BACKUP_CODES") throw new Error(verified.kind);
  jar.apply(verified.setCookies);
  const completed = await completeStaffActivation(
    { savedConfirmation: "saved" },
    headers(jar),
    h.runtime,
  );
  if (completed.kind !== "ACTIVATED") throw new Error(completed.kind);
  jar.apply(completed.setCookies);
  const accountId = (await resolveCurrentStaff(headers(jar), h.runtime))!
    .accountId;
  return { email, accountId, secret, nextOffset: 1 };
}

/** Uses the next unused TOTP step (−1, 1 after activation's 0). */
async function nextCode(staff: StaffMember): Promise<string> {
  const offset = staff.nextOffset;
  if (offset === 1) staff.nextOffset = -1;
  else if (offset === -1) staff.nextOffset = 2;
  else throw new Error("TOTP codes for this window are exhausted");
  return totpCode(staff.secret, offset);
}

export type StaffSession = Readonly<{ jar: CookieJar; principal: Principal }>;

/** Password + TOTP sign-in; returns the jar and resolved principal. */
export async function signIn(
  h: AuthorizationHarness,
  staff: StaffMember,
): Promise<StaffSession> {
  const jar = new CookieJar();
  const first = await signInStaff(
    { email: staff.email, password: STAFF_PASSWORD },
    headers(),
    h.runtime,
  );
  if (first.kind !== "MFA_REQUIRED") throw new Error(first.kind);
  jar.apply(first.setCookies);
  const mfa = await completeStaffMfa(
    { method: "totp", code: await nextCode(staff) },
    headers(jar),
    h.runtime,
  );
  if (mfa.kind !== "SIGNED_IN") throw new Error(mfa.kind);
  jar.apply(mfa.setCookies);
  const principal = await resolveCurrentStaff(headers(jar), h.runtime);
  if (!principal) throw new Error("no staff principal after sign-in");
  return { jar, principal };
}

/** Password + TOTP step-up bound to this session and purpose. */
export async function stepUp(
  h: AuthorizationHarness,
  staff: StaffMember,
  session: StaffSession,
  purpose: ReauthenticationPurpose,
): Promise<void> {
  const outcome = await verifyStaffStepUp(
    session.principal,
    { password: STAFF_PASSWORD, code: await nextCode(staff) },
    purpose,
    headers(session.jar),
    h.runtime,
  );
  expect(outcome).toBe("OK");
}

/** A distinct synthetic staff account pair used only as bootstrap creator/approver. */
export type BootstrapPair = Readonly<{ creator: string; approver: string }>;

export async function createBootstrapPair(
  admin: Client,
): Promise<BootstrapPair> {
  const ids: string[] = [];
  for (const label of ["creator", "approver"]) {
    const email = nextTestEmail(`bootstrap-${label}`);
    const { rows } = await admin.query<{ id: string }>(
      `INSERT INTO auth."user" (name, email, email_display, email_verified, account_type, status)
       VALUES ('TEST bootstrap actor', $1, $2, true, 'STAFF', 'ACTIVE') RETURNING id`,
      [email, email],
    );
    ids.push(rows[0]!.id);
  }
  return { creator: ids[0]!, approver: ids[1]! };
}

export const bootstrap = (accountId: string): AssignmentActor => ({
  kind: "BOOTSTRAP",
  reason: "TEST_HARNESS",
  accountId,
});

/** Proposes and approves an assignment through the test harness. */
export async function grant(
  h: AuthorizationHarness,
  pair: BootstrapPair,
  subjectAccountId: string,
  roleCode: RoleCode,
  scopeType: ScopeType,
  scopeReferenceId: string,
  dates: { effectiveFrom?: Date; effectiveTo?: Date | null } = {},
): Promise<string> {
  const proposed = await proposeRoleAssignment(
    {
      subjectAccountId,
      roleCode,
      scopeType,
      scopeReferenceId,
      effectiveFrom: dates.effectiveFrom ?? new Date(Date.now() - 60_000),
      effectiveTo: dates.effectiveTo ?? null,
      reasonCode: "NEW_ACCESS",
      reasonReference: "TEST-TICKET-1",
    },
    bootstrap(pair.creator),
    assignmentDeps(h),
  );
  if (proposed.kind !== "PROPOSED")
    throw new Error(`propose ${JSON.stringify(proposed)}`);
  const approved = await approveRoleAssignment(
    { assignmentId: proposed.assignmentId, expectedVersion: 1 },
    bootstrap(pair.approver),
    assignmentDeps(h),
  );
  if (approved.kind !== "APPROVED")
    throw new Error(`approve ${JSON.stringify(approved)}`);
  return proposed.assignmentId;
}

/**
 * Creates a disposable database, applies roles/grants, migrations, and the
 * reviewed catalog, and points process.env at it (APP_ENV=test).
 */
export async function prepareAuthorizationDatabase(
  ctx: HarnessContext,
  label: string,
): Promise<{ db: OwnedDatabase; admin: Client; restoreEnv: () => void }> {
  const savedEnv = { ...process.env };
  const db = await createOwnedDatabase(ctx, label);
  const env = buildHarnessEnv(db);
  for (const step of [
    "bootstrap",
    "migrate",
    "bootstrap",
    "catalog",
  ] as const) {
    const result = await runDbScript(step, env);
    assertNoSecrets(ctx, result.output);
    expect(result.code, `${step} failed: ${result.output}`).toBe(0);
  }
  Object.assign(process.env, env);
  const admin = await adminClient(ctx, db.name);
  return {
    db,
    admin,
    restoreEnv: () => {
      for (const key of Object.keys(process.env)) {
        if (!(key in savedEnv)) delete process.env[key];
      }
      Object.assign(process.env, savedEnv);
    },
  };
}

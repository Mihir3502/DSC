import type { Client } from "pg";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  inject,
  it,
  vi,
} from "vitest";
import {
  eventCatalog,
  findEventDefinition,
  type CatalogEventName,
} from "@/modules/audit";
import { authorize } from "@/modules/identity-access/application/authorize";
import { changeCandidatePassword } from "@/modules/identity-access/application/change-candidate-password";
import {
  authorizeDocumentAccess,
  type DocumentEnvelope,
} from "@/modules/identity-access/application/ports/authorized-document-access";
import {
  getCandidateSecurityOverview,
  revokeCandidateSession,
} from "@/modules/identity-access/application/manage-candidate-sessions";
import {
  changeStaffPassword,
  getStaffSecurityOverview,
  regenerateStaffBackupCodes,
  revokeOtherStaffSessions,
  revokeStaffSession,
} from "@/modules/identity-access/application/manage-staff-security";
import { reauthenticateStaff } from "@/modules/identity-access/application/reauthenticate-staff";
import {
  advanceStaffRecovery,
  requestStaffRecovery,
} from "@/modules/identity-access/application/recover-staff-account";
import { registerCandidate } from "@/modules/identity-access/application/register-candidate";
import { requestCandidateRecovery } from "@/modules/identity-access/application/request-candidate-recovery";
import { resetCandidatePassword } from "@/modules/identity-access/application/reset-candidate-password";
import {
  proposeRoleAssignment,
  rejectRoleAssignment,
  replaceRoleAssignment,
  approveRoleAssignment,
  revokeRoleAssignment,
} from "@/modules/identity-access/application/role-assignments";
import { signInCandidate } from "@/modules/identity-access/application/sign-in-candidate";
import {
  completeStaffMfa,
  signInStaff,
  signOutStaff,
} from "@/modules/identity-access/application/sign-in-staff";
import { beginStaffActivation } from "@/modules/identity-access/application/activate-staff-account";
import {
  issueStaffInvitation,
  revokeStaffInvitation,
} from "@/modules/identity-access/application/issue-staff-invitation";
import { verifyCandidateEmail } from "@/modules/identity-access/application/verify-candidate-email";
import { closeDatabasePool } from "@/shared/database";
import {
  TEST_PASSWORD,
  createTestAccount,
  nextTestEmail,
} from "../../fixtures/auth/accounts";
import { CookieJar } from "../../fixtures/auth/cookie-jar";
import { wrongTotpCodes } from "../../fixtures/auth/totp";
import {
  activateStaff,
  assignmentDeps,
  authzDeps,
  bootstrap,
  createAuthorizationHarness,
  createBootstrapPair,
  grant,
  headers,
  nextTotpCode,
  prepareAuthorizationDatabase,
  scopes,
  signIn,
  STAFF_PASSWORD,
  stepUp,
  syntheticId,
  type AuthorizationHarness,
  type BootstrapPair,
} from "../support/authorization";
import { dropOwnedDatabase, type OwnedDatabase } from "../support/harness";

// M1.7 §17, AC-M1.7-11: every current M1 occurrence produces exactly one
// correctly classified event in the stream its catalog definition names
// (audit_event, security_event, or an approved telemetry log line), and
// nothing in the other durable stream. Each step runs a real application
// command against disposable PostgreSQL. Synthetic data only; assertions
// compare counts and codes, never print values.

const ctx = inject("postgres");
let db: OwnedDatabase;
let admin: Client;
let restoreEnv: () => void;
let h: AuthorizationHarness;
let pair: BootstrapPair;
const covered = new Set<string>();

async function counts(name: string) {
  const { rows } = await admin.query<{ a: number; s: number }>(
    `SELECT (SELECT count(*)::int FROM audit.audit_event WHERE event_name = $1) AS a,
            (SELECT count(*)::int FROM audit.security_event WHERE event_name = $1) AS s`,
    [name],
  );
  const log = h.logs.records().filter((r) => r.eventCode === name).length;
  return { a: rows[0]!.a, s: rows[0]!.s, log };
}

/** Runs `action` and asserts each named event occurred exactly `n` times in its stream. */
async function expectEvents<T>(
  names: Partial<Record<CatalogEventName, number>>,
  action: () => Promise<T>,
): Promise<T> {
  const before = new Map<string, Awaited<ReturnType<typeof counts>>>();
  for (const name of Object.keys(names)) before.set(name, await counts(name));
  const result = await action();
  await h.runtime.email.idle();
  for (const [name, n] of Object.entries(names)) {
    const definition = findEventDefinition(name)!;
    const b = before.get(name)!;
    const c = await counts(name);
    const delta = { a: c.a - b.a, s: c.s - b.s, log: c.log - b.log };
    const expected =
      definition.stream === "AUDIT"
        ? { a: n, s: 0, log: 0 }
        : definition.stream === "SECURITY"
          ? { a: 0, s: n, log: 0 }
          : { a: 0, s: 0, log: n };
    expect(delta, `${name} (${definition.stream})`).toEqual(expected);
    covered.add(name);
  }
  return result;
}

async function code(
  email: string,
  template: "EMAIL_VERIFICATION_CODE",
  count = 1,
) {
  const message = await h.capture.waitFor(email, template, count);
  return /code is: (\d+)/.exec(message.text)![1]!;
}

async function candidateJar(email: string, password = TEST_PASSWORD) {
  const result = await signInCandidate(
    { email, password },
    headers(),
    h.runtime,
  );
  const jar = new CookieJar();
  if (result.kind === "SIGNED_IN") jar.apply(result.setCookies);
  return jar;
}

async function invitationId(email: string, status = "PENDING") {
  const { rows } = await admin.query<{ id: string }>(
    "SELECT id FROM auth.staff_invitation WHERE email = $1 AND status = $2 ORDER BY created_at DESC LIMIT 1",
    [email, status],
  );
  return rows[0]!.id;
}

async function caseFor(accountId: string) {
  const { rows } = await admin.query<{ id: string }>(
    "SELECT id FROM auth.staff_recovery_case WHERE account_id = $1 ORDER BY created_at DESC LIMIT 1",
    [accountId],
  );
  return rows[0]!.id;
}

beforeAll(async () => {
  ({ db, admin, restoreEnv } = await prepareAuthorizationDatabase(
    ctx,
    "audit_events",
  ));
  h = createAuthorizationHarness();
  pair = await createBootstrapPair(admin);
}, 180_000);

afterEach(() => {
  vi.useRealTimers();
});

afterAll(async () => {
  await closeDatabasePool();
  await admin?.end();
  if (db) await dropOwnedDatabase(ctx, db.name);
  restoreEnv?.();
});

describe("event coverage (§17)", () => {
  it("candidate registration, verification, sign-in, sessions, password, and recovery each record exactly one classified event", async () => {
    const email = nextTestEmail("ev-register");
    await expectEvents(
      {
        "auth.registration_requested": 1,
        "auth.verification_sent": 1,
        "auth.registration_account_created": 1,
      },
      () =>
        registerCandidate(
          {
            intentToken: h.runtime.intents.issuePublic(),
            email,
            password: TEST_PASSWORD,
            passwordConfirmation: TEST_PASSWORD,
          },
          headers(),
          h.runtime,
        ),
    );
    const otp = await code(email, "EMAIL_VERIFICATION_CODE");
    await expectEvents({ "auth.verification_failed": 1 }, () =>
      verifyCandidateEmail(
        { email, code: otp === "00000000" ? "11111111" : "00000000" },
        headers(),
        h.runtime,
      ),
    );
    await expectEvents({ "auth.verification_completed": 1 }, () =>
      verifyCandidateEmail({ email, code: otp }, headers(), h.runtime),
    );
    await expectEvents({ "auth.sign_in_failed": 1 }, () =>
      signInCandidate(
        { email, password: "TEST wrong passphrase 9999" },
        headers(),
        h.runtime,
      ),
    );
    const current = await expectEvents({ "auth.sign_in_succeeded": 1 }, () =>
      candidateJar(email),
    );
    await candidateJar(email);
    const overview = await getCandidateSecurityOverview(
      headers(current),
      h.runtime,
    );
    const other = overview!.sessions.find((s) => !s.current)!;
    await expectEvents({ "auth.session_revoked": 1 }, () =>
      revokeCandidateSession(headers(current), other.ref, h.runtime),
    );
    await expectEvents({ "auth.password_change_failed": 1 }, () =>
      changeCandidatePassword(
        {
          currentPassword: "TEST wrong passphrase 9999",
          password: "TEST another long passphrase 0042",
          passwordConfirmation: "TEST another long passphrase 0042",
        },
        headers(current),
        h.runtime,
      ),
    );
    await expectEvents(
      { "auth.recovery_requested": 1, "auth.recovery_email_sent": 1 },
      () => requestCandidateRecovery({ email }, headers(), h.runtime),
    );
    await expectEvents({ "auth.recovery_failed": 1 }, () =>
      resetCandidatePassword(
        {
          token: "AAAAAAAAAAAAAAAAAAAAAAAA",
          password: "TEST another long passphrase 0042",
          passwordConfirmation: "TEST another long passphrase 0042",
        },
        headers(),
        h.runtime,
      ),
    );
    const reset = await h.capture.waitFor(email, "PASSWORD_RESET", 1);
    const token = /#token=([A-Za-z0-9]+)/.exec(reset.text)![1]!;
    await expectEvents({ "auth.recovery_completed": 1 }, () =>
      resetCandidatePassword(
        {
          token,
          password: "TEST another long passphrase 0042",
          passwordConfirmation: "TEST another long passphrase 0042",
        },
        headers(),
        h.runtime,
      ),
    );
  });

  it("staff invitation issue, supersede, revoke, refuse, expire, and failed activation each record exactly one classified event", async () => {
    const actor = { kind: "BOOTSTRAP", reason: "TEST_HARNESS" } as const;
    const email = nextTestEmail("ev-invite");
    await expectEvents({ "staff.invitation_issued": 1 }, () =>
      issueStaffInvitation({ email, actor }, h.runtime),
    );
    await expectEvents(
      { "staff.invitation_issued": 1, "staff.invitation_superseded": 1 },
      () => issueStaffInvitation({ email, actor }, h.runtime),
    );
    const live = await invitationId(email);
    await expectEvents({ "staff.invitation_revoked": 1 }, () =>
      revokeStaffInvitation({ invitationId: live, actor }, h.runtime),
    );
    await expectEvents({ "staff.invitation_refused": 1 }, () =>
      revokeStaffInvitation({ invitationId: live, actor }, h.runtime),
    );
    const expiring = nextTestEmail("ev-expire");
    await issueStaffInvitation({ email: expiring, actor }, h.runtime);
    const expiringId = await invitationId(expiring);
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 30 * 86_400_000 });
    await expectEvents({ "staff.invitation_expired": 1 }, () =>
      revokeStaffInvitation({ invitationId: expiringId, actor }, h.runtime),
    );
    vi.useRealTimers();
    await expectEvents({ "staff.activation_failed": 1 }, () =>
      beginStaffActivation(
        {
          token: "x".repeat(43),
          password: STAFF_PASSWORD,
          passwordConfirmation: STAFF_PASSWORD,
        },
        headers(),
        h.runtime,
      ),
    );
  });

  it("staff sign-in, MFA, lockout, backup codes, reauthentication, sessions, password, and sign-out each record exactly one classified event", async () => {
    const staff = await activateStaff(h, "ev-staff");
    await expectEvents({ "staff.sign_in_first_factor_failed": 1 }, () =>
      signInStaff(
        { email: staff.email, password: "TEST wrong passphrase 9999" },
        headers(),
        h.runtime,
      ),
    );
    const session = await expectEvents(
      {
        "staff.sign_in_first_factor_succeeded": 1,
        "staff.mfa_challenge_succeeded": 1,
        "auth.sign_in_succeeded": 1,
      },
      () => signIn(h, staff),
    );
    const challenge = async () => {
      const jar = new CookieJar();
      const first = await signInStaff(
        { email: staff.email, password: STAFF_PASSWORD },
        headers(),
        h.runtime,
      );
      if (first.kind === "MFA_REQUIRED") jar.apply(first.setCookies);
      return jar;
    };
    const wrongJar = await challenge();
    const [wrong] = await wrongTotpCodes(staff.secret, 1);
    await expectEvents({ "staff.mfa_challenge_failed": 1 }, () =>
      completeStaffMfa(
        { method: "totp", code: wrong! },
        headers(wrongJar),
        h.runtime,
      ),
    );

    // Inline step-up + regeneration: one reauth success, one regeneration.
    const regenerated = await expectEvents(
      { "staff.reauth_succeeded": 1, "staff.backup_codes_regenerated": 1 },
      async () =>
        regenerateStaffBackupCodes(
          { password: STAFF_PASSWORD, code: await nextTotpCode(staff) },
          headers(session.jar),
          h.runtime,
        ),
    );
    expect(regenerated.kind).toBe("REGENERATED");
    const backup =
      regenerated.kind === "REGENERATED" ? regenerated.backupCodes[0]! : "";
    const backupJar = await challenge();
    await expectEvents(
      { "staff.backup_code_used": 1, "auth.sign_in_succeeded": 1 },
      () =>
        completeStaffMfa(
          { method: "backup", code: backup },
          headers(backupJar),
          h.runtime,
        ),
    );

    // Two sessions now: revoke one, then all others.
    const overview = await getStaffSecurityOverview(
      headers(session.jar),
      h.runtime,
    );
    const other = overview!.sessions.find((s) => !s.current)!;
    await expectEvents({ "staff.session_revoked": 1 }, () =>
      revokeStaffSession(headers(session.jar), other.ref, h.runtime),
    );
    await expectEvents({ "staff.sessions_revoked": 1 }, () =>
      revokeOtherStaffSessions(headers(session.jar), h.runtime),
    );

    // After the recent-auth window: challenge, failed and successful step-up.
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 3_600_000 });
    await expectEvents({ "staff.reauth_challenged": 1 }, () =>
      changeStaffPassword(
        {
          currentPassword: STAFF_PASSWORD,
          password: "TEST staff long passphrase 0042",
          passwordConfirmation: "TEST staff long passphrase 0042",
        },
        headers(session.jar),
        h.runtime,
      ),
    );
    await expectEvents({ "staff.reauth_failed": 1 }, () =>
      reauthenticateStaff(
        {
          password: "TEST wrong passphrase 9999",
          code: "000000",
          purpose: "CHANGE_PASSWORD",
        },
        headers(session.jar),
        h.runtime,
      ),
    );
    await expectEvents({ "staff.reauth_succeeded": 1 }, async () =>
      reauthenticateStaff(
        {
          password: STAFF_PASSWORD,
          code: await nextTotpCode(staff),
          purpose: "CHANGE_PASSWORD",
        },
        headers(session.jar),
        h.runtime,
      ),
    );
    await expectEvents({ "staff.password_change_failed": 1 }, () =>
      changeStaffPassword(
        {
          currentPassword: "TEST wrong passphrase 9999",
          password: "TEST staff long passphrase 0042",
          passwordConfirmation: "TEST staff long passphrase 0042",
        },
        headers(session.jar),
        h.runtime,
      ),
    );
    await expectEvents({ "staff.password_changed": 1 }, () =>
      changeStaffPassword(
        {
          currentPassword: STAFF_PASSWORD,
          password: "TEST staff long passphrase 0042",
          passwordConfirmation: "TEST staff long passphrase 0042",
        },
        headers(session.jar),
        h.runtime,
      ),
    );
    vi.useRealTimers();

    // Sign-out records only when a real session ended.
    const fresh = await activateStaff(h, "ev-signout");
    const live = await signIn(h, fresh);
    await expectEvents({ "staff.sign_out": 1 }, () =>
      signOutStaff(headers(live.jar), h.runtime),
    );

    // Lockout after bounded failures.
    const locked = await activateStaff(h, "ev-lock");
    const lockJar = new CookieJar();
    const first = await signInStaff(
      { email: locked.email, password: STAFF_PASSWORD },
      headers(),
      h.runtime,
    );
    if (first.kind === "MFA_REQUIRED") lockJar.apply(first.setCookies);
    const failures = h.runtime.env.AUTH_STAFF_MFA_MAX_FAILURES;
    const wrongCodes = await wrongTotpCodes(locked.secret, failures + 1);
    for (const c of wrongCodes.slice(0, failures)) {
      await completeStaffMfa(
        { method: "totp", code: c },
        headers(lockJar),
        h.runtime,
      );
    }
    await expectEvents({ "staff.mfa_locked": 1 }, () =>
      completeStaffMfa(
        { method: "totp", code: wrongCodes[failures]! },
        headers(lockJar),
        h.runtime,
      ),
    );
  });

  it("staff recovery request, verification, approval, completion, rejection, cancellation, expiry, and denial each record exactly one classified event", async () => {
    const staff = await activateStaff(h, "ev-recovery");
    const verifier = await createTestAccount(h.runtime.auth, {
      accountType: "STAFF",
      email: nextTestEmail("ev-verifier"),
    });
    const approver = await createTestAccount(h.runtime.auth, {
      accountType: "STAFF",
      email: nextTestEmail("ev-approver"),
    });
    await expectEvents({ "staff.recovery_requested": 1 }, () =>
      requestStaffRecovery(
        { email: staff.email, reason: "LOST_AUTHENTICATOR" },
        headers(),
        h.runtime,
      ),
    );
    const caseId = await caseFor(staff.accountId);
    const step = (
      command: Parameters<typeof advanceStaffRecovery>[0]["command"],
      actorId: string,
      id = caseId,
    ) =>
      advanceStaffRecovery(
        { caseId: id, actor: { kind: "ACCOUNT", accountId: actorId }, command },
        h.runtime,
      );
    await expectEvents({ "staff.recovery_verification_started": 1 }, () =>
      step("START_VERIFICATION", verifier.id),
    );
    await expectEvents({ "staff.recovery_identity_verified": 1 }, () =>
      step("CONFIRM_IDENTITY", verifier.id),
    );
    await expectEvents({ "staff.recovery_approved": 1 }, () =>
      step("APPROVE", approver.id),
    );
    await expectEvents(
      {
        "staff.recovery_completed": 1,
        "staff.mfa_reset": 1,
        "staff.invitation_issued": 1,
      },
      () => step("COMPLETE", approver.id),
    );
    await expectEvents({ "staff.recovery_denied": 1 }, () =>
      advanceStaffRecovery(
        {
          caseId,
          actor: { kind: "BOOTSTRAP", reason: "TEST_HARNESS" },
          command: "CANCEL",
        },
        h.runtime,
      ),
    );

    const subject = async (label: string) => {
      const s = await createTestAccount(h.runtime.auth, {
        accountType: "STAFF",
        email: nextTestEmail(label),
      });
      await requestStaffRecovery(
        { email: s.email, reason: "LOST_AUTHENTICATOR" },
        headers(),
        h.runtime,
      );
      return caseFor(s.id);
    };
    const rejectCase = await subject("ev-reject");
    await expectEvents({ "staff.recovery_rejected": 1 }, () =>
      step("REJECT", verifier.id, rejectCase),
    );
    const cancelCase = await subject("ev-cancel");
    await expectEvents({ "staff.recovery_cancelled": 1 }, () =>
      step("CANCEL", verifier.id, cancelCase),
    );
    const expireCase = await subject("ev-expire-case");
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 30 * 86_400_000 });
    await expectEvents({ "staff.recovery_expired": 1 }, () =>
      step("START_VERIFICATION", verifier.id, expireCase),
    );
    vi.useRealTimers();
  });

  it("role assignment rejection, revocation, and supersession each record exactly one classified event", async () => {
    const subject = (
      await createTestAccount(h.runtime.auth, {
        accountType: "STAFF",
        email: nextTestEmail("ev-subject"),
      })
    ).id;
    const input = {
      subjectAccountId: subject,
      roleCode: "RECRUITER",
      scopeType: "BRANCH",
      scopeReferenceId: scopes.BRANCH,
      effectiveFrom: new Date(Date.now() - 60_000),
      effectiveTo: null,
      reasonCode: "NEW_ACCESS",
    };
    const proposed = await proposeRoleAssignment(
      input,
      bootstrap(pair.creator),
      assignmentDeps(h),
    );
    if (proposed.kind !== "PROPOSED") throw new Error(proposed.kind);
    await expectEvents({ "authz.assignment_rejected": 1 }, () =>
      rejectRoleAssignment(
        {
          assignmentId: proposed.assignmentId,
          expectedVersion: 1,
          reasonCode: "PROPOSAL_REJECTED",
        },
        bootstrap(pair.approver),
        assignmentDeps(h),
      ),
    );
    const active = await grant(
      h,
      pair,
      subject,
      "RECRUITER",
      "BRANCH",
      scopes.BRANCH,
    );
    const successor = await replaceRoleAssignment(
      active,
      {
        ...input,
        scopeType: "TEAM",
        scopeReferenceId: scopes.TEAM,
        reasonCode: "SCOPE_CHANGE",
      },
      bootstrap(pair.creator),
      assignmentDeps(h),
    );
    if (successor.kind !== "PROPOSED") throw new Error(successor.kind);
    await expectEvents(
      {
        "authz.assignment_superseded": 1,
        "authz.assignment_approved": 1,
        "authz.subject_version_changed": 1,
      },
      () =>
        approveRoleAssignment(
          { assignmentId: successor.assignmentId, expectedVersion: 1 },
          bootstrap(pair.approver),
          assignmentDeps(h),
        ),
    );
    await expectEvents(
      { "authz.assignment_revoked": 1, "authz.subject_version_changed": 1 },
      () =>
        revokeRoleAssignment(
          {
            assignmentId: successor.assignmentId,
            expectedVersion: 2,
            reasonCode: "ACCESS_REVIEW",
          },
          bootstrap(pair.approver),
          assignmentDeps(h),
        ),
    );
  });

  it("restricted document access and catalog drift record exactly one classified event", async () => {
    const reviewer = await activateStaff(h, "ev-doc");
    await grant(
      h,
      pair,
      reviewer.accountId,
      "COMPLIANCE_REVIEWER",
      "BRANCH",
      scopes.BRANCH,
    );
    const session = await signIn(h, reviewer);
    await stepUp(h, reviewer, session, "RESTRICTED_DATA_ACCESS");
    const envelope: DocumentEnvelope = {
      id: syntheticId(700),
      category: "TEST_MEDICAL",
      parentRecordId: scopes.RECORD,
      sensitivity: "RESTRICTED_SCREENING_MEDICAL",
      audience: "RESTRICTED_REVIEW",
      scanState: "CLEAN",
      hidden: false,
    };
    const result = await expectEvents(
      { "authz.restricted_access_allowed": 1 },
      () =>
        authorizeDocumentAccess(
          {
            principal: session.principal,
            documentId: envelope.id,
            action: "DOWNLOAD",
            purposeCode: "COMPLIANCE_REVIEW",
          },
          {
            source: {
              loadDocumentEnvelope: async (id: string) =>
                id === envelope.id ? envelope : null,
            },
            registry: {
              TEST_MEDICAL: {
                DOWNLOAD: {
                  permission: "medical_document.download",
                  operation: "DOWNLOAD" as const,
                },
              },
            },
            authorize: (r: Parameters<typeof authorize>[0]) =>
              authorize(r, authzDeps(h)),
            events: h.runtime.events,
            clock: () => new Date(),
          },
        ),
    );
    expect(result.kind).toBe("AUTHORIZED");

    const { rows } = await admin.query<{ description: string }>(
      "SELECT description FROM auth.permission WHERE code = 'candidate.read.assigned'",
    );
    await admin.query(
      "UPDATE auth.permission SET description = 'TEST drift' WHERE code = 'candidate.read.assigned'",
    );
    try {
      await expectEvents({ "authz.policy_unavailable": 1 }, () =>
        authorize(
          {
            principal: session.principal,
            permission: "candidate.read.assigned",
            operation: "READ",
            resource: {
              kind: "RECORD",
              id: scopes.RECORD,
              sensitivity: "CONFIDENTIAL_PERSONNEL",
            },
          },
          authzDeps(h),
        ),
      );
    } finally {
      await admin.query(
        "UPDATE auth.permission SET description = $1 WHERE code = 'candidate.read.assigned'",
        [rows[0]!.description],
      );
    }
  });

  it("records exactly one classified event for every catalog event exercised by the M1 and M2.1 suites", () => {
    // Events asserted here plus those asserted exactly-once elsewhere.
    const elsewhere = [
      "auth.registration_account_created",
      "auth.sign_out",
      "auth.sessions_revoked",
      "auth.password_changed",
      "auth.rate_limited",
      "account.sessions_revoked_by_system",
      "account.restricted",
      "staff.invitation_accepted",
      "staff.activation_started",
      "staff.activation_completed",
      "staff.mfa_enrolled",
      "authz.assignment_proposed",
      "authz.assignment_refused",
      "authz.catalog_applied",
      "authz.high_risk_denied",
      "authz.self_service_denied",
      "audit.query_executed",
      "audit.query_denied",
      "audit.integrity_verification_failed",
      // M2.1 configuration events: each asserted exactly once for its
      // target, with codes-only metadata, in
      // tests/integration/organization/configuration.test.ts.
      "organization.created",
      "organization.updated",
      "organization.activated",
      "organization.inactivated",
      "branch.created",
      "branch.updated",
      "branch.activated",
      "branch.inactivated",
      "team.created",
      "team.updated",
      "team.activated",
      "team.inactivated",
      "position.created",
      "position.updated",
      "position.activated",
      "position.inactivated",
      "position.retired",
      "job_description.draft_created",
      "job_description.updated",
      "job_description.published",
      "job_description.superseded",
      "hiring_cycle.created",
      "hiring_cycle.updated",
      "hiring_cycle.published",
      "hiring_cycle.opened",
      "hiring_cycle.closed",
      "hiring_cycle.cancelled",
      "hiring_cycle.archived",
    ];
    for (const name of elsewhere) covered.add(name);
    const all = [...new Set(eventCatalog.map((d) => d.name))];
    expect(all.filter((name) => !covered.has(name))).toEqual([]);
  });
});

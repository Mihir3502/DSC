import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { authorizeQueryScope } from "@/modules/identity-access/application/authorize";
import { resolveCurrentAccount } from "@/modules/identity-access/application/current-account";
import {
  changeStaffPassword,
  getStaffSecurityOverview,
  regenerateStaffBackupCodes,
  revokeOtherStaffSessions,
  revokeStaffSession,
} from "@/modules/identity-access/application/manage-staff-security";
import {
  approveRoleAssignment,
  replaceRoleAssignment,
} from "@/modules/identity-access/application/role-assignments";
import {
  completeStaffMfa,
  signInStaff,
} from "@/modules/identity-access/application/sign-in-staff";
import { closeDatabasePool } from "@/shared/database";
import { CookieJar } from "../../fixtures/auth/cookie-jar";
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
  type AuthorizationHarness,
  type BootstrapPair,
} from "../support/authorization";
import { waitForLockWait } from "../support/barriers";
import { dropOwnedDatabase, type OwnedDatabase } from "../support/harness";

// M1.7 §18: revocation and races on real PostgreSQL with deterministic
// lock barriers (never sleeps). Rows already proven elsewhere are listed in
// tests/authorization/matrix-manifest.ts (revocationRows) and checked by the
// coverage test; this file adds the missing ones. A stale browser/session
// never preserves authority, and a losing request never leaves partial
// state or a false success event.

const ctx = inject("postgres");
let db: OwnedDatabase;
let admin: Client;
let restoreEnv: () => void;
let h: AuthorizationHarness;
let pair: BootstrapPair;

const sessionCount = async (accountId: string) =>
  (
    await admin.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM auth.session WHERE user_id = $1",
      [accountId],
    )
  ).rows[0]!.n;
const eventCount = async (name: string, target: string) =>
  (
    await admin.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM audit.audit_event WHERE event_name = $1 AND target_id = $2",
      [name, target],
    )
  ).rows[0]!.n;

async function mfaChallenge(email: string) {
  const jar = new CookieJar();
  const first = await signInStaff(
    { email, password: STAFF_PASSWORD },
    headers(),
    h.runtime,
  );
  if (first.kind === "MFA_REQUIRED") jar.apply(first.setCookies);
  return jar;
}

beforeAll(async () => {
  ({ db, admin, restoreEnv } = await prepareAuthorizationDatabase(
    ctx,
    "revocation",
  ));
  // Competitors must reach PostgreSQL: the barrier is a database lock.
  process.env.DATABASE_POOL_MAX = "6";
  h = createAuthorizationHarness();
  pair = await createBootstrapPair(admin);
}, 180_000);

afterAll(async () => {
  await closeDatabasePool();
  await admin?.end();
  if (db) await dropOwnedDatabase(ctx, db.name);
  restoreEnv?.();
});

describe("revocation and race matrix (§18)", () => {
  it("revocation: an account disabled while a protected command waits refuses the command with no partial state or success event", async () => {
    const staff = await activateStaff(h, "rv-disable");
    const a = await signIn(h, staff);
    await signIn(h, staff);
    const sessionsBefore = await sessionCount(staff.accountId);
    expect(sessionsBefore).toBeGreaterThanOrEqual(2);
    // Barrier: the admin holds the account row and disables it, uncommitted.
    await admin.query("BEGIN");
    await admin.query('SELECT id FROM auth."user" WHERE id = $1 FOR UPDATE', [
      staff.accountId,
    ]);
    await admin.query(
      `UPDATE auth."user" SET status = 'DISABLED', disabled_at = now(), disabled_reason_code = 'ADMINISTRATIVE_DISABLE' WHERE id = $1`,
      [staff.accountId],
    );
    const command = revokeOtherStaffSessions(headers(a.jar), h.runtime);
    await waitForLockWait(admin);
    await admin.query("COMMIT");
    expect((await command).kind).not.toBe("REVOKED");
    // The losing command deleted nothing.
    expect(await sessionCount(staff.accountId)).toBe(sessionsBefore);
    expect(await eventCount("staff.sessions_revoked", staff.accountId)).toBe(0);
    expect(await resolveCurrentAccount(headers(a.jar), h.runtime)).toBeNull();
  });

  it("revocation: a session revoked by another request has no authority on its next request", async () => {
    const staff = await activateStaff(h, "rv-session");
    const a = await signIn(h, staff);
    const b = await signIn(h, staff);
    const overview = await getStaffSecurityOverview(headers(a.jar), h.runtime);
    const ref = overview!.sessions.find((s) => !s.current)!.ref;
    expect(
      (await revokeStaffSession(headers(a.jar), ref, h.runtime)).kind,
    ).toBe("REVOKED");
    expect(await resolveCurrentAccount(headers(b.jar), h.runtime)).toBeNull();
    // Replaying the same revocation is idempotent and records nothing new.
    const before = await eventCount("staff.session_revoked", staff.accountId);
    expect(
      (await revokeStaffSession(headers(a.jar), ref, h.runtime)).kind,
    ).toBe("NOT_FOUND");
    expect(await eventCount("staff.session_revoked", staff.accountId)).toBe(
      before,
    );
  });

  it("revocation: scope supersession takes effect on the very next query and the old session loses authority", async () => {
    const staff = await activateStaff(h, "rv-scope");
    const assignment = await grant(
      h,
      pair,
      staff.accountId,
      "RECRUITER",
      "BRANCH",
      scopes.BRANCH,
    );
    const before = await signIn(h, staff);
    const query = (principal: typeof before.principal) =>
      authorizeQueryScope(
        {
          principal,
          permission: "candidate.read.assigned",
          operation: "READ",
          sensitivity: "CONFIDENTIAL_PERSONNEL",
        },
        authzDeps(h),
      );
    expect(await query(before.principal)).toMatchObject({
      decision: "ALLOW",
      constraint: { scopes: [{ type: "BRANCH", branchId: scopes.BRANCH }] },
    });
    const successor = await replaceRoleAssignment(
      assignment,
      {
        subjectAccountId: staff.accountId,
        roleCode: "RECRUITER",
        scopeType: "TEAM",
        scopeReferenceId: scopes.TEAM,
        effectiveFrom: new Date(Date.now() - 1000),
        effectiveTo: null,
        reasonCode: "SCOPE_CHANGE",
      },
      bootstrap(pair.creator),
      assignmentDeps(h),
    );
    if (successor.kind !== "PROPOSED") throw new Error(successor.kind);
    await approveRoleAssignment(
      { assignmentId: successor.assignmentId, expectedVersion: 1 },
      bootstrap(pair.approver),
      assignmentDeps(h),
    );
    expect(await query(before.principal)).toMatchObject({ decision: "DENY" });
    const after = await signIn(h, staff);
    expect(await query(after.principal)).toMatchObject({
      decision: "ALLOW",
      constraint: { scopes: [{ type: "TEAM", teamId: scopes.TEAM }] },
    });
  });

  it("revocation: one backup code replayed concurrently yields exactly one session", async () => {
    const staff = await activateStaff(h, "rv-backup");
    const session = await signIn(h, staff);
    const regenerated = await regenerateStaffBackupCodes(
      { password: STAFF_PASSWORD, code: await nextTotpCode(staff) },
      headers(session.jar),
      h.runtime,
    );
    if (regenerated.kind !== "REGENERATED") throw new Error(regenerated.kind);
    const code = regenerated.backupCodes[0]!;
    const [one, two] = [
      await mfaChallenge(staff.email),
      await mfaChallenge(staff.email),
    ];
    const results = await Promise.all([
      completeStaffMfa({ method: "backup", code }, headers(one), h.runtime),
      completeStaffMfa({ method: "backup", code }, headers(two), h.runtime),
    ]);
    expect(results.filter((r) => r.kind === "SIGNED_IN")).toHaveLength(1);
    // A later replay of the consumed code also fails.
    const later = await mfaChallenge(staff.email);
    expect(
      (
        await completeStaffMfa(
          { method: "backup", code },
          headers(later),
          h.runtime,
        )
      ).kind,
    ).not.toBe("SIGNED_IN");
  });

  it("revocation: a password change ends every other session and any pending MFA challenge", async () => {
    const staff = await activateStaff(h, "rv-password");
    const a = await signIn(h, staff);
    const b = await signIn(h, staff);
    const pending = await mfaChallenge(staff.email);
    const changed = await changeStaffPassword(
      {
        currentPassword: STAFF_PASSWORD,
        password: "TEST staff long passphrase 0077",
        passwordConfirmation: "TEST staff long passphrase 0077",
      },
      headers(a.jar),
      h.runtime,
    );
    expect(changed.kind).toBe("CHANGED");
    expect(await resolveCurrentAccount(headers(a.jar), h.runtime)).toBeNull();
    expect(await resolveCurrentAccount(headers(b.jar), h.runtime)).toBeNull();
    const completion = await completeStaffMfa(
      { method: "totp", code: await nextTotpCode(staff) },
      headers(pending),
      h.runtime,
    );
    expect(completion.kind).not.toBe("SIGNED_IN");
    expect(await sessionCount(staff.accountId)).toBe(0);
  });
});

import { randomUUID } from "node:crypto";
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
  beginStaffActivation,
  completeStaffActivation,
  verifyStaffEnrollment,
} from "@/modules/identity-access/application/activate-staff-account";
import { resolveCurrentAccount } from "@/modules/identity-access/application/current-account";
import {
  issueStaffInvitation,
  revokeStaffInvitation,
} from "@/modules/identity-access/application/issue-staff-invitation";
import {
  changeStaffPassword,
  getStaffSecurityOverview,
  regenerateStaffBackupCodes,
  revokeOtherStaffSessions,
  signOutStaffEverywhere,
} from "@/modules/identity-access/application/manage-staff-security";
import {
  evaluateStaffAssurance,
  reauthenticateStaff,
  resolveCurrentStaff,
} from "@/modules/identity-access/application/reauthenticate-staff";
import {
  advanceStaffRecovery,
  requestStaffRecovery,
} from "@/modules/identity-access/application/recover-staff-account";
import { requestCandidateRecovery } from "@/modules/identity-access/application/request-candidate-recovery";
import { lockAccount } from "@/modules/identity-access/application/restrict-account";
import { signInCandidate } from "@/modules/identity-access/application/sign-in-candidate";
import {
  completeStaffMfa,
  signInStaff,
} from "@/modules/identity-access/application/sign-in-staff";
import { FixedWindowRateLimiter } from "@/modules/identity-access/infrastructure/action-rate-limiter";
import { parseAuthEnv } from "@/modules/identity-access/infrastructure/auth-env";
import { InMemoryEmailCapture } from "@/modules/identity-access/infrastructure/auth-email";
import { handleAuthRequest } from "@/modules/identity-access/infrastructure/auth-http";
import {
  createIdentityRuntime,
  type IdentityRuntime,
} from "@/modules/identity-access/infrastructure/runtime";
import { NonproductionHarnessGate } from "@/modules/identity-access/infrastructure/staff-administration-gate";
import { closeDatabasePool, getDatabase } from "@/shared/database";
import { createLogger } from "@/shared/logging";
import {
  createTestAccount,
  nextTestEmail,
  TEST_PASSWORD,
} from "../../fixtures/auth/accounts";
import { CookieJar } from "../../fixtures/auth/cookie-jar";
import {
  secretFromManualKey,
  totpCode,
  wrongTotpCode,
  wrongTotpCodes,
} from "../../fixtures/auth/totp";
import {
  createMemoryDestination,
  findCanaryCategories,
} from "../../fixtures/canaries";
import {
  adminClient,
  assertNoSecrets,
  buildHarnessEnv,
  createOwnedDatabase,
  dropOwnedDatabase,
  runDbScript,
  type OwnedDatabase,
} from "../support/harness";

// M1.3 staff invitation, activation, MFA, recent authentication, session
// controls, and recovery against a fresh database in the owned disposable
// container, using the real application commands, the real Better Auth
// two-factor plugin, and in-memory email capture. TOTP codes come from the
// maintained OTP library via tests/fixtures/auth/totp.ts.

const ctx = inject("postgres");
const BASE = "http://127.0.0.1:3100";
const STAFF_PASSWORD = "TEST staff long passphrase 0001";
const NEW_STAFF_PASSWORD = "TEST staff new passphrase 0002";
const HARNESS = { kind: "BOOTSTRAP", reason: "TEST_HARNESS" } as const;

let db: OwnedDatabase;
let admin: Client;
let runtime: IdentityRuntime;
let refusing: IdentityRuntime;
let capture: InMemoryEmailCapture;
const logs = createMemoryDestination();
const logger = createLogger({ destination: logs });
const savedEnv = { ...process.env };
/** Every secret value seen in the suite, for the leakage check. */
const secrets: string[] = [];
/** Command results as a browser could observe them. */
const results: string[] = [];

function headers(jar?: CookieJar): Headers {
  const h = new Headers({
    origin: BASE,
    "x-forwarded-for":
      `198.51.100.${Math.floor(Math.random() * 250) + 1}-${randomUUID()}`.slice(
        0,
        60,
      ),
    "user-agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36",
  });
  const cookie = jar?.header();
  if (cookie) h.set("cookie", cookie);
  return h;
}

/**
 * Records a result for leakage checks, excluding cookie hand-offs and the
 * single intended one-time display (enrollment key/QR, backup codes).
 */
function record<T>(result: T): T {
  const { setCookies, enrollment, backupCodes, ...visible } = result as {
    setCookies?: unknown;
    enrollment?: unknown;
    backupCodes?: unknown;
  };
  void setCookies;
  void enrollment;
  void backupCodes;
  results.push(JSON.stringify(visible));
  return result;
}

async function invitationToken(email: string, count = 1): Promise<string> {
  const message = await capture.waitFor(email, "STAFF_INVITATION", count);
  const token = /#invite=([A-Za-z0-9_-]{43})/.exec(message.text)?.[1];
  expect(token).toBeDefined();
  secrets.push(token!);
  return token!;
}

async function invite(email: string, count = 1): Promise<string> {
  expect(
    await issueStaffInvitation({ email, actor: HARNESS }, runtime),
  ).toEqual({ kind: "ACCEPTED" });
  return invitationToken(email, count);
}

async function userRow(email: string) {
  const { rows } = await admin.query(
    'SELECT id, account_type, status, email_verified, two_factor_enabled, version FROM auth."user" WHERE email = $1',
    [email],
  );
  return rows[0] as
    | {
        id: string;
        account_type: string;
        status: string;
        email_verified: boolean;
        two_factor_enabled: boolean;
        version: number;
      }
    | undefined;
}

async function invitationRows(email: string) {
  const { rows } = await admin.query(
    "SELECT id, status, sequence, account_id, superseded_by_id FROM auth.staff_invitation WHERE email = $1 ORDER BY sequence",
    [email],
  );
  return rows as {
    id: string;
    status: string;
    sequence: number;
    account_id: string | null;
    superseded_by_id: string | null;
  }[];
}

async function sessions(accountId: string) {
  const { rows } = await admin.query(
    "SELECT auth_purpose, auth_method, primary_authenticated_at, mfa_authenticated_at FROM auth.session WHERE user_id = $1",
    [accountId],
  );
  return rows as {
    auth_purpose: string | null;
    auth_method: string | null;
    primary_authenticated_at: Date | null;
    mfa_authenticated_at: Date | null;
  }[];
}

type ActivatedStaff = Readonly<{
  email: string;
  accountId: string;
  secret: string;
  backupCodes: readonly string[];
  jar: CookieJar;
}>;

async function startActivation(token: string, jar = new CookieJar()) {
  const begun = record(
    await beginStaffActivation(
      {
        token,
        password: STAFF_PASSWORD,
        passwordConfirmation: STAFF_PASSWORD,
      },
      headers(jar),
      runtime,
    ),
  );
  if (begun.kind !== "ENROLLMENT_STARTED") return { begun, jar, secret: "" };
  jar.apply(begun.setCookies);
  const secret = secretFromManualKey(begun.enrollment.manualKey);
  secrets.push(secret, begun.enrollment.manualKey.replace(/\s+/g, ""));
  return { begun, jar, secret };
}

/** Invite → password → TOTP → backup codes → ACTIVE (+ staff session). */
async function activatedStaff(label: string): Promise<ActivatedStaff> {
  const email = nextTestEmail(label);
  const { jar, secret } = await startActivation(await invite(email));
  const verified = record(
    await verifyStaffEnrollment(
      { code: await totpCode(secret), password: STAFF_PASSWORD },
      headers(jar),
      runtime,
    ),
  );
  expect(verified.kind).toBe("BACKUP_CODES");
  if (verified.kind !== "BACKUP_CODES") throw new Error("unreachable");
  jar.apply(verified.setCookies);
  secrets.push(...verified.backupCodes);
  const completed = record(
    await completeStaffActivation(
      { savedConfirmation: "saved" },
      headers(jar),
      runtime,
    ),
  );
  expect(completed.kind).toBe("ACTIVATED");
  if (completed.kind !== "ACTIVATED") throw new Error("unreachable");
  jar.apply(completed.setCookies);
  const row = await userRow(email);
  return {
    email,
    accountId: row!.id,
    secret,
    backupCodes: verified.backupCodes,
    jar,
  };
}

async function firstFactor(email: string, password = STAFF_PASSWORD) {
  const jar = new CookieJar();
  const result = record(
    await signInStaff({ email, password }, headers(), runtime),
  );
  if (result.kind === "MFA_REQUIRED") jar.apply(result.setCookies);
  return { result, jar };
}

async function signInWithTotp(staff: ActivatedStaff, offset = 1) {
  const { result, jar } = await firstFactor(staff.email);
  expect(result.kind).toBe("MFA_REQUIRED");
  const mfa = record(
    await completeStaffMfa(
      { method: "totp", code: await totpCode(staff.secret, offset) },
      headers(jar),
      runtime,
    ),
  );
  expect(mfa.kind).toBe("SIGNED_IN");
  if (mfa.kind === "SIGNED_IN") jar.apply(mfa.setCookies);
  return jar;
}

beforeAll(async () => {
  db = await createOwnedDatabase(ctx, "staff");
  const env = buildHarnessEnv(db);
  for (const step of ["bootstrap", "migrate", "bootstrap"] as const) {
    const result = await runDbScript(step, env);
    assertNoSecrets(ctx, result.output);
    expect(result.code, `${step} failed`).toBe(0);
  }
  Object.assign(process.env, env);
  capture = new InMemoryEmailCapture();
  runtime = createIdentityRuntime({
    env: parseAuthEnv(process.env),
    db: getDatabase(),
    logger,
    transport: capture,
    limiter: new FixedWindowRateLimiter(),
    staffAdmin: new NonproductionHarnessGate("test"),
  });
  // The application's own runtime: the refusing administration gate.
  refusing = createIdentityRuntime({
    env: parseAuthEnv(process.env),
    db: getDatabase(),
    logger,
    transport: capture,
  });
  admin = await adminClient(ctx, db.name);
});

afterEach(async () => {
  vi.useRealTimers();
  await runtime?.email.idle();
});

afterAll(async () => {
  await closeDatabasePool();
  await admin?.end();
  if (db) await dropOwnedDatabase(ctx, db.name);
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) delete process.env[key];
  }
  Object.assign(process.env, savedEnv);
});

describe("staff invitation lifecycle", () => {
  it("issues an email-bound invitation stored only as a digest, with a generic fragment link", async () => {
    const email = nextTestEmail("invite");
    const token = await invite(email);
    const [row] = await invitationRows(email);
    expect(row).toMatchObject({
      status: "PENDING",
      sequence: 1,
      account_id: null,
    });
    const { rows } = await admin.query(
      "SELECT row_to_json(i)::text AS t FROM auth.staff_invitation i WHERE email = $1",
      [email],
    );
    expect(rows[0].t.includes(token)).toBe(false);
    const message = capture.latest(email, "STAFF_INVITATION")!;
    expect(message.text).toContain(`${BASE}/staff/activate#invite=`);
    expect(message.text).not.toMatch(
      /\?.*invite=|role|branch|candidate|admin/i,
    );
    expect(await userRow(email)).toBeUndefined();
  });

  it("supersedes the live invitation on resend: the old link stops working", async () => {
    const email = nextTestEmail("resend");
    const first = await invite(email);
    const second = await invite(email, 2);
    const rows = await invitationRows(email);
    expect(rows.map((r) => r.status)).toEqual(["SUPERSEDED", "PENDING"]);
    expect(rows[0].superseded_by_id).toBe(rows[1].id);
    expect((await startActivation(first)).begun.kind).toBe(
      "INVITATION_INVALID",
    );
    expect((await startActivation(second)).begun.kind).toBe(
      "ENROLLMENT_STARTED",
    );
  });

  it("revokes immediately and ends an activation already in progress", async () => {
    const email = nextTestEmail("revoke");
    const token = await invite(email);
    const { jar, secret } = await startActivation(token);
    const [row] = await invitationRows(email);
    expect(
      await revokeStaffInvitation(
        { invitationId: row.id, actor: HARNESS },
        runtime,
      ),
    ).toEqual({ kind: "REVOKED" });
    expect(
      (
        await verifyStaffEnrollment(
          { code: await totpCode(secret), password: STAFF_PASSWORD },
          headers(jar),
          runtime,
        )
      ).kind,
    ).toBe("ACTIVATION_EXPIRED");
    expect((await startActivation(token)).begun.kind).toBe(
      "INVITATION_INVALID",
    );
    expect(
      await revokeStaffInvitation(
        { invitationId: row.id, actor: HARNESS },
        runtime,
      ),
    ).toEqual({ kind: "NOT_REVOCABLE" });
  });

  it("expires exactly at the expiry instant", async () => {
    const email = nextTestEmail("expire");
    const token = await invite(email);
    const { rows } = await admin.query(
      "SELECT expires_at FROM auth.staff_invitation WHERE email = $1",
      [email],
    );
    vi.useFakeTimers({ toFake: ["Date"], now: rows[0].expires_at });
    expect((await startActivation(token)).begun.kind).toBe(
      "INVITATION_INVALID",
    );
    vi.useRealTimers();
    expect((await invitationRows(email))[0].status).toBe("EXPIRED");
  });

  it("never converts candidate/service accounts or duplicates existing staff (same outcome, no email)", async () => {
    const candidate = await createTestAccount(runtime.auth);
    const service = await createTestAccount(runtime.auth, {
      accountType: "SERVICE",
    });
    const locked = await createTestAccount(runtime.auth, {
      accountType: "STAFF",
      status: "LOCKED",
    });
    const before = capture.count;
    for (const account of [candidate, service, locked]) {
      expect(
        await issueStaffInvitation(
          { email: account.email, actor: HARNESS },
          runtime,
        ),
      ).toEqual({ kind: "ACCEPTED" });
      expect(await invitationRows(account.email)).toEqual([]);
    }
    await runtime.email.idle();
    expect(capture.count).toBe(before);
    expect((await userRow(candidate.email))?.account_type).toBe("CANDIDATE");
  });

  it("is unavailable through the application's own (refusing) administration gate", async () => {
    const email = nextTestEmail("refused");
    expect(
      await issueStaffInvitation({ email, actor: HARNESS }, refusing),
    ).toEqual({ kind: "NOT_AUTHORIZED" });
    expect(
      await issueStaffInvitation(
        { email, actor: { kind: "ACCOUNT", accountId: randomUUID() } },
        runtime,
      ),
    ).toEqual({ kind: "NOT_AUTHORIZED" });
    expect(await invitationRows(email)).toEqual([]);
  });

  it("allows only one live invitation under concurrent issuance", async () => {
    const email = nextTestEmail("concurrent-issue");
    await Promise.all(
      Array.from({ length: 4 }, () =>
        issueStaffInvitation({ email, actor: HARNESS }, runtime),
      ),
    );
    const rows = await invitationRows(email);
    expect(rows.filter((r) => r.status === "PENDING")).toHaveLength(1);
  });
});

describe("staff activation", () => {
  it("activates only after verified TOTP enrollment and confirmed backup codes", async () => {
    const email = nextTestEmail("activate");
    const { begun, jar, secret } = await startActivation(await invite(email));
    expect(begun.kind).toBe("ENROLLMENT_STARTED");
    if (begun.kind !== "ENROLLMENT_STARTED") return;
    expect(begun.enrollment.qrPath).toMatch(/^M\d+ \d+h1v1h-1z/);
    expect(begun.enrollment.accountLabel).toBe(`t•••@${email.split("@")[1]}`);

    // Password set, email verified by the invitation, but not ACTIVE and no
    // staff principal from the enrollment-only session.
    let row = await userRow(email);
    expect(row).toMatchObject({
      account_type: "STAFF",
      status: "INVITED",
      email_verified: true,
      two_factor_enabled: false,
    });
    expect((await sessions(row!.id)).map((s) => s.auth_purpose)).toEqual([
      "STAFF_ACTIVATION",
    ]);
    expect(await resolveCurrentAccount(headers(jar), runtime)).toBeNull();
    expect((await firstFactor(email)).result.kind).toBe("INVALID_CREDENTIALS");

    // Wrong code: still not enrolled.
    expect(
      (
        await verifyStaffEnrollment(
          { code: await wrongTotpCode(secret), password: STAFF_PASSWORD },
          headers(jar),
          runtime,
        )
      ).kind,
    ).toBe("INVALID_CODE");
    // Wrong password confirmation: refused before verifying the code.
    expect(
      (
        await verifyStaffEnrollment(
          { code: await totpCode(secret), password: "TEST wrong password 999" },
          headers(jar),
          runtime,
        )
      ).kind,
    ).toBe("PASSWORD_INVALID");

    const verified = record(
      await verifyStaffEnrollment(
        { code: await totpCode(secret), password: STAFF_PASSWORD },
        headers(jar),
        runtime,
      ),
    );
    expect(verified.kind).toBe("BACKUP_CODES");
    if (verified.kind !== "BACKUP_CODES") return;
    jar.apply(verified.setCookies);
    secrets.push(...verified.backupCodes);
    expect(verified.backupCodes).toHaveLength(10);
    expect(new Set(verified.backupCodes).size).toBe(10);
    for (const code of verified.backupCodes) {
      expect(code).toMatch(/^[A-Za-z0-9]{5}-[A-Za-z0-9]{5}$/);
    }
    row = await userRow(email);
    expect(row).toMatchObject({ status: "INVITED", two_factor_enabled: true });
    expect(await resolveCurrentAccount(headers(jar), runtime)).toBeNull();

    // Explicit confirmation that the codes were saved is required.
    expect(
      (
        await completeStaffActivation(
          { savedConfirmation: "no" },
          headers(jar),
          runtime,
        )
      ).kind,
    ).toBe("CONFIRMATION_REQUIRED");
    const done = record(
      await completeStaffActivation(
        { savedConfirmation: "saved" },
        headers(jar),
        runtime,
      ),
    );
    expect(done.kind).toBe("ACTIVATED");
    if (done.kind !== "ACTIVATED") return;
    jar.apply(done.setCookies);
    row = await userRow(email);
    expect(row).toMatchObject({ status: "ACTIVE", two_factor_enabled: true });
    expect((await invitationRows(email))[0]).toMatchObject({
      status: "ACCEPTED",
      account_id: row!.id,
    });
    const principal = await resolveCurrentAccount(headers(jar), runtime);
    expect(principal).toMatchObject({ accountType: "STAFF", status: "ACTIVE" });
    const [staffSession] = await sessions(row!.id);
    expect(staffSession).toMatchObject({
      auth_purpose: "STAFF",
      auth_method: "PASSWORD_TOTP",
    });
    expect(
      staffSession.primary_authenticated_at!.getTime(),
    ).toBeLessThanOrEqual(staffSession.mfa_authenticated_at!.getTime());

    // The invitation is single use.
    expect(
      (
        await completeStaffActivation(
          { savedConfirmation: "saved" },
          headers(jar),
          runtime,
        )
      ).kind,
    ).toBe("ACTIVATION_EXPIRED");
  });

  it("leaves an abandoned activation INVITED and refuses reuse after acceptance", async () => {
    const staff = await activatedStaff("reuse");
    const [accepted] = await invitationRows(staff.email);
    expect(accepted.status).toBe("ACCEPTED");
    const message = capture.latest(staff.email, "STAFF_INVITATION")!;
    const token = /#invite=([A-Za-z0-9_-]{43})/.exec(message.text)![1];
    expect((await startActivation(token)).begun.kind).toBe(
      "INVITATION_INVALID",
    );

    const abandoned = nextTestEmail("abandon");
    await startActivation(await invite(abandoned));
    expect(await userRow(abandoned)).toMatchObject({ status: "INVITED" });
    expect((await firstFactor(abandoned)).result.kind).toBe(
      "INVALID_CREDENTIALS",
    );
  });

  it("permits one account and one activation under parallel attempts", async () => {
    const email = nextTestEmail("parallel");
    const token = await invite(email);
    const outcomes = await Promise.all([
      startActivation(token),
      startActivation(token),
    ]);
    const { rows } = await admin.query(
      'SELECT count(*)::int AS n FROM auth."user" WHERE email = $1',
      [email],
    );
    expect(rows[0].n).toBe(1);
    // Whichever enrollment survived can finish, once.
    const finished = await Promise.all(
      outcomes.map(async ({ jar, secret }, index) => {
        if (!secret) return "NOT_STARTED";
        const verified = await verifyStaffEnrollment(
          { code: await totpCode(secret, index - 1), password: STAFF_PASSWORD },
          headers(jar),
          runtime,
        );
        if (verified.kind !== "BACKUP_CODES") return verified.kind;
        jar.apply(verified.setCookies);
        const twice = await Promise.all([
          completeStaffActivation(
            { savedConfirmation: "saved" },
            headers(jar),
            runtime,
          ),
          completeStaffActivation(
            { savedConfirmation: "saved" },
            headers(jar),
            runtime,
          ),
        ]);
        return twice
          .map((t) => t.kind)
          .sort()
          .join(",");
      }),
    );
    expect(finished.filter((f) => f.includes("ACTIVATED"))).toHaveLength(1);
    expect(finished.find((f) => f.includes("ACTIVATED"))).toBe(
      "ACTIVATED,ACTIVATION_EXPIRED",
    );
    expect(await userRow(email)).toMatchObject({ status: "ACTIVE" });
  });

  it("stores the TOTP seed and backup codes only as ciphertext", async () => {
    const staff = await activatedStaff("ciphertext");
    const { rows } = await admin.query(
      "SELECT row_to_json(t)::text AS t FROM auth.two_factor t WHERE user_id = $1",
      [staff.accountId],
    );
    const stored = rows[0].t as string;
    expect(stored.includes(staff.secret)).toBe(false);
    for (const code of staff.backupCodes) {
      expect(stored.includes(code)).toBe(false);
    }
    const all = await admin.query(
      "SELECT coalesce(string_agg(v::text, '\n'), '') AS t FROM auth.verification v",
    );
    expect(all.rows[0].t.includes(staff.secret)).toBe(false);
  });
});

describe("staff sign-in and MFA", () => {
  it("never yields a staff principal from the password alone", async () => {
    const staff = await activatedStaff("password-only");
    const { result, jar } = await firstFactor(staff.email);
    expect(result.kind).toBe("MFA_REQUIRED");
    expect(jar.has("psa.two_factor")).toBe(true);
    expect(jar.has("psa.session_token")).toBe(false);
    expect(await resolveCurrentAccount(headers(jar), runtime)).toBeNull();
    expect(await getStaffSecurityOverview(headers(jar), runtime)).toBeNull();
    const purposes = (await sessions(staff.accountId)).map(
      (s) => s.auth_purpose,
    );
    expect(purposes).not.toContain("STAFF_FIRST_FACTOR");
  });

  it("signs in with password + TOTP and stamps server-owned assurance", async () => {
    const staff = await activatedStaff("totp");
    const jar = await signInWithTotp(staff);
    const principal = await resolveCurrentStaff(headers(jar), runtime);
    expect(principal).not.toBeNull();
    const decision = await evaluateStaffAssurance(
      principal!,
      "RECENT_STRONG_AUTH",
      {},
      runtime,
    );
    expect(decision).toMatchObject({ kind: "ALLOW", method: "PASSWORD_TOTP" });
  });

  it("uses one generic failure for every ineligible account at the staff entry", async () => {
    const candidate = await createTestAccount(runtime.auth);
    const accounts = [
      candidate,
      await createTestAccount(runtime.auth, { accountType: "SERVICE" }),
      ...(await Promise.all(
        (["INVITED", "LOCKED", "DISABLED", "CLOSED"] as const).map((status) =>
          createTestAccount(runtime.auth, { accountType: "STAFF", status }),
        ),
      )),
      // Active staff without MFA enrollment (should never exist).
      await createTestAccount(runtime.auth, { accountType: "STAFF" }),
    ];
    for (const account of accounts) {
      const result = await signInStaff(
        { email: account.email, password: TEST_PASSWORD },
        headers(),
        runtime,
      );
      expect(result).toEqual({ kind: "INVALID_CREDENTIALS" });
    }
    const staff = await activatedStaff("wrong-password");
    expect(
      await signInStaff(
        { email: staff.email, password: "TEST wrong password 0000" },
        headers(),
        runtime,
      ),
    ).toEqual({ kind: "INVALID_CREDENTIALS" });
    // A candidate session cannot enter the staff MFA step.
    const signedIn = await signInCandidate(
      { email: candidate.email, password: TEST_PASSWORD },
      headers(),
      runtime,
    );
    expect(signedIn.kind).toBe("SIGNED_IN");
    const jar = new CookieJar().apply(
      signedIn.kind === "SIGNED_IN" ? signedIn.setCookies : [],
    );
    expect(
      (
        await completeStaffMfa(
          { method: "totp", code: "123456" },
          headers(jar),
          runtime,
        )
      ).kind,
    ).toBe("CHALLENGE_EXPIRED");
  });

  it("rejects invalid and replayed codes", async () => {
    const staff = await activatedStaff("replay");
    const { jar } = await firstFactor(staff.email);
    expect(
      (
        await completeStaffMfa(
          { method: "totp", code: await wrongTotpCode(staff.secret) },
          headers(jar),
          runtime,
        )
      ).kind,
    ).toBe("INVALID_CODE");
    const code = await totpCode(staff.secret, 1);
    const ok = await completeStaffMfa(
      { method: "totp", code },
      headers(jar),
      runtime,
    );
    expect(ok.kind).toBe("SIGNED_IN");
    // Same code, fresh first factor: refused by the replay guard.
    const again = await firstFactor(staff.email);
    expect(
      (
        await completeStaffMfa(
          { method: "totp", code },
          headers(again.jar),
          runtime,
        )
      ).kind,
    ).toBe("INVALID_CODE");
  });

  it("accepts codes from the adjacent step only (±1 window)", async () => {
    const staff = await activatedStaff("window");
    for (const offset of [-2, 2]) {
      const { jar } = await firstFactor(staff.email);
      expect(
        (
          await completeStaffMfa(
            { method: "totp", code: await totpCode(staff.secret, offset) },
            headers(jar),
            runtime,
          )
        ).kind,
      ).toBe("INVALID_CODE");
    }
    await signInWithTotp(staff, -1);
  });

  it("locks temporarily after bounded failures, then recovers after the interval", async () => {
    const staff = await activatedStaff("lockout");
    const start = Date.now();
    vi.useFakeTimers({ toFake: ["Date"], now: start });
    const { jar } = await firstFactor(staff.email);
    const wrong = await wrongTotpCodes(
      staff.secret,
      runtime.env.AUTH_STAFF_MFA_MAX_FAILURES,
    );
    for (const code of wrong) {
      expect(
        (
          await completeStaffMfa(
            { method: "totp", code },
            headers(jar),
            runtime,
          )
        ).kind,
      ).toBe("INVALID_CODE");
    }
    // Locked: even a valid code (or a backup code) is refused, generically.
    const fresh = await firstFactor(staff.email);
    expect(
      (
        await completeStaffMfa(
          { method: "totp", code: await totpCode(staff.secret, 1) },
          headers(fresh.jar),
          runtime,
        )
      ).kind,
    ).toBe("LOCKED");
    expect(
      (
        await completeStaffMfa(
          { method: "backup", code: staff.backupCodes[0] },
          headers(fresh.jar),
          runtime,
        )
      ).kind,
    ).toBe("LOCKED");
    // After the configured interval a fresh challenge succeeds.
    vi.setSystemTime(
      start + (runtime.env.AUTH_STAFF_MFA_LOCKOUT_SECONDS + 1) * 1000,
    );
    const later = await firstFactor(staff.email);
    expect(
      (
        await completeStaffMfa(
          { method: "totp", code: await totpCode(staff.secret) },
          headers(later.jar),
          runtime,
        )
      ).kind,
    ).toBe("SIGNED_IN");
  });

  it("ignores trusted-device requests and forged trusted-device cookies", async () => {
    const staff = await activatedStaff("trust");
    const first = await firstFactor(staff.email);
    const mfa = await completeStaffMfa(
      {
        method: "totp",
        code: await totpCode(staff.secret, 1),
        // @ts-expect-error — extra client field must be ignored
        trustDevice: true,
      },
      headers(first.jar),
      runtime,
    );
    expect(mfa.kind).toBe("SIGNED_IN");
    const set = mfa.kind === "SIGNED_IN" ? mfa.setCookies : [];
    expect(
      set.some((c) => c.includes("trust_device=") && !/max-age=0/i.test(c)),
    ).toBe(false);
    const forged = new CookieJar().set("psa.trust_device", "forged.value");
    const again = await signInStaff(
      { email: staff.email, password: STAFF_PASSWORD },
      headers(forged),
      runtime,
    );
    expect(again.kind).toBe("MFA_REQUIRED");
  });

  it("accepts each backup code once and records the weaker method", async () => {
    const staff = await activatedStaff("backup");
    const { jar } = await firstFactor(staff.email);
    const code = staff.backupCodes[0];
    const ok = record(
      await completeStaffMfa(
        { method: "backup", code: ` ${code.replace("-", "")} ` },
        headers(jar),
        runtime,
      ),
    );
    expect(ok.kind).toBe("SIGNED_IN");
    if (ok.kind === "SIGNED_IN") jar.apply(ok.setCookies);
    const principal = await resolveCurrentStaff(headers(jar), runtime);
    expect(
      await evaluateStaffAssurance(
        principal!,
        "RECENT_STAFF_AUTH",
        {},
        runtime,
      ),
    ).toMatchObject({ kind: "ALLOW", method: "PASSWORD_BACKUP_CODE" });
    // A backup code never satisfies the highest policy.
    expect(
      await evaluateStaffAssurance(
        principal!,
        "RECENT_STRONG_AUTH",
        {},
        runtime,
      ),
    ).toEqual({ kind: "CHALLENGE", reason: "STRONGER_METHOD_REQUIRED" });
    const replay = await firstFactor(staff.email);
    expect(
      (
        await completeStaffMfa(
          { method: "backup", code },
          headers(replay.jar),
          runtime,
        )
      ).kind,
    ).toBe("INVALID_CODE");
  });

  it("offers no email/SMS OTP and routes no two-factor or backup-code endpoint", async () => {
    const staff = await activatedStaff("no-otp");
    const { jar } = await firstFactor(staff.email);
    const otp = await runtime.auth.api.sendTwoFactorOTP({
      body: {},
      headers: headers(jar),
      asResponse: true,
    });
    expect(otp.ok).toBe(false);
    for (const path of [
      "/api/auth/two-factor/send-otp",
      "/api/auth/two-factor/verify-otp",
      "/api/auth/two-factor/verify-totp",
      "/api/auth/two-factor/verify-backup-code",
      "/api/auth/two-factor/enable",
      "/api/auth/two-factor/disable",
      "/api/auth/two-factor/get-totp-uri",
      "/api/auth/two-factor/generate-backup-codes",
      "/api/auth/two-factor/view-backup-codes",
      "/api/auth/verify-password",
    ]) {
      const response = await handleAuthRequest(
        new Request(`${BASE}${path}`, {
          method: "POST",
          headers: {
            origin: BASE,
            "content-type": "application/json",
            cookie: jar.header() ?? "",
          },
          body: JSON.stringify({ code: "000000", trustDevice: true }),
        }),
        "00000000-0000-4000-8000-000000000000",
      );
      expect(response.status, path).toBe(404);
    }
  });
});

describe("staff security area and recent authentication", () => {
  it("shows only account, MFA, and session controls", async () => {
    const staff = await activatedStaff("overview");
    const overview = await getStaffSecurityOverview(
      headers(staff.jar),
      runtime,
    );
    expect(overview).not.toBeNull();
    const text = JSON.stringify(overview);
    expect(Object.keys(overview!).sort()).toEqual([
      "maskedEmail",
      "mfaMethod",
      "recentAuthentication",
      "sessions",
      "signedInWith",
    ]);
    expect(text).not.toContain(staff.email);
    expect(text).not.toContain(staff.secret);
    expect(text).not.toMatch(/role|scope|branch|permission|token/i);
  });

  it("requires recent auth for password change, then ends every session", async () => {
    const staff = await activatedStaff("password");
    const start = Date.now();
    vi.useFakeTimers({ toFake: ["Date"], now: start });
    const jar = await signInWithTotp(staff, 1);
    // Exactly at the boundary the sign-in is no longer recent.
    vi.setSystemTime(start + runtime.env.AUTH_STAFF_RECENT_AUTH_SECONDS * 1000);
    const input = {
      currentPassword: STAFF_PASSWORD,
      password: NEW_STAFF_PASSWORD,
      passwordConfirmation: NEW_STAFF_PASSWORD,
    };
    expect((await changeStaffPassword(input, headers(jar), runtime)).kind).toBe(
      "REAUTHENTICATION_REQUIRED",
    );
    const reauth = await reauthenticateStaff(
      {
        password: STAFF_PASSWORD,
        code: await totpCode(staff.secret, -1),
        purpose: "CHANGE_PASSWORD",
        // Client-supplied evidence is ignored.
        reauthenticatedAt: new Date(0).toISOString(),
      } as never,
      headers(jar),
      runtime,
    );
    expect(reauth).toEqual({
      kind: "REAUTHENTICATED",
      destination: "/staff/security#password",
    });
    const before = (await userRow(staff.email))!.version;
    const changed = await changeStaffPassword(input, headers(jar), runtime);
    expect(changed.kind).toBe("CHANGED");
    expect(await sessions(staff.accountId)).toEqual([]);
    expect((await userRow(staff.email))!.version).toBe(before + 1);
    expect(await resolveCurrentAccount(headers(jar), runtime)).toBeNull();
    await runtime.email.idle();
    expect(capture.latest(staff.email, "STAFF_SECURITY_NOTICE")).toBeDefined();
  });

  it("binds reauthentication to purpose and refuses open redirects", async () => {
    const staff = await activatedStaff("purpose");
    const start = Date.now();
    vi.useFakeTimers({ toFake: ["Date"], now: start });
    const jar = await signInWithTotp(staff, 1);
    // A URL or unknown key never becomes a destination.
    vi.setSystemTime(start + 31_000);
    expect(
      await reauthenticateStaff(
        {
          password: STAFF_PASSWORD,
          code: await totpCode(staff.secret, 1),
          purpose: "https://evil.example/steal",
        },
        headers(jar),
        runtime,
      ),
    ).toEqual({ kind: "REAUTHENTICATED", destination: "/staff/security" });
    const principal = (await resolveCurrentStaff(headers(jar), runtime))!;
    // STAFF_SECURITY evidence does not satisfy another purpose.
    expect(
      await evaluateStaffAssurance(
        principal,
        "RECENT_STRONG_AUTH",
        { purpose: "REGENERATE_BACKUP_CODES" },
        runtime,
      ),
    ).toEqual({ kind: "CHALLENGE", reason: "REAUTHENTICATION_REQUIRED" });
    // Wrong password or code: one generic failure.
    expect(
      await reauthenticateStaff(
        {
          password: "TEST wrong password 0000",
          code: "000000",
          purpose: "STAFF_SECURITY",
        },
        headers(jar),
        runtime,
      ),
    ).toEqual({ kind: "INVALID" });
  });

  it("regenerates backup codes after password + TOTP, invalidating every earlier code", async () => {
    const staff = await activatedStaff("regenerate");
    const jar = staff.jar;
    expect(
      await regenerateStaffBackupCodes(
        { password: STAFF_PASSWORD, code: "000000" },
        headers(jar),
        runtime,
      ),
    ).toEqual({ kind: "INVALID" });
    const regenerated = record(
      await regenerateStaffBackupCodes(
        { password: STAFF_PASSWORD, code: await totpCode(staff.secret, 1) },
        headers(jar),
        runtime,
      ),
    );
    expect(regenerated.kind).toBe("REGENERATED");
    if (regenerated.kind !== "REGENERATED") return;
    secrets.push(...regenerated.backupCodes);
    const old = await firstFactor(staff.email);
    expect(
      (
        await completeStaffMfa(
          { method: "backup", code: staff.backupCodes[1] },
          headers(old.jar),
          runtime,
        )
      ).kind,
    ).toBe("INVALID_CODE");
    const fresh = await firstFactor(staff.email);
    expect(
      (
        await completeStaffMfa(
          { method: "backup", code: regenerated.backupCodes[0] },
          headers(fresh.jar),
          runtime,
        )
      ).kind,
    ).toBe("SIGNED_IN");
  });

  it("invalidates assurance on session revocation and account restriction", async () => {
    const staff = await activatedStaff("invalidate");
    const other = await signInWithTotp(staff, 1);
    expect(await resolveCurrentStaff(headers(other), runtime)).not.toBeNull();
    await revokeOtherStaffSessions(headers(staff.jar), runtime);
    expect(await resolveCurrentStaff(headers(other), runtime)).toBeNull();
    expect(
      await resolveCurrentStaff(headers(staff.jar), runtime),
    ).not.toBeNull();

    await lockAccount(staff.accountId, undefined, runtime);
    expect(await resolveCurrentStaff(headers(staff.jar), runtime)).toBeNull();
    expect((await firstFactor(staff.email)).result.kind).toBe(
      "INVALID_CREDENTIALS",
    );

    const third = await activatedStaff("everywhere");
    await signOutStaffEverywhere(headers(third.jar), runtime);
    expect(await sessions(third.accountId)).toEqual([]);
  });
});

describe("controlled staff recovery", () => {
  async function activeActor(label: string) {
    return createTestAccount(runtime.auth, {
      accountType: "STAFF",
      email: nextTestEmail(label),
    });
  }

  async function caseFor(accountId: string) {
    const { rows } = await admin.query(
      "SELECT id, status, resolution_code FROM auth.staff_recovery_case WHERE account_id = $1 ORDER BY created_at DESC LIMIT 1",
      [accountId],
    );
    return rows[0] as
      | { id: string; status: string; resolution_code: string | null }
      | undefined;
  }

  it("returns one generic outcome and opens a case only for active staff", async () => {
    const staff = await activatedStaff("recovery-request");
    const others = [
      nextTestEmail("nobody"),
      (await createTestAccount(runtime.auth)).email,
      (await createTestAccount(runtime.auth, { accountType: "SERVICE" })).email,
      (
        await createTestAccount(runtime.auth, {
          accountType: "STAFF",
          status: "DISABLED",
        })
      ).email,
    ];
    for (const email of [staff.email, ...others]) {
      expect(
        await requestStaffRecovery(
          { email, reason: "LOST_AUTHENTICATOR" },
          headers(),
          runtime,
        ),
      ).toEqual({ kind: "SUBMITTED" });
    }
    expect(await caseFor(staff.accountId)).toMatchObject({
      status: "REQUESTED",
    });
    const { rows } = await admin.query(
      'SELECT count(*)::int AS n FROM auth.staff_recovery_case c JOIN auth."user" u ON u.id = c.account_id WHERE u.email = ANY($1)',
      [others],
    );
    expect(rows[0].n).toBe(0);
    // Candidate self-service recovery never targets staff.
    const sent = capture.count;
    await requestCandidateRecovery({ email: staff.email }, headers(), runtime);
    await runtime.email.idle();
    expect(capture.count).toBe(sent);
  });

  it("enforces separation of duties and completes with full reset effects", async () => {
    const staff = await activatedStaff("recovery");
    const verifier = await activeActor("verifier");
    const approver = await activeActor("approver");
    await requestStaffRecovery(
      { email: staff.email, reason: "LOST_AUTHENTICATOR" },
      headers(),
      runtime,
    );
    const { id: caseId } = (await caseFor(staff.accountId))!;
    const step = (
      command: Parameters<typeof advanceStaffRecovery>[0]["command"],
      actorId: string,
      deps = runtime,
    ) =>
      advanceStaffRecovery(
        { caseId, actor: { kind: "ACCOUNT", accountId: actorId }, command },
        deps,
      );

    expect(await step("START_VERIFICATION", verifier.id, refusing)).toEqual({
      kind: "NOT_AUTHORIZED",
    });
    expect(await step("START_VERIFICATION", staff.accountId)).toEqual({
      kind: "DENIED",
      reason: "SELF_ACTION",
    });
    expect(await step("APPROVE", approver.id)).toEqual({
      kind: "DENIED",
      reason: "INVALID_TRANSITION",
    });
    expect(await step("START_VERIFICATION", verifier.id)).toEqual({
      kind: "UPDATED",
      status: "IDENTITY_VERIFICATION_PENDING",
    });
    expect(await step("CONFIRM_IDENTITY", approver.id)).toEqual({
      kind: "DENIED",
      reason: "NOT_ASSIGNED_VERIFIER",
    });
    expect(await step("CONFIRM_IDENTITY", verifier.id)).toEqual({
      kind: "UPDATED",
      status: "APPROVAL_PENDING",
    });
    expect(await step("APPROVE", verifier.id)).toEqual({
      kind: "DENIED",
      reason: "VERIFIER_CANNOT_APPROVE",
    });
    expect(await step("APPROVE", approver.id)).toEqual({
      kind: "UPDATED",
      status: "APPROVED",
    });
    // Completion is not routed: only the harness gate permits it.
    expect(await step("COMPLETE", approver.id, refusing)).toEqual({
      kind: "NOT_AUTHORIZED",
    });
    expect(await step("COMPLETE", approver.id)).toEqual({
      kind: "UPDATED",
      status: "COMPLETED",
    });

    expect(await sessions(staff.accountId)).toEqual([]);
    expect(await userRow(staff.email)).toMatchObject({
      status: "INVITED",
      two_factor_enabled: false,
    });
    const { rows } = await admin.query(
      "SELECT count(*)::int AS n FROM auth.two_factor WHERE user_id = $1",
      [staff.accountId],
    );
    expect(rows[0].n).toBe(0);
    expect(await resolveCurrentStaff(headers(staff.jar), runtime)).toBeNull();
    expect((await firstFactor(staff.email)).result.kind).toBe(
      "INVALID_CREDENTIALS",
    );

    // Reenrollment: new password and fresh MFA before ACTIVE again.
    await runtime.email.idle();
    const reenroll = capture.latest(staff.email, "STAFF_INVITATION")!;
    expect(reenroll.subject).toMatch(/reset/i);
    expect(reenroll.text).not.toMatch(/backup|secret|otpauth/i);
    const token = /#invite=([A-Za-z0-9_-]{43})/.exec(reenroll.text)![1];
    secrets.push(token);
    const { jar, secret } = await startActivation(token);
    expect(secret).not.toBe(staff.secret);
    const verified = await verifyStaffEnrollment(
      { code: await totpCode(secret), password: STAFF_PASSWORD },
      headers(jar),
      runtime,
    );
    expect(verified.kind).toBe("BACKUP_CODES");
    if (verified.kind === "BACKUP_CODES") jar.apply(verified.setCookies);
    expect(
      (
        await completeStaffActivation(
          { savedConfirmation: "saved" },
          headers(jar),
          runtime,
        )
      ).kind,
    ).toBe("ACTIVATED");
    expect(await userRow(staff.email)).toMatchObject({ status: "ACTIVE" });
    const old = await firstFactor(staff.email);
    expect(
      (
        await completeStaffMfa(
          { method: "backup", code: staff.backupCodes[2] },
          headers(old.jar),
          runtime,
        )
      ).kind,
    ).toBe("INVALID_CODE");
  });

  it("lets only one of two concurrent approvals win", async () => {
    const staff = await activatedStaff("recovery-race");
    const verifier = await activeActor("verifier3");
    const approverA = await activeActor("approver3a");
    const approverB = await activeActor("approver3b");
    await requestStaffRecovery(
      { email: staff.email, reason: "SUSPECTED_COMPROMISE" },
      headers(),
      runtime,
    );
    const { id: caseId } = (await caseFor(staff.accountId))!;
    const act = (
      command: "START_VERIFICATION" | "CONFIRM_IDENTITY" | "APPROVE",
      accountId: string,
    ) =>
      advanceStaffRecovery(
        { caseId, actor: { kind: "ACCOUNT", accountId }, command },
        runtime,
      );
    await act("START_VERIFICATION", verifier.id);
    await act("CONFIRM_IDENTITY", verifier.id);
    const outcomes = await Promise.all([
      act("APPROVE", approverA.id),
      act("APPROVE", approverB.id),
    ]);
    expect(outcomes.filter((o) => o.kind === "UPDATED")).toHaveLength(1);
    expect(outcomes.find((o) => o.kind !== "UPDATED")).toMatchObject({
      kind: "DENIED",
      reason: "INVALID_TRANSITION",
    });
    expect(await caseFor(staff.accountId)).toMatchObject({
      status: "APPROVED",
    });
  });

  it("expires an approval that is not completed in time", async () => {
    const staff = await activatedStaff("recovery-expiry");
    const verifier = await activeActor("verifier2");
    const approver = await activeActor("approver2");
    await requestStaffRecovery(
      { email: staff.email, reason: "UNSPECIFIED" },
      headers(),
      runtime,
    );
    const { id: caseId } = (await caseFor(staff.accountId))!;
    const act = (
      command:
        "START_VERIFICATION" | "CONFIRM_IDENTITY" | "APPROVE" | "COMPLETE",
      accountId: string,
    ) =>
      advanceStaffRecovery(
        { caseId, actor: { kind: "ACCOUNT", accountId }, command },
        runtime,
      );
    await act("START_VERIFICATION", verifier.id);
    await act("CONFIRM_IDENTITY", verifier.id);
    await act("APPROVE", approver.id);
    vi.useFakeTimers({
      toFake: ["Date"],
      now: Date.now() + runtime.env.AUTH_STAFF_RECOVERY_APPROVAL_SECONDS * 1000,
    });
    expect(await act("COMPLETE", approver.id)).toEqual({ kind: "EXPIRED" });
    vi.useRealTimers();
    expect(await caseFor(staff.accountId)).toMatchObject({
      status: "EXPIRED",
      resolution_code: "APPROVAL_EXPIRED",
    });
    expect(await userRow(staff.email)).toMatchObject({ status: "ACTIVE" });
  });
});

describe("staff leakage", () => {
  it("keeps secrets, codes, tokens, emails, and cookies out of logs, results, and email", async () => {
    await runtime.email.idle();
    const logText = JSON.stringify(logs.records());
    const mail = capture
      .all()
      .map((e) => `${e.subject}\n${e.text}\n${e.html}`)
      .join("\n");
    const output = `${logText}\n${results.join("\n")}`;
    const leaked = secrets.filter((s) => s.length >= 8 && output.includes(s));
    expect(leaked.length).toBe(0);
    // Email carries invitation capabilities only, never codes or seeds.
    const tokens = new Set(
      [...mail.matchAll(/#invite=([A-Za-z0-9_-]{43})/g)].map((m) => m[1]),
    );
    const mailLeaks = secrets.filter(
      (s) => s.length >= 8 && !tokens.has(s) && mail.includes(s),
    );
    expect(mailLeaks.length).toBe(0);
    expect(findCanaryCategories(output)).toEqual([]);
    expect(logText).not.toMatch(
      /otpauth:|psa\.(session_token|two_factor)=|@example\.test/,
    );
    expect(results.join("\n")).not.toMatch(/otpauth:|secret=|BETTER_AUTH/);
    expect(STAFF_PASSWORD.length > 0 && output.includes(STAFF_PASSWORD)).toBe(
      false,
    );
    for (const email of capture.all()) {
      const body = `${email.subject}\n${email.text}\n${email.html}`;
      expect(body).not.toMatch(/otpauth|STAFF|ACTIVE|INVITED|<img|<script/);
      expect(body).not.toContain(email.to);
    }
  });
});

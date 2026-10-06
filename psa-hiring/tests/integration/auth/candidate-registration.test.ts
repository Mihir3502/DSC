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
import { changeCandidatePassword } from "@/modules/identity-access/application/change-candidate-password";
import {
  getCandidateSecurityOverview,
  revokeCandidateSession,
  revokeOtherCandidateSessions,
  signOutCandidateEverywhere,
} from "@/modules/identity-access/application/manage-candidate-sessions";
import { registerCandidate } from "@/modules/identity-access/application/register-candidate";
import { issueCandidateInvitation } from "@/modules/identity-access/application/registration-intents";
import { requestCandidateRecovery } from "@/modules/identity-access/application/request-candidate-recovery";
import { resetCandidatePassword } from "@/modules/identity-access/application/reset-candidate-password";
import {
  signInCandidate,
  signOutCandidate,
} from "@/modules/identity-access/application/sign-in-candidate";
import {
  resendVerificationCode,
  verifyCandidateEmail,
} from "@/modules/identity-access/application/verify-candidate-email";
import { lockAccount } from "@/modules/identity-access/application/restrict-account";
import { FixedWindowRateLimiter } from "@/modules/identity-access/infrastructure/action-rate-limiter";
import { parseAuthEnv } from "@/modules/identity-access/infrastructure/auth-env";
import { InMemoryEmailCapture } from "@/modules/identity-access/infrastructure/auth-email";
import { handleAuthRequest } from "@/modules/identity-access/infrastructure/auth-http";
import {
  createIdentityRuntime,
  type IdentityRuntime,
} from "@/modules/identity-access/infrastructure/runtime";
import { closeDatabasePool, getDatabase } from "@/shared/database";
import { createLogger } from "@/shared/logging";
import {
  createTestAccount,
  nextTestEmail,
  sessionCookieFrom,
  TEST_PASSWORD,
} from "../../fixtures/auth/accounts";
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

// M1.2 candidate registration, verification, sign-in, recovery, reset,
// password change, and session management against a fresh database in the
// owned disposable container, using the real application commands and the
// real Better Auth instance (email captured in memory).

const ctx = inject("postgres");
const BASE = "http://127.0.0.1:3100";
const NEW_PASSWORD = "TEST another long passphrase 0002";
const COMPROMISED = "TEST compromised passphrase 0001";

let db: OwnedDatabase;
let admin: Client;
let runtime: IdentityRuntime;
let capture: InMemoryEmailCapture;
const logs = createMemoryDestination();
const logger = createLogger({ destination: logs });
const savedEnv = { ...process.env };
const results: string[] = [];
const secrets: string[] = [];

/** A unique synthetic client per call keeps action rate limits independent. */
function headers(cookie?: string | null): Headers {
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
  if (cookie) h.set("cookie", cookie);
  return h;
}

/**
 * Records a command result for the leakage check. `setCookies` is the
 * internal hand-off to the delivery layer (applied as an HttpOnly cookie,
 * never serialized to the browser), so it is excluded here.
 */
function record<T>(result: T): T {
  const { setCookies, ...visible } = result as { setCookies?: unknown };
  void setCookies;
  results.push(JSON.stringify(visible));
  return result;
}

function cookieOf(setCookies: readonly string[]): string | null {
  const match = setCookies.find((c) => /^psa\.session_token=/.test(c));
  return match ? match.split(";")[0] : null;
}

async function codeFor(email: string, count = 1): Promise<string> {
  const message = await capture.waitFor(
    email,
    "EMAIL_VERIFICATION_CODE",
    count,
  );
  const code = /code is: (\d+)/.exec(message.text)?.[1];
  expect(code).toMatch(/^\d{8}$/);
  secrets.push(code!);
  return code!;
}

async function resetTokenFor(email: string, count = 1): Promise<string> {
  const message = await capture.waitFor(email, "PASSWORD_RESET", count);
  const token = /#token=([A-Za-z0-9]+)/.exec(message.text)?.[1];
  expect(token).toMatch(/^[A-Za-z0-9]{24}$/);
  secrets.push(token!);
  return token!;
}

async function userRow(email: string) {
  const { rows } = await admin.query(
    'SELECT id, account_type, status, email_verified, version FROM auth."user" WHERE email = $1',
    [email],
  );
  return rows[0] as
    | {
        id: string;
        account_type: string;
        status: string;
        email_verified: boolean;
        version: number;
      }
    | undefined;
}

async function sessionCount(accountId: string): Promise<number> {
  const { rows } = await admin.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM auth.session WHERE user_id = $1",
    [accountId],
  );
  return rows[0].n;
}

async function appRowCount(): Promise<number> {
  const { rows } = await admin.query<{ t: string }>(
    "SELECT format('%I.%I', schemaname, tablename) AS t FROM pg_tables WHERE schemaname = 'app'",
  );
  let total = 0;
  for (const { t } of rows) {
    const count = await admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM ${t}`,
    );
    total += count.rows[0].n;
  }
  return total;
}

/** Full-row text of the verification table, to prove secrets are absent. */
async function verificationBytes(): Promise<string> {
  const { rows } = await admin.query<{ t: string }>(
    "SELECT coalesce(string_agg(v::text, '\n'), '') AS t FROM auth.verification v",
  );
  return rows[0].t;
}

async function register(
  email: string,
  overrides: Record<string, unknown> = {},
) {
  return record(
    await registerCandidate(
      {
        intentToken: runtime.intents.issuePublic(),
        email,
        password: TEST_PASSWORD,
        passwordConfirmation: TEST_PASSWORD,
        ...overrides,
      },
      headers(),
      runtime,
    ),
  );
}

/** Registers and verifies a candidate; returns its normalized email. */
async function verifiedCandidate(label = "verified"): Promise<string> {
  const email = nextTestEmail(label);
  expect((await register(email)).kind).toBe("SUBMITTED");
  const code = await codeFor(email);
  expect(
    (await verifyCandidateEmail({ email, code }, headers(), runtime)).kind,
  ).toBe("VERIFIED");
  return email;
}

async function signIn(email: string, password = TEST_PASSWORD, next?: string) {
  const result = record(
    await signInCandidate({ email, password, next }, headers(), runtime),
  );
  return {
    result,
    cookie: result.kind === "SIGNED_IN" ? cookieOf(result.setCookies) : null,
  };
}

beforeAll(async () => {
  db = await createOwnedDatabase(ctx, "candidate");
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

describe("controlled candidate-only registration", () => {
  it("creates an INVITED, unverified CANDIDATE with a credential, no session, and no business records", async () => {
    const before = await appRowCount();
    const email = nextTestEmail("register");
    const result = await register(email, {
      // Extra browser fields are not part of the command input; even if a
      // form posted them they could not reach the account.
      accountType: "STAFF",
      status: "ACTIVE",
    } as never);
    expect(result).toEqual({ kind: "SUBMITTED" });
    const row = await userRow(email);
    expect(row).toMatchObject({
      account_type: "CANDIDATE",
      status: "INVITED",
      email_verified: false,
      version: 1,
    });
    const credential = await admin.query(
      "SELECT provider_id, password IS NOT NULL AND password <> $2 AS hashed FROM auth.account WHERE user_id = $1",
      [row!.id, TEST_PASSWORD],
    );
    expect(credential.rows).toEqual([
      { provider_id: "credential", hashed: true },
    ]);
    expect(await sessionCount(row!.id)).toBe(0);
    expect(await appRowCount()).toBe(before);
    await codeFor(email);
  });

  it("normalizes the email and keeps the entered form for display only", async () => {
    const entered = `  ${nextTestEmail("Mixed.Case").replace("test.", "Test.")} `;
    expect((await register(entered)).kind).toBe("SUBMITTED");
    const login = entered.trim().toLowerCase();
    const { rows } = await admin.query(
      'SELECT email, email_display FROM auth."user" WHERE email = $1',
      [login],
    );
    expect(rows[0]).toEqual({ email: login, email_display: entered.trim() });
  });

  it("rejects invalid passwords (including compromised ones) without creating an account", async () => {
    const cases: Array<[Record<string, unknown>, string[]]> = [
      [{ password: "short", passwordConfirmation: "short" }, ["TOO_SHORT"]],
      [{ passwordConfirmation: `${TEST_PASSWORD}x` }, ["MISMATCH"]],
      [
        { password: COMPROMISED, passwordConfirmation: COMPROMISED },
        ["COMPROMISED"],
      ],
    ];
    for (const [overrides, problems] of cases) {
      const email = nextTestEmail("weak");
      expect(await register(email, overrides)).toEqual({
        kind: "INVALID_INPUT",
        password: problems,
      });
      expect(await userRow(email)).toBeUndefined();
    }
    expect((await register("not-an-email")).kind).toBe("INVALID_INPUT");
  });

  it("rejects missing, tampered, and expired public intents", async () => {
    const token = runtime.intents.issuePublic();
    const [part, signature] = token.split(".");
    for (const intentToken of [
      undefined,
      "",
      `${part}.${signature.slice(0, -3)}abc`,
      `${part}x.${signature}`,
    ]) {
      const email = nextTestEmail("badintent");
      expect(await register(email, { intentToken })).toEqual({
        kind: "INTENT_INVALID",
      });
      expect(await userRow(email)).toBeUndefined();
    }
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 2 * 3600 * 1000);
    const late = nextTestEmail("lateintent");
    expect(await register(late, { intentToken: token })).toEqual({
      kind: "INTENT_INVALID",
    });
    vi.useRealTimers();
    expect(await userRow(late)).toBeUndefined();
  });

  it("binds invitations to the invited email, stores them hashed, and allows one use", async () => {
    const invited = nextTestEmail("invited");
    const link = await issueCandidateInvitation(invited, runtime);
    expect(link).toMatch(/^http:\/\/127\.0\.0\.1:3100\/register#intent=/);
    const token = new URL(link).hash.replace("#intent=", "");
    secrets.push(token);
    expect(await verificationBytes()).not.toContain(token);

    const other = nextTestEmail("notinvited");
    expect(await register(other, { intentToken: token })).toEqual({
      kind: "INTENT_INVALID",
    });
    expect(await userRow(other)).toBeUndefined();

    expect(await register(invited, { intentToken: token })).toEqual({
      kind: "SUBMITTED",
    });
    expect((await userRow(invited))?.account_type).toBe("CANDIDATE");

    const again = nextTestEmail("replay");
    expect(await register(again, { intentToken: token })).toEqual({
      kind: "INTENT_INVALID",
    });
    expect(await register(invited, { intentToken: token })).toEqual({
      kind: "INTENT_INVALID",
    });
  });

  it("treats expired invitations as invalid", async () => {
    const invited = nextTestEmail("expiredinvite");
    const token = new URL(
      await issueCandidateInvitation(invited, runtime),
    ).hash.replace("#intent=", "");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 8 * 24 * 3600 * 1000);
    expect(await register(invited, { intentToken: token })).toEqual({
      kind: "INTENT_INVALID",
    });
    vi.useRealTimers();
    expect(await userRow(invited)).toBeUndefined();
  });

  it("returns the same outcome for duplicates and never converts staff or service accounts", async () => {
    const candidate = await verifiedCandidate("dupcandidate");
    const staff = await createTestAccount(runtime.auth, {
      accountType: "STAFF",
    });
    const service = await createTestAccount(runtime.auth, {
      accountType: "SERVICE",
    });
    const sentBefore = capture.count;
    for (const email of [candidate, staff.email, service.email]) {
      expect(await register(email)).toEqual({ kind: "SUBMITTED" });
    }
    await runtime.email.idle();
    expect(capture.count).toBe(sentBefore);
    expect((await userRow(staff.email))?.account_type).toBe("STAFF");
    expect((await userRow(service.email))?.account_type).toBe("SERVICE");
    expect((await userRow(candidate))?.status).toBe("ACTIVE");
  });

  it("offers an existing invited candidate a fresh code without disclosing it", async () => {
    const email = nextTestEmail("reregister");
    await register(email);
    const first = await codeFor(email, 1);
    expect(await register(email)).toEqual({ kind: "SUBMITTED" });
    const second = await codeFor(email, 2);
    expect(second).not.toBe(first);
  });

  it("creates at most one account for concurrent normalized-equivalent registrations", async () => {
    const email = nextTestEmail("race");
    const variants = [email, email.toUpperCase(), ` ${email} `, email];
    const outcomes = await Promise.all(variants.map((v) => register(v)));
    expect(outcomes.every((o) => o.kind === "SUBMITTED")).toBe(true);
    const { rows } = await admin.query(
      'SELECT count(*)::int AS n FROM auth."user" WHERE email = $1',
      [email],
    );
    expect(rows[0].n).toBe(1);
    const credentials = await admin.query(
      'SELECT count(*)::int AS n FROM auth.account a JOIN auth."user" u ON u.id = a.user_id WHERE u.email = $1',
      [email],
    );
    expect(credentials.rows[0].n).toBe(1);
  });

  it("rate limits registration per client", async () => {
    const limited = createIdentityRuntime({
      env: runtime.env,
      db: getDatabase(),
      logger,
      transport: capture,
      limiter: new FixedWindowRateLimiter(),
    });
    const fixed = new Headers({
      origin: BASE,
      "x-forwarded-for": "203.0.113.9",
    });
    const outcomes: string[] = [];
    for (let i = 0; i < 11; i += 1) {
      const result = await registerCandidate(
        {
          intentToken: limited.intents.issuePublic(),
          email: "not-an-email",
          password: "x",
          passwordConfirmation: "x",
        },
        fixed,
        limited,
      );
      outcomes.push(result.kind);
    }
    expect(outcomes.slice(0, 10).every((k) => k === "INVALID_INPUT")).toBe(
      true,
    );
    expect(outcomes[10]).toBe("RATE_LIMITED");
  });
});

describe("email verification (email-OTP)", () => {
  it("stores codes hashed, verifies once, activates the candidate, and creates no session", async () => {
    const email = nextTestEmail("otp");
    await register(email);
    const code = await codeFor(email);
    const bytes = await verificationBytes();
    expect(bytes).not.toContain(code);
    expect(bytes).not.toContain(email);

    expect(
      record(await verifyCandidateEmail({ email, code }, headers(), runtime)),
    ).toEqual({ kind: "VERIFIED" });
    const row = await userRow(email);
    expect(row).toMatchObject({ status: "ACTIVE", email_verified: true });
    expect(await sessionCount(row!.id)).toBe(0);

    expect(
      record(await verifyCandidateEmail({ email, code }, headers(), runtime)),
    ).toEqual({ kind: "CODE_INVALID" });
  });

  it("invalidates a code after three wrong attempts", async () => {
    const email = nextTestEmail("otpattempts");
    await register(email);
    const code = await codeFor(email);
    const wrong = code === "00000000" ? "11111111" : "00000000";
    for (let i = 0; i < 3; i += 1) {
      expect(
        (await verifyCandidateEmail({ email, code: wrong }, headers(), runtime))
          .kind,
      ).toBe("CODE_INVALID");
    }
    expect(
      (await verifyCandidateEmail({ email, code }, headers(), runtime)).kind,
    ).toBe("CODE_INVALID");
    expect((await userRow(email))?.email_verified).toBe(false);
  });

  it("rotates codes on resend so only the newest works", async () => {
    const email = nextTestEmail("otprotate");
    await register(email);
    const first = await codeFor(email, 1);
    expect(
      record(await resendVerificationCode({ email }, headers(), runtime)),
    ).toEqual({ kind: "SENT" });
    const second = await codeFor(email, 2);
    expect(second).not.toBe(first);
    expect(
      (await verifyCandidateEmail({ email, code: first }, headers(), runtime))
        .kind,
    ).toBe("CODE_INVALID");
    expect(
      (await verifyCandidateEmail({ email, code: second }, headers(), runtime))
        .kind,
    ).toBe("VERIFIED");
  });

  it("expires codes", async () => {
    const email = nextTestEmail("otpexpiry");
    await register(email);
    const code = await codeFor(email);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 11 * 60 * 1000);
    expect(
      (await verifyCandidateEmail({ email, code }, headers(), runtime)).kind,
    ).toBe("CODE_INVALID");
  });

  it("returns the same resend outcome for unknown, staff, verified, and pending emails, emailing only the pending one", async () => {
    const pending = nextTestEmail("pending");
    await register(pending);
    await codeFor(pending, 1);
    const staff = await createTestAccount(runtime.auth, {
      accountType: "STAFF",
      emailVerified: false,
    });
    const verified = await verifiedCandidate("resendverified");
    await runtime.email.idle();
    const before = capture.count;
    for (const email of [nextTestEmail("unknown"), staff.email, verified]) {
      expect(
        await resendVerificationCode({ email }, headers(), runtime),
      ).toEqual({ kind: "SENT" });
    }
    await runtime.email.idle();
    expect(capture.count).toBe(before);
    expect(
      await resendVerificationCode({ email: pending }, headers(), runtime),
    ).toEqual({ kind: "SENT" });
    await codeFor(pending, 2);
  });

  it("cannot verify staff accounts or activate restricted candidates", async () => {
    const staff = await createTestAccount(runtime.auth, {
      accountType: "STAFF",
      status: "INVITED",
      emailVerified: false,
    });
    await runtime.auth.api.sendVerificationOTP({
      body: { email: staff.email, type: "email-verification" },
    });
    await runtime.email.idle();
    expect(capture.messagesFor(staff.email)).toEqual([]);
    expect((await userRow(staff.email))?.email_verified).toBe(false);

    const email = nextTestEmail("lockedinvite");
    await register(email);
    const code = await codeFor(email);
    const row = await userRow(email);
    await lockAccount(row!.id, undefined, { db: getDatabase(), logger });
    expect(
      (await verifyCandidateEmail({ email, code }, headers(), runtime)).kind,
    ).toBe("CODE_INVALID");
    expect((await userRow(email))?.status).toBe("LOCKED");
  });
});

describe("candidate sign-in and sign-out", () => {
  it("signs in an active verified candidate with a database session and a registry destination", async () => {
    const email = await verifiedCandidate("signin");
    const { result, cookie } = await signIn(
      email,
      TEST_PASSWORD,
      "https://evil.example.test",
    );
    expect(result).toMatchObject({
      kind: "SIGNED_IN",
      destination: "/candidate/security",
    });
    expect(cookie).toMatch(/^psa\.session_token=/);
    const row = await userRow(email);
    expect(await sessionCount(row!.id)).toBe(1);
    expect(JSON.stringify({ ...result, setCookies: [] })).not.toMatch(
      /token|@example/i,
    );
  });

  it("gives one generic failure and no session for every ineligible case", async () => {
    const unverified = nextTestEmail("unverified");
    await register(unverified);
    const active = await verifiedCandidate("wrongpw");
    const staff = await createTestAccount(runtime.auth, {
      accountType: "STAFF",
    });
    const service = await createTestAccount(runtime.auth, {
      accountType: "SERVICE",
    });
    const locked = await createTestAccount(runtime.auth, { status: "LOCKED" });
    const disabled = await createTestAccount(runtime.auth, {
      status: "DISABLED",
    });
    const closed = await createTestAccount(runtime.auth, { status: "CLOSED" });
    const attempts: Array<[string, string]> = [
      [nextTestEmail("nobody"), TEST_PASSWORD],
      [active, "TEST wrong passphrase 0003"],
      [unverified, TEST_PASSWORD],
      [staff.email, TEST_PASSWORD],
      [service.email, TEST_PASSWORD],
      [locked.email, TEST_PASSWORD],
      [disabled.email, TEST_PASSWORD],
      [closed.email, TEST_PASSWORD],
      ["not-an-email", TEST_PASSWORD],
      [active, ""],
    ];
    for (const [email, password] of attempts) {
      expect((await signIn(email, password)).result).toEqual({
        kind: "INVALID_CREDENTIALS",
      });
    }
    for (const account of [staff, service, locked, disabled, closed]) {
      expect(await sessionCount(account.id)).toBe(0);
    }
  });

  it("completes the INVITED → ACTIVE transition on sign-in if activation was interrupted", async () => {
    const email = nextTestEmail("repair");
    await register(email);
    await admin.query(
      'UPDATE auth."user" SET email_verified = true WHERE email = $1',
      [email],
    );
    expect((await signIn(email)).result.kind).toBe("SIGNED_IN");
    expect((await userRow(email))?.status).toBe("ACTIVE");
  });

  it("revokes the current session on sign-out and is safe to repeat", async () => {
    const email = await verifiedCandidate("signout");
    const { cookie } = await signIn(email);
    const row = await userRow(email);
    const out = await signOutCandidate(headers(cookie), runtime);
    expect(out.setCookies.some((c) => /psa\.session_token=;/.test(c))).toBe(
      true,
    );
    expect(await sessionCount(row!.id)).toBe(0);
    await expect(
      signOutCandidate(headers(cookie), runtime),
    ).resolves.toBeDefined();
    await expect(signOutCandidate(headers(), runtime)).resolves.toBeDefined();
  });

  it("rate limits repeated sign-in attempts for one client and email", async () => {
    const limited = createIdentityRuntime({
      env: runtime.env,
      db: getDatabase(),
      logger,
      transport: capture,
      limiter: new FixedWindowRateLimiter(),
    });
    const fixed = new Headers({
      origin: BASE,
      "x-forwarded-for": "203.0.113.10",
    });
    const email = nextTestEmail("bruteforce");
    const kinds: string[] = [];
    for (let i = 0; i < 11; i += 1) {
      kinds.push(
        (
          await signInCandidate(
            { email, password: "TEST wrong passphrase 0004" },
            fixed,
            limited,
          )
        ).kind,
      );
    }
    expect(kinds.at(-1)).toBe("RATE_LIMITED");
  });
});

describe("password recovery and reset", () => {
  it("returns the same outcome for every account and emails only an eligible candidate", async () => {
    const eligible = await verifiedCandidate("recover");
    const unverified = nextTestEmail("recoverunverified");
    await register(unverified);
    const staff = await createTestAccount(runtime.auth, {
      accountType: "STAFF",
    });
    const locked = await createTestAccount(runtime.auth, { status: "LOCKED" });
    await runtime.email.idle();
    const before = capture.count;
    for (const email of [
      nextTestEmail("recoverunknown"),
      unverified,
      staff.email,
      locked.email,
      eligible,
    ]) {
      expect(
        record(await requestCandidateRecovery({ email }, headers(), runtime)),
      ).toEqual({ kind: "SENT" });
    }
    await resetTokenFor(eligible);
    await runtime.email.idle();
    expect(capture.count).toBe(before + 1);
    expect((await userRow(locked.email))?.status).toBe("LOCKED");
    expect((await userRow(unverified))?.status).toBe("INVITED");
  });

  it("stores reset tokens only as hashes", async () => {
    const email = await verifiedCandidate("resethash");
    await requestCandidateRecovery({ email }, headers(), runtime);
    const token = await resetTokenFor(email);
    const bytes = await verificationBytes();
    expect(bytes).not.toContain(token);
    expect(bytes).not.toContain(Buffer.from(token).toString("base64"));
    expect(bytes).not.toContain(`reset-password:${token}`);
  });

  it("resets once, revokes every session, keeps account state, and requires sign-in", async () => {
    const email = await verifiedCandidate("reset");
    const a = await signIn(email);
    const b = await signIn(email);
    const row = await userRow(email);
    expect(await sessionCount(row!.id)).toBe(2);
    await requestCandidateRecovery({ email }, headers(), runtime);
    const token = await resetTokenFor(email);

    // A rejected password does not burn the link.
    expect(
      await resetCandidatePassword(
        { token, password: COMPROMISED, passwordConfirmation: COMPROMISED },
        headers(),
        runtime,
      ),
    ).toEqual({ kind: "INVALID_INPUT", password: ["COMPROMISED"] });

    expect(
      record(
        await resetCandidatePassword(
          { token, password: NEW_PASSWORD, passwordConfirmation: NEW_PASSWORD },
          headers(),
          runtime,
        ),
      ),
    ).toEqual({ kind: "RESET" });
    expect(await sessionCount(row!.id)).toBe(0);
    expect(
      await getCandidateSecurityOverview(headers(a.cookie), runtime),
    ).toBeNull();
    expect(
      await getCandidateSecurityOverview(headers(b.cookie), runtime),
    ).toBeNull();
    const after = await userRow(email);
    expect(after).toMatchObject({
      account_type: "CANDIDATE",
      status: "ACTIVE",
      email_verified: true,
      version: row!.version,
    });
    await capture.waitFor(email, "PASSWORD_CHANGED");
    expect((await signIn(email)).result.kind).toBe("INVALID_CREDENTIALS");
    expect((await signIn(email, NEW_PASSWORD)).result.kind).toBe("SIGNED_IN");

    expect(
      await resetCandidatePassword(
        { token, password: NEW_PASSWORD, passwordConfirmation: NEW_PASSWORD },
        headers(),
        runtime,
      ),
    ).toEqual({ kind: "LINK_INVALID" });
  });

  it("allows at most one of two racing resets", async () => {
    const email = await verifiedCandidate("resetrace");
    await requestCandidateRecovery({ email }, headers(), runtime);
    const token = await resetTokenFor(email);
    const outcomes = await Promise.all(
      [NEW_PASSWORD, "TEST a third long passphrase 0003"].map((password) =>
        resetCandidatePassword(
          { token, password, passwordConfirmation: password },
          headers(),
          runtime,
        ),
      ),
    );
    expect(outcomes.filter((o) => o.kind === "RESET")).toHaveLength(1);
    expect(outcomes.filter((o) => o.kind === "LINK_INVALID")).toHaveLength(1);
  });

  it("rejects wrong-purpose, malformed, expired, and restricted-account tokens", async () => {
    const email = await verifiedCandidate("resetpurpose");
    const { cookie } = await signIn(email);
    const pending = nextTestEmail("resetotp");
    await register(pending);
    const code = await codeFor(pending);
    const invitation = new URL(
      await issueCandidateInvitation(nextTestEmail("resetinvite"), runtime),
    ).hash.replace("#intent=", "");
    const sessionToken = decodeURIComponent(cookie!.split("=")[1]).split(
      ".",
    )[0];
    for (const token of [code, invitation, sessionToken, "", "x".repeat(24)]) {
      expect(
        await resetCandidatePassword(
          { token, password: NEW_PASSWORD, passwordConfirmation: NEW_PASSWORD },
          headers(),
          runtime,
        ),
      ).toEqual({ kind: "LINK_INVALID" });
    }

    await requestCandidateRecovery({ email }, headers(), runtime);
    const expiring = await resetTokenFor(email);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 31 * 60 * 1000);
    expect(
      await resetCandidatePassword(
        {
          token: expiring,
          password: NEW_PASSWORD,
          passwordConfirmation: NEW_PASSWORD,
        },
        headers(),
        runtime,
      ),
    ).toEqual({ kind: "LINK_INVALID" });
    vi.useRealTimers();

    const lockedEmail = await verifiedCandidate("resetlocked");
    await requestCandidateRecovery({ email: lockedEmail }, headers(), runtime);
    const lockedToken = await resetTokenFor(lockedEmail);
    const row = await userRow(lockedEmail);
    await lockAccount(row!.id, undefined, { db: getDatabase(), logger });
    expect(
      await resetCandidatePassword(
        {
          token: lockedToken,
          password: NEW_PASSWORD,
          passwordConfirmation: NEW_PASSWORD,
        },
        headers(),
        runtime,
      ),
    ).toEqual({ kind: "LINK_INVALID" });
    expect((await userRow(lockedEmail))?.status).toBe("LOCKED");
  });

  it("silently caps recovery emails per address without changing the response", async () => {
    const limited = createIdentityRuntime({
      env: runtime.env,
      db: getDatabase(),
      logger,
      transport: capture,
      limiter: new FixedWindowRateLimiter(),
    });
    const email = await verifiedCandidate("recovercap");
    for (let i = 0; i < 7; i += 1) {
      expect(
        await requestCandidateRecovery({ email }, headers(), limited),
      ).toEqual({ kind: "SENT" });
    }
    await limited.email.idle();
    expect(capture.messagesFor(email, "PASSWORD_RESET")).toHaveLength(5);
  });
});

describe("authenticated password change and session management", () => {
  it("changes the password with the current one, revokes other sessions, and rotates this one", async () => {
    const email = await verifiedCandidate("change");
    const current = await signIn(email);
    const other = await signIn(email);

    expect(
      await changeCandidatePassword(
        {
          currentPassword: "TEST wrong passphrase 0005",
          password: NEW_PASSWORD,
          passwordConfirmation: NEW_PASSWORD,
        },
        headers(current.cookie),
        runtime,
      ),
    ).toEqual({ kind: "CURRENT_PASSWORD_INVALID" });
    expect(
      await changeCandidatePassword(
        {
          currentPassword: TEST_PASSWORD,
          password: COMPROMISED,
          passwordConfirmation: COMPROMISED,
        },
        headers(current.cookie),
        runtime,
      ),
    ).toEqual({ kind: "INVALID_INPUT", password: ["COMPROMISED"] });

    const changed = await changeCandidatePassword(
      {
        currentPassword: TEST_PASSWORD,
        password: NEW_PASSWORD,
        passwordConfirmation: NEW_PASSWORD,
      },
      headers(current.cookie),
      runtime,
    );
    expect(changed.kind).toBe("CHANGED");
    const rotated = cookieOf(
      changed.kind === "CHANGED" ? changed.setCookies : [],
    );
    expect(rotated).not.toBeNull();
    expect(
      await getCandidateSecurityOverview(headers(other.cookie), runtime),
    ).toBeNull();
    expect(
      await getCandidateSecurityOverview(headers(rotated), runtime),
    ).not.toBeNull();
    await capture.waitFor(email, "PASSWORD_CHANGED");
    expect(
      await changeCandidatePassword(
        {
          currentPassword: NEW_PASSWORD,
          password: TEST_PASSWORD,
          passwordConfirmation: TEST_PASSWORD,
        },
        headers(),
        runtime,
      ),
    ).toEqual({ kind: "UNAUTHENTICATED" });
  });

  it("lists only the candidate's own sessions by opaque reference", async () => {
    const email = await verifiedCandidate("sessions");
    const a = await signIn(email);
    await signIn(email);
    const overview = await getCandidateSecurityOverview(
      headers(a.cookie),
      runtime,
    );
    expect(overview).not.toBeNull();
    expect(overview!.maskedEmail).toBe(`t•••@example.test`);
    expect(overview!.emailVerified).toBe(true);
    expect(overview!.sessions).toHaveLength(2);
    expect(overview!.sessions.filter((s) => s.current)).toHaveLength(1);
    expect(overview!.sessions[0].deviceLabel).toBe("Chrome on macOS");
    const serialized = JSON.stringify(overview);
    const row = await userRow(email);
    const { rows } = await admin.query<{ id: string; token: string }>(
      "SELECT id, token FROM auth.session WHERE user_id = $1",
      [row!.id],
    );
    for (const s of rows) {
      expect(serialized).not.toContain(s.id);
      expect(serialized).not.toContain(s.token);
    }
    expect(serialized).not.toContain(email);
    expect(serialized).not.toContain("Mozilla");
  });

  it("revokes one other session, rejects foreign or stale references, and is idempotent", async () => {
    const email = await verifiedCandidate("revokeone");
    const a = await signIn(email);
    const b = await signIn(email);
    const overview = await getCandidateSecurityOverview(
      headers(a.cookie),
      runtime,
    );
    const otherRef = overview!.sessions.find((s) => !s.current)!.ref;

    const intruder = await verifiedCandidate("intruder");
    const i = await signIn(intruder);
    expect(
      await revokeCandidateSession(headers(i.cookie), otherRef, runtime),
    ).toEqual({ kind: "NOT_FOUND" });
    expect(await revokeCandidateSession(headers(), otherRef, runtime)).toEqual({
      kind: "UNAUTHENTICATED",
    });
    expect(
      await revokeCandidateSession(headers(a.cookie), "x".repeat(32), runtime),
    ).toEqual({ kind: "NOT_FOUND" });

    expect(
      await revokeCandidateSession(headers(a.cookie), otherRef, runtime),
    ).toMatchObject({ kind: "REVOKED", endedCurrent: false, count: 1 });
    expect(
      await getCandidateSecurityOverview(headers(b.cookie), runtime),
    ).toBeNull();
    expect(
      await revokeCandidateSession(headers(a.cookie), otherRef, runtime),
    ).toEqual({ kind: "NOT_FOUND" });
    expect(
      await getCandidateSecurityOverview(headers(a.cookie), runtime),
    ).not.toBeNull();
  });

  it("revokes all other sessions, then signs out everywhere", async () => {
    const email = await verifiedCandidate("revokeall");
    const a = await signIn(email);
    const b = await signIn(email);
    const c = await signIn(email);
    expect(
      await revokeOtherCandidateSessions(headers(a.cookie), runtime),
    ).toMatchObject({ kind: "REVOKED", count: 2 });
    expect(
      await getCandidateSecurityOverview(headers(b.cookie), runtime),
    ).toBeNull();
    expect(
      await getCandidateSecurityOverview(headers(c.cookie), runtime),
    ).toBeNull();
    const everywhere = await signOutCandidateEverywhere(
      headers(a.cookie),
      runtime,
    );
    expect(everywhere).toMatchObject({
      kind: "REVOKED",
      endedCurrent: true,
      count: 1,
    });
    expect(
      await getCandidateSecurityOverview(headers(a.cookie), runtime),
    ).toBeNull();
  });

  it("does not show the candidate security overview to staff sessions", async () => {
    const staff = await createTestAccount(runtime.auth, {
      accountType: "STAFF",
    });
    const response = await runtime.auth.api.signInEmail({
      body: { email: staff.email, password: TEST_PASSWORD },
      headers: headers(),
      asResponse: true,
    });
    // M1.3: a staff password alone never yields a session.
    const cookie = sessionCookieFrom(response);
    expect(cookie).toBeNull();
    expect(
      await getCandidateSecurityOverview(headers(cookie), runtime),
    ).toBeNull();
  });
});

describe("closed HTTP surface", () => {
  it.each([
    "/api/auth/sign-up/email",
    "/api/auth/email-otp/send-verification-otp",
    "/api/auth/email-otp/verify-email",
    "/api/auth/sign-in/email-otp",
    "/api/auth/email-otp/request-password-reset",
    "/api/auth/email-otp/reset-password",
    "/api/auth/request-password-reset",
    "/api/auth/reset-password",
    "/api/auth/change-password",
    "/api/auth/send-verification-email",
    "/api/auth/update-user",
  ])("Better Auth refuses %s over HTTP", async (path) => {
    const response = await runtime.auth.handler(
      new Request(`${BASE}${path}`, {
        method: "POST",
        headers: { origin: BASE, "content-type": "application/json" },
        body: JSON.stringify({ email: nextTestEmail("http"), type: "sign-in" }),
      }),
    );
    expect(response.status).toBe(404);
  });

  it.each([
    ["POST", "/api/auth/sign-in/email"],
    ["POST", "/api/auth/sign-out"],
    ["GET", "/api/auth/list-sessions"],
    ["GET", "/api/auth/reset-password/AbCdEfGhIjKlMnOpQrStUvWx"],
  ])(
    "the application route returns a closed 404 for %s %s",
    async (method, path) => {
      const response = await handleAuthRequest(
        new Request(`${BASE}${path}`, {
          method,
          headers: { origin: BASE, "content-type": "application/json" },
          ...(method === "POST"
            ? {
                body: JSON.stringify({
                  email: "x@example.test",
                  password: "x",
                }),
              }
            : {}),
        }),
        "0b9a7a3e-6a55-4c8e-9a3b-2f1d0c4e5a6b",
      );
      expect(response.status).toBe(404);
      expect(response.headers.get("content-type")).toBe(
        "application/problem+json",
      );
    },
  );
});

describe("leakage", () => {
  it("keeps passwords, codes, tokens, cookies, and emails out of logs and results", async () => {
    await runtime.email.idle();
    const sessions = await admin.query<{ token: string }>(
      "SELECT token FROM auth.session",
    );
    const emails = await admin.query<{ email: string }>(
      'SELECT email FROM auth."user"',
    );
    const hashes = await admin.query<{ password: string }>(
      "SELECT password FROM auth.account WHERE password IS NOT NULL",
    );
    const logText = logs.raw();
    const resultText = results.join("\n");
    const output = `${logText}\n${resultText}`;
    expect({
      password: output.includes(TEST_PASSWORD) || output.includes(NEW_PASSWORD),
      hash: hashes.rows.some((h) => output.includes(h.password)),
      secret: secrets.some((s) => s.length >= 8 && logText.includes(s)),
      sessionToken: sessions.rows.some((s) => output.includes(s.token)),
      email: emails.rows.some((e) => logText.includes(e.email)),
      cookieHeader: /psa\.session_token=/.test(logText),
    }).toEqual({
      password: false,
      hash: false,
      secret: false,
      sessionToken: false,
      email: false,
      cookieHeader: false,
    });
    expect(findCanaryCategories(output)).toEqual([]);
    const allowed = new Set([
      "level",
      "time",
      "service",
      "environment",
      "msg",
      "module",
      "action",
      "eventCode",
      "resultCode",
      "recordRef",
      "actorRef",
      "correlationId",
      "errorCode",
    ]);
    for (const line of logs.records()) {
      expect(
        Object.keys(line).every((k) => allowed.has(k)),
        JSON.stringify(Object.keys(line)),
      ).toBe(true);
    }
  });

  it("captured emails carry only the intended secret and no account state", async () => {
    await runtime.email.idle();
    const emails = capture.all();
    const templates = new Set(emails.map((e) => e.template));
    expect([...templates].sort()).toEqual([
      "EMAIL_VERIFICATION_CODE",
      "PASSWORD_CHANGED",
      "PASSWORD_RESET",
    ]);
    const ids = await admin.query<{ id: string }>('SELECT id FROM auth."user"');
    for (const email of emails) {
      const body = `${email.subject}\n${email.text}\n${email.html}`;
      expect(body).not.toMatch(/INVITED|ACTIVE|LOCKED|STAFF|SERVICE|CANDIDATE/);
      expect(body).not.toContain(email.to);
      expect(ids.rows.some((r) => body.includes(r.id))).toBe(false);
      expect(body).not.toMatch(/<img|<script|utm_|callbackURL/i);
      const links = body.match(/https?:\/\/[^\s"<]+/g) ?? [];
      for (const link of links) {
        expect(link.startsWith(`${BASE}/reset-password#token=`)).toBe(true);
      }
    }
  });
});

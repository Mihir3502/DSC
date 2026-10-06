import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { resolveCurrentAccount } from "@/modules/identity-access/application/current-account";
import {
  closeAccount,
  disableAccount,
  lockAccount,
  revokeAllSessions,
  revokeSession,
} from "@/modules/identity-access/application/restrict-account";
import { hasVerifiedEmail } from "@/modules/identity-access/domain/account-policy";
import type { Auth } from "@/modules/identity-access/infrastructure/auth";
import { parseAuthEnv } from "@/modules/identity-access/infrastructure/auth-env";
import { InMemoryEmailCapture } from "@/modules/identity-access/infrastructure/auth-email";
import { toSafeAuthResponse } from "@/modules/identity-access/infrastructure/auth-http";
import { createIdentityRuntime } from "@/modules/identity-access/infrastructure/runtime";
import { closeDatabasePool, getDatabase } from "@/shared/database";
import { ConflictError } from "@/shared/errors";
import { createLogger } from "@/shared/logging";
import {
  createTestAccount,
  nextTestEmail,
  sessionCookieFrom,
  TEST_PASSWORD,
  type TestAccount,
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

// M1.1 account/authentication foundation against a fresh database in the
// owned disposable container: real committed migrations, real Better Auth
// persistence, sessions, verification, revocation, and restriction.

const ctx = inject("postgres");
const BASE = "http://127.0.0.1:3100";
const CORRELATION = "0b9a7a3e-6a55-4c8e-9a3b-2f1d0c4e5a6b";

let db: OwnedDatabase;
let admin: Client;
let auth: Auth;
let capture: InMemoryEmailCapture;
const logs = createMemoryDestination();
const logger = createLogger({ destination: logs });
const savedEnv = { ...process.env };
const responseBodies: string[] = [];

async function call(
  path: string,
  init: RequestInit = {},
  authInstance: Auth = auth,
) {
  const headers = new Headers(init.headers);
  headers.set("origin", BASE);
  if (init.body) headers.set("content-type", "application/json");
  const response = await toSafeAuthResponse(
    await authInstance.handler(
      new Request(`${BASE}${path}`, { ...init, headers }),
    ),
    CORRELATION,
  );
  responseBodies.push(await response.clone().text());
  return response;
}

async function signIn(
  account: Pick<TestAccount, "email">,
  password = TEST_PASSWORD,
) {
  const response = await call("/api/auth/sign-in/email", {
    method: "POST",
    body: JSON.stringify({ email: account.email, password }),
  });
  return { response, cookie: sessionCookieFrom(response) };
}

function resolve(cookie: string | null) {
  return resolveCurrentAccount(new Headers(cookie ? { cookie } : {}), {
    auth,
    db: getDatabase(),
    logger,
  });
}

async function sessionCount(accountId: string): Promise<number> {
  const { rows } = await admin.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM auth.session WHERE user_id = $1",
    [accountId],
  );
  return rows[0].n;
}

async function sqlState(
  fn: () => Promise<unknown>,
): Promise<string | undefined> {
  try {
    await fn();
    return undefined;
  } catch (error) {
    const e = error as { code?: string; cause?: { code?: string } };
    return e.code ?? e.cause?.code ?? "unknown";
  }
}

beforeAll(async () => {
  db = await createOwnedDatabase(ctx, "auth");
  const env = buildHarnessEnv(db);
  for (const step of ["bootstrap", "migrate", "bootstrap"] as const) {
    const result = await runDbScript(step, env);
    assertNoSecrets(ctx, result.output);
    expect(result.code, `${step} failed`).toBe(0);
  }
  // In-process runtime code (getDatabase, factories) reads process.env.
  Object.assign(process.env, env);
  capture = new InMemoryEmailCapture();
  auth = createIdentityRuntime({
    env: parseAuthEnv(process.env),
    db: getDatabase(),
    logger,
    transport: capture,
  }).auth;
  admin = await adminClient(ctx, db.name);
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

describe("schema and migration", () => {
  it("creates the auth tables with the designed constraints and seeds no accounts", async () => {
    const tables = await admin.query<{ t: string }>(
      "SELECT tablename AS t FROM pg_tables WHERE schemaname = 'auth' ORDER BY 1",
    );
    expect(tables.rows.map((r) => r.t)).toEqual([
      "account",
      "session",
      "user",
      "verification",
    ]);

    const constraints = await admin.query<{ name: string }>(`
      SELECT conname AS name FROM pg_constraint
      WHERE conrelid IN ('auth.user'::regclass, 'auth.session'::regclass, 'auth.account'::regclass)
        AND contype <> 'n'
      ORDER BY 1`);
    expect(constraints.rows.map((r) => r.name)).toEqual([
      "account_pkey",
      "account_user_id_user_id_fk",
      "session_pkey",
      "session_token_unique",
      "session_user_id_user_id_fk",
      "user_account_type_check",
      "user_disabled_reason_code_check",
      "user_email_normalized_check",
      "user_email_unique",
      "user_name_length_check",
      "user_pkey",
      "user_restriction_metadata_check",
      "user_status_check",
      "user_version_check",
    ]);
    const timestamps = await admin.query<{ n: number }>(`
      SELECT count(*)::int AS n FROM information_schema.columns
      WHERE table_schema = 'auth' AND data_type = 'timestamp without time zone'`);
    expect(timestamps.rows[0].n).toBe(0);

    const counts = await admin.query(`
      SELECT (SELECT count(*)::int FROM auth.user) AS users,
             (SELECT count(*)::int FROM auth.account) AS credentials,
             (SELECT count(*)::int FROM auth.session) AS sessions`);
    expect(counts.rows[0]).toEqual({ users: 0, credentials: 0, sessions: 0 });
  });

  it("grants the application role runtime DML only", async () => {
    const { rows } = await admin.query(`
      SELECT has_schema_privilege('psa_app', 'auth', 'CREATE') AS create_in_auth,
             has_table_privilege('psa_app', 'auth.session', 'DELETE') AS delete_session,
             has_table_privilege('psa_app', 'auth.verification', 'DELETE') AS delete_verification,
             has_table_privilege('psa_app', 'auth.user', 'DELETE') AS delete_user,
             has_table_privilege('psa_app', 'auth.account', 'DELETE') AS delete_account,
             has_table_privilege('psa_app', 'drizzle.__drizzle_migrations', 'SELECT') AS read_journal`);
    expect(rows[0]).toEqual({
      create_in_auth: false,
      delete_session: true,
      delete_verification: true,
      delete_user: false,
      delete_account: false,
      read_journal: false,
    });
    const appDb = getDatabase();
    for (const statement of [
      "CREATE TABLE auth.__probe (id int)",
      'ALTER TABLE auth."user" ADD COLUMN probe int',
      'DROP TABLE auth."user"',
      "DROP SCHEMA auth CASCADE",
      'DELETE FROM auth."user"',
      "DELETE FROM drizzle.__drizzle_migrations",
    ]) {
      const { sql } = await import("drizzle-orm");
      await expect(
        sqlState(() => appDb.execute(sql.raw(statement))),
        statement,
      ).resolves.toBe("42501");
    }
  });
});

describe("account type, status, and email identity", () => {
  it("persists every approved type/status and rejects invalid values in the database", async () => {
    for (const accountType of ["CANDIDATE", "STAFF", "SERVICE"] as const) {
      for (const status of [
        "INVITED",
        "ACTIVE",
        "LOCKED",
        "DISABLED",
        "CLOSED",
      ] as const) {
        const account = await createTestAccount(auth, { accountType, status });
        const { rows } = await admin.query(
          'SELECT account_type, status, (disabled_at IS NOT NULL) AS restricted FROM auth."user" WHERE id = $1',
          [account.id],
        );
        expect(rows[0]).toEqual({
          account_type: accountType,
          status,
          restricted: ["LOCKED", "DISABLED", "CLOSED"].includes(status),
        });
      }
    }
    for (const [accountType, status] of [
      ["ADMIN", "ACTIVE"],
      ["CANDIDATE", "SUSPENDED"],
    ]) {
      const state = await sqlState(() =>
        admin.query(
          `INSERT INTO auth."user" (name, email, account_type, status, updated_at) VALUES ('TEST', $1, $2, $3, now())`,
          [nextTestEmail("invalid"), accountType, status],
        ),
      );
      expect(state, `${accountType}/${status}`).toBe("23514");
    }
    // Restricted status without restriction metadata violates the check.
    const incoherent = await sqlState(() =>
      admin.query(
        `INSERT INTO auth."user" (name, email, account_type, status, updated_at) VALUES ('TEST', $1, 'CANDIDATE', 'LOCKED', now())`,
        [nextTestEmail("incoherent")],
      ),
    );
    expect(incoherent).toBe("23514");
  });

  it("refuses to create an account whose type/status are missing or invalid", async () => {
    const ctxAuth = await auth.$context;
    await expect(
      ctxAuth.internalAdapter.createUser(
        {
          email: nextTestEmail("nostatus"),
          name: "TEST",
          accountType: "ROOT",
          status: "ACTIVE",
        },
        { method: "admin" },
      ),
    ).resolves.toBeNull();
  });

  it("stores one account per normalized email, even under concurrency", async () => {
    const results = await Promise.allSettled([
      createTestAccount(auth, { email: "  Dup.User@EXAMPLE.test " }),
      createTestAccount(auth, { email: "dup.user@example.test" }),
      createTestAccount(auth, { email: "DUP.USER@example.TEST" }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const { rows } = await admin.query(
      `SELECT email, email_display FROM auth."user" WHERE email = 'dup.user@example.test'`,
    );
    expect(rows).toHaveLength(1);
    // Provider-specific rewriting is not applied: dots and plus tags differ.
    const plus = await createTestAccount(auth, {
      email: "dup.user+tag@example.test",
    });
    const dotless = await createTestAccount(auth, {
      email: "dupuser@example.test",
    });
    expect(
      new Set([plus.email, dotless.email, "dup.user@example.test"]).size,
    ).toBe(3);
    // Login emails are ASCII-only (Better Auth's sign-in validator); NFC runs
    // first so composed and decomposed input are rejected consistently.
    await expect(
      createTestAccount(auth, { email: "jos\u00e9@example.test" }),
    ).rejects.toThrow("INVALID_EMAIL");
    await expect(
      createTestAccount(auth, { email: "jose\u0301@example.test" }),
    ).rejects.toThrow("INVALID_EMAIL");
    // Non-normalized storage is refused by the database itself.
    const upper = await sqlState(() =>
      admin.query(
        `INSERT INTO auth."user" (name, email, account_type, status, updated_at) VALUES ('TEST', 'UPPER@example.test', 'CANDIDATE', 'ACTIVE', now())`,
      ),
    );
    expect(upper).toBe("23514");
  });
});

describe("public endpoints", () => {
  it("disables generic sign-up, including attempts to choose staff/service/active", async () => {
    const response = await call("/api/auth/sign-up/email", {
      method: "POST",
      body: JSON.stringify({
        email: nextTestEmail("signup"),
        password: TEST_PASSWORD,
        name: "TEST",
        accountType: "STAFF",
        status: "ACTIVE",
        disabledAt: null,
      }),
    });
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.headers.get("content-type")).toBe(
      "application/problem+json",
    );
    const body = (await response.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual([
      "code",
      "correlationId",
      "status",
      "title",
      "type",
    ]);
    const { rows } = await admin.query(
      `SELECT count(*)::int AS n FROM auth."user" WHERE email LIKE 'test.signup.%'`,
    );
    expect(rows[0].n).toBe(0);
  });

  it("ignores/refuses client attempts to change server-owned fields", async () => {
    const account = await createTestAccount(auth, { accountType: "CANDIDATE" });
    const { cookie } = await signIn(account);
    expect(cookie).not.toBeNull();
    await call("/api/auth/update-user", {
      method: "POST",
      headers: { cookie: cookie! },
      body: JSON.stringify({
        accountType: "STAFF",
        status: "ACTIVE",
        version: 99,
        disabledReasonCode: "X",
      }),
    });
    const { rows } = await admin.query(
      'SELECT account_type, status, version, disabled_reason_code FROM auth."user" WHERE id = $1',
      [account.id],
    );
    expect(rows[0]).toEqual({
      account_type: "CANDIDATE",
      status: "ACTIVE",
      version: 1,
      disabled_reason_code: null,
    });
  });

  it("never returns session tokens in JSON bodies", async () => {
    const account = await createTestAccount(auth);
    const { response, cookie } = await signIn(account);
    const signInBody = (await response.json()) as Record<string, unknown>;
    expect(signInBody).not.toHaveProperty("token");
    const sessionResponse = await call("/api/auth/get-session", {
      headers: { cookie: cookie! },
    });
    const sessionBody = (await sessionResponse.json()) as {
      session?: Record<string, unknown>;
      user?: Record<string, unknown>;
    };
    expect(sessionBody.session).toBeDefined();
    expect(sessionBody.session).not.toHaveProperty("token");
    for (const field of [
      "accountType",
      "status",
      "version",
      "disabledAt",
      "disabledReasonCode",
      "emailDisplay",
    ]) {
      expect(sessionBody.user, field).not.toHaveProperty(field);
    }
  });
});

describe("sessions and principal resolution", () => {
  it("creates a database session with safe cookie flags and resolves an active principal", async () => {
    const account = await createTestAccount(auth, { emailVerified: true });
    const { response, cookie } = await signIn(account);
    expect(response.status).toBe(200);
    const setCookie = response.headers
      .getSetCookie()
      .find((c) => c.startsWith("psa.session_token="))!;
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Lax/i);
    expect(setCookie).toMatch(/Path=\//);
    expect(setCookie).not.toMatch(/Domain=/i);
    expect(setCookie).not.toMatch(/;\s*Secure/i); // http local/test origin
    expect(await sessionCount(account.id)).toBe(1);

    const principal = await resolve(cookie);
    expect(principal).toMatchObject({
      accountId: account.id,
      accountType: "CANDIDATE",
      status: "ACTIVE",
      emailVerified: true,
    });
    expect(Object.keys(principal!).sort()).toEqual(
      [
        "accountId",
        "accountType",
        "authenticatedAt",
        "emailVerified",
        "sessionId",
        "status",
      ].sort(),
    );
    const { rows } = await admin.query(
      'SELECT last_authenticated_at IS NOT NULL AS seen FROM auth."user" WHERE id = $1',
      [account.id],
    );
    expect(rows[0].seen).toBe(true);
  });

  it("marks cookies Secure for https origins", async () => {
    const httpsAuth = createIdentityRuntime({
      env: {
        ...parseAuthEnv(process.env),
        BETTER_AUTH_URL: "https://hiring.example.test",
        AUTH_TRUSTED_ORIGINS: ["https://hiring.example.test"],
        secureCookies: true,
      },
      db: getDatabase(),
      logger,
      transport: capture,
    }).auth;
    const account = await createTestAccount(httpsAuth);
    const response = await toSafeAuthResponse(
      await httpsAuth.handler(
        new Request("https://hiring.example.test/api/auth/sign-in/email", {
          method: "POST",
          headers: {
            origin: "https://hiring.example.test",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            email: account.email,
            password: TEST_PASSWORD,
          }),
        }),
      ),
      CORRELATION,
    );
    const setCookie = response.headers
      .getSetCookie()
      .find((c) => c.includes("psa.session_token="))!;
    expect(setCookie).toMatch(/^__Secure-psa\.session_token=/);
    expect(setCookie).toMatch(/;\s*Secure/i);
    expect(setCookie).toMatch(/HttpOnly/i);
  });

  it("keeps verified email a separate field, and requires it for candidates (M1.2)", async () => {
    // Staff: status ACTIVE with an unverified email still resolves; the
    // email flag is reported separately.
    const staff = await createTestAccount(auth, {
      accountType: "STAFF",
      emailVerified: false,
    });
    const principal = await resolve((await signIn(staff)).cookie);
    expect(principal?.status).toBe("ACTIVE");
    expect(principal?.emailVerified).toBe(false);
    expect(hasVerifiedEmail(principal!)).toBe(false);

    // Candidates: no session at all until the email is verified.
    const candidate = await createTestAccount(auth, { emailVerified: false });
    const { response, cookie } = await signIn(candidate);
    expect(response.status).toBe(401);
    expect(cookie).toBeNull();
    expect(await sessionCount(candidate.id)).toBe(0);
  });

  it.each([
    ["SERVICE", "ACTIVE"],
    ["STAFF", "INVITED"],
    ["CANDIDATE", "LOCKED"],
    ["STAFF", "DISABLED"],
    ["CANDIDATE", "CLOSED"],
  ] as const)(
    "refuses interactive sign-in for %s/%s and creates no session",
    async (accountType, status) => {
      const account = await createTestAccount(auth, { accountType, status });
      const { response, cookie } = await signIn(account);
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(cookie).toBeNull();
      expect(await sessionCount(account.id)).toBe(0);
    },
  );

  it("returns identical public responses for a wrong password and a restricted account", async () => {
    const restricted = await createTestAccount(auth, { status: "LOCKED" });
    const active = await createTestAccount(auth);
    const a = await signIn(restricted);
    const b = await signIn(active, "TEST wrong passphrase 0002");
    const strip = async (r: Response) => {
      const body = (await r.json()) as Record<string, unknown>;
      delete body.correlationId;
      return { status: r.status, body };
    };
    expect(await strip(b.response)).toEqual({
      status: 401,
      body: {
        type: "about:blank",
        title: "Sign-in is required",
        status: 401,
        code: "UNAUTHENTICATED",
      },
    });
    // Restricted-with-correct-password is indistinguishable from a wrong
    // password: no account-state enumeration.
    expect(await strip(a.response)).toEqual({
      status: 401,
      body: {
        type: "about:blank",
        title: "Sign-in is required",
        status: 401,
        code: "UNAUTHENTICATED",
      },
    });
  });

  it("rejects missing, malformed, expired, and revoked sessions", async () => {
    expect(await resolve(null)).toBeNull();
    expect(await resolve("psa.session_token=not-a-real-token")).toBeNull();
    expect(await resolve("psa.session_token=")).toBeNull();

    const account = await createTestAccount(auth);
    const { cookie } = await signIn(account);
    await admin.query(
      "UPDATE auth.session SET expires_at = now() - interval '1 minute' WHERE user_id = $1",
      [account.id],
    );
    expect(await resolve(cookie)).toBeNull();
  });

  it("revokes one session and keeps the other", async () => {
    const account = await createTestAccount(auth);
    const first = await signIn(account);
    const second = await signIn(account);
    const p1 = await resolve(first.cookie);
    expect(p1).not.toBeNull();
    const result = await revokeSession(account.id, p1!.sessionId, {
      db: getDatabase(),
      logger,
    });
    expect(result).toEqual({
      resultCode: "SESSION_REVOKED",
      accountRef: account.id,
      sessionsRevoked: 1,
    });
    expect(await resolve(first.cookie)).toBeNull();
    expect(await resolve(second.cookie)).not.toBeNull();
    // Idempotent, and another account's session cannot be targeted.
    expect(
      (
        await revokeSession(account.id, p1!.sessionId, {
          db: getDatabase(),
          logger,
        })
      ).resultCode,
    ).toBe("SESSION_NOT_FOUND");
    const other = await createTestAccount(auth);
    const p2 = await resolve(second.cookie);
    expect(
      (
        await revokeSession(other.id, p2!.sessionId, {
          db: getDatabase(),
          logger,
        })
      ).sessionsRevoked,
    ).toBe(0);
    expect(await resolve(second.cookie)).not.toBeNull();
  });

  it("revokes all sessions", async () => {
    const account = await createTestAccount(auth);
    const cookies = [
      (await signIn(account)).cookie,
      (await signIn(account)).cookie,
    ];
    const result = await revokeAllSessions(account.id, {
      db: getDatabase(),
      logger,
    });
    expect(result.sessionsRevoked).toBe(2);
    for (const cookie of cookies) expect(await resolve(cookie)).toBeNull();
    expect(JSON.stringify(result)).not.toMatch(/token/i);
  });

  it.each([
    ["lock", lockAccount, "LOCKED", "SECURITY_LOCK"],
    ["disable", disableAccount, "DISABLED", "ADMINISTRATIVE_DISABLE"],
    ["close", closeAccount, "CLOSED", "ACCOUNT_CLOSED"],
  ] as const)(
    "%s invalidates existing sessions immediately",
    async (_label, restrict, status, reason) => {
      const account = await createTestAccount(auth);
      const { cookie } = await signIn(account);
      expect(await resolve(cookie)).not.toBeNull();
      const result = await restrict(account.id, 1, {
        db: getDatabase(),
        logger,
      });
      expect(result).toEqual({
        resultCode: "ACCOUNT_RESTRICTED",
        accountRef: account.id,
        status,
        sessionsRevoked: 1,
      });
      expect(await resolve(cookie)).toBeNull();
      const { rows } = await admin.query(
        'SELECT status, disabled_reason_code, version, disabled_at IS NOT NULL AS stamped FROM auth."user" WHERE id = $1',
        [account.id],
      );
      expect(rows[0]).toEqual({
        status,
        disabled_reason_code: reason,
        version: 2,
        stamped: true,
      });
      // Idempotent re-application; a stale version is a conflict.
      expect(
        (await restrict(account.id, undefined, { db: getDatabase(), logger }))
          .resultCode,
      ).toBe("ALREADY_RESTRICTED");
      await expect(
        restrict(account.id, 1, { db: getDatabase(), logger }),
      ).rejects.toBeInstanceOf(ConflictError);
    },
  );

  it("treats CLOSED as terminal", async () => {
    const account = await createTestAccount(auth, { status: "CLOSED" });
    await expect(
      lockAccount(account.id, undefined, { db: getDatabase(), logger }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("fails closed when restriction races with sign-in and resolution", async () => {
    const account = await createTestAccount(auth);
    const { cookie } = await signIn(account);
    const [, raced] = await Promise.allSettled([
      lockAccount(account.id, undefined, { db: getDatabase(), logger }),
      signIn(account),
      resolve(cookie),
    ]);
    expect(raced.status).toBe("fulfilled");
    // Whatever interleaving happened, no session resolves afterwards.
    expect(await resolve(cookie)).toBeNull();
    if (raced.status === "fulfilled")
      expect(await resolve(raced.value.cookie)).toBeNull();
  });
});

describe("verification records", () => {
  // M1.2 replaced Better Auth's stateless verification links with the
  // email-OTP plugin; those flows are covered in candidate-registration.test.ts.
  it("consumes database verification records once and expires them", async () => {
    const ctxAuth = await auth.$context;
    const identifier = `test-purpose:${crypto.randomUUID()}`;
    await ctxAuth.internalAdapter.createVerificationValue({
      identifier,
      value: "TEST-verification-value",
      expiresAt: new Date(Date.now() + 60_000),
    });
    expect(
      await ctxAuth.internalAdapter.consumeVerificationValue(identifier),
    ).not.toBeNull();
    expect(
      await ctxAuth.internalAdapter.consumeVerificationValue(identifier),
    ).toBeNull();

    const expiredId = `test-purpose:${crypto.randomUUID()}`;
    await ctxAuth.internalAdapter.createVerificationValue({
      identifier: expiredId,
      value: "TEST-verification-value",
      expiresAt: new Date(Date.now() - 1_000),
    });
    expect(
      await ctxAuth.internalAdapter.consumeVerificationValue(expiredId),
    ).toBeNull();
    expect(
      await ctxAuth.internalAdapter.consumeVerificationValue(
        `other:${expiredId}`,
      ),
    ).toBeNull();
  });
});

describe("leakage", () => {
  it("keeps passwords, hashes, tokens, cookies, and emails out of logs and responses", async () => {
    const { rows } = await admin.query<{ password: string }>(
      "SELECT password FROM auth.account WHERE password IS NOT NULL LIMIT 1",
    );
    const hash = rows[0].password;
    const sessions = await admin.query<{ token: string }>(
      "SELECT token FROM auth.session LIMIT 5",
    );
    const emails = await admin.query<{ email: string }>(
      'SELECT email FROM auth."user" LIMIT 20',
    );
    const output = `${logs.raw()}\n${responseBodies.join("\n")}`;
    const leaks = {
      password: output.includes(TEST_PASSWORD),
      hash: output.includes(hash),
      sessionToken: sessions.rows.some((s) => output.includes(s.token)),
      email: emails.rows.some((e) => logs.raw().includes(e.email)),
      cookieHeader: /psa\.session_token=/.test(logs.raw()),
    };
    expect(leaks).toEqual({
      password: false,
      hash: false,
      sessionToken: false,
      email: false,
      cookieHeader: false,
    });
    expect(findCanaryCategories(output)).toEqual([]);
    // Every log line is allowlisted JSON.
    for (const record of logs.records()) {
      expect(
        Object.keys(record).every((k) =>
          [
            "level",
            "time",
            "service",
            "environment",
            "msg",
            "module",
            "resultCode",
            "recordRef",
            "correlationId",
            "errorCode",
            "eventCode",
            "actorRef",
            "action",
          ].includes(k),
        ),
        JSON.stringify(Object.keys(record)),
      ).toBe(true);
    }
  });
});

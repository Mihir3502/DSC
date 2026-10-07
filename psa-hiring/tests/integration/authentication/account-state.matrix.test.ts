import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { beginStaffActivation } from "@/modules/identity-access/application/activate-staff-account";
import { resolveCurrentAccount } from "@/modules/identity-access/application/current-account";
import { issueStaffInvitation } from "@/modules/identity-access/application/issue-staff-invitation";
import { queryCandidateSecurity } from "@/modules/identity-access/application/manage-candidate-sessions";
import { queryStaffSecurity } from "@/modules/identity-access/application/manage-staff-security";
import { registerCandidate } from "@/modules/identity-access/application/register-candidate";
import { signInCandidate } from "@/modules/identity-access/application/sign-in-candidate";
import { signInStaff } from "@/modules/identity-access/application/sign-in-staff";
import { verifyCandidateEmail } from "@/modules/identity-access/application/verify-candidate-email";
import { closeDatabasePool } from "@/shared/database";
import { TEST_PASSWORD, nextTestEmail } from "../../fixtures/auth/accounts";
import { CookieJar } from "../../fixtures/auth/cookie-jar";
import {
  activateStaff,
  createAuthorizationHarness,
  headers,
  prepareAuthorizationDatabase,
  signIn,
  STAFF_PASSWORD,
  type AuthorizationHarness,
} from "../support/authorization";
import { dropOwnedDatabase, type OwnedDatabase } from "../support/harness";

// M1.7 §9.1: principal type × account state × email state × staff MFA
// state × session state. Only an eligible combination may resolve an
// application principal, and candidate/staff/service surfaces stay
// isolated. Each row signs in through the real commands, changes exactly
// one server-owned fact with the privileged test connection, and asks the
// real resolver on the NEXT request. Synthetic accounts only.

const ctx = inject("postgres");
let db: OwnedDatabase;
let admin: Client;
let restoreEnv: () => void;
let h: AuthorizationHarness;

async function candidateSession(label: string) {
  const email = nextTestEmail(label);
  await registerCandidate(
    {
      intentToken: h.runtime.intents.issuePublic(),
      email,
      password: TEST_PASSWORD,
      passwordConfirmation: TEST_PASSWORD,
    },
    headers(),
    h.runtime,
  );
  const message = await h.capture.waitFor(email, "EMAIL_VERIFICATION_CODE", 1);
  const code = /code is: (\d+)/.exec(message.text)![1]!;
  await verifyCandidateEmail({ email, code }, headers(), h.runtime);
  const result = await signInCandidate(
    { email, password: TEST_PASSWORD },
    headers(),
    h.runtime,
  );
  const jar = new CookieJar();
  if (result.kind === "SIGNED_IN") jar.apply(result.setCookies);
  const { rows } = await admin.query<{ id: string }>(
    'SELECT id FROM auth."user" WHERE email = $1',
    [email],
  );
  return { jar, accountId: rows[0]!.id };
}

async function staffSession(label: string) {
  const staff = await activateStaff(h, label);
  const session = await signIn(h, staff);
  return { jar: session.jar, accountId: staff.accountId, email: staff.email };
}

const resolves = async (jar: CookieJar | null) =>
  (await resolveCurrentAccount(headers(jar ?? undefined), h.runtime)) !== null;

const setUser = (accountId: string, assignment: string) =>
  admin.query(`UPDATE auth."user" SET ${assignment} WHERE id = $1`, [
    accountId,
  ]);

beforeAll(async () => {
  ({ db, admin, restoreEnv } = await prepareAuthorizationDatabase(
    ctx,
    "authn_state",
  ));
  h = createAuthorizationHarness();
}, 180_000);

afterAll(async () => {
  await closeDatabasePool();
  await admin?.end();
  if (db) await dropOwnedDatabase(ctx, db.name);
  restoreEnv?.();
});

type Mutation = Readonly<{
  label: string;
  apply: (accountId: string) => Promise<unknown>;
  resolves: boolean;
}>;

const accountStates: readonly Mutation[] = [
  { label: "active (control)", apply: async () => undefined, resolves: true },
  ...(
    [
      ["LOCKED", "SECURITY_LOCK"],
      ["DISABLED", "ADMINISTRATIVE_DISABLE"],
      ["CLOSED", "ACCOUNT_CLOSED"],
    ] as const
  ).map(([status, reason]) => ({
    label: `status ${status}`,
    // Restricted states carry restriction metadata (database constraint).
    apply: (id: string) =>
      setUser(
        id,
        `status = '${status}', disabled_at = now(), disabled_reason_code = '${reason}'`,
      ),
    resolves: false,
  })),
  {
    label: "status INVITED",
    apply: (id: string) => setUser(id, "status = 'INVITED'"),
    resolves: false,
  },
  {
    label: "session expired",
    apply: (id: string) =>
      admin.query(
        "UPDATE auth.session SET expires_at = now() - interval '1 minute' WHERE user_id = $1",
        [id],
      ),
    resolves: false,
  },
  {
    label: "session revoked",
    apply: (id: string) =>
      admin.query("DELETE FROM auth.session WHERE user_id = $1", [id]),
    resolves: false,
  },
  {
    label: "principal type changed to SERVICE",
    apply: (id: string) => setUser(id, "account_type = 'SERVICE'"),
    resolves: false,
  },
];

describe("account state matrix (§9.1)", () => {
  it.each([
    ...accountStates.map((m) => [`candidate ${m.label}`, m] as const),

    [
      "candidate session presented on the staff surface",
      {
        label: "type STAFF",
        apply: (id: string) => setUser(id, "account_type = 'STAFF'"),
        resolves: false,
      },
    ] as const,
  ])(
    "resolves a principal only for eligible account, MFA, and session states: %s",
    async (_label, mutation) => {
      const session = await candidateSession("state-candidate");
      await mutation.apply(session.accountId);
      expect(await resolves(session.jar)).toBe(mutation.resolves);
    },
  );

  it.each([
    ...accountStates.map((m) => [`staff ${m.label}`, m] as const),
    [
      "staff MFA reset (factor disabled)",
      {
        label: "mfa off",
        apply: (id: string) => setUser(id, "two_factor_enabled = false"),
        resolves: false,
      },
    ] as const,
    [
      "staff stale account version (security change elsewhere)",
      {
        label: "stale",
        apply: (id: string) => setUser(id, "version = version + 1"),
        resolves: false,
      },
    ] as const,
    [
      "staff session presented on the candidate surface",
      {
        label: "type CANDIDATE",
        apply: (id: string) => setUser(id, "account_type = 'CANDIDATE'"),
        resolves: false,
      },
    ] as const,
  ])(
    "resolves a principal only for eligible account, MFA, and session states: %s",
    async (_label, mutation) => {
      const session = await staffSession("state-staff");
      await mutation.apply(session.accountId);
      expect(await resolves(session.jar)).toBe(mutation.resolves);
    },
  );

  it("resolves a principal only for eligible account, MFA, and session states: absent or temporary sessions", async () => {
    // No cookie at all.
    expect(await resolves(null)).toBe(false);
    // Password-only staff first factor (MFA challenge pending).
    const staff = await activateStaff(h, "state-challenge");
    const first = await signInStaff(
      { email: staff.email, password: STAFF_PASSWORD },
      headers(),
      h.runtime,
    );
    expect(first.kind).toBe("MFA_REQUIRED");
    const challenge = new CookieJar();
    if (first.kind === "MFA_REQUIRED") challenge.apply(first.setCookies);
    expect(await resolves(challenge)).toBe(false);
    // Temporary activation/enrollment session (incomplete MFA).
    const email = nextTestEmail("state-enroll");
    await issueStaffInvitation(
      { email, actor: { kind: "BOOTSTRAP", reason: "TEST_HARNESS" } },
      h.runtime,
    );
    const message = await h.capture.waitFor(email, "STAFF_INVITATION", 1);
    const token = /#invite=([A-Za-z0-9_-]{43})/.exec(message.text)![1]!;
    const enroll = new CookieJar();
    const begun = await beginStaffActivation(
      { token, password: STAFF_PASSWORD, passwordConfirmation: STAFF_PASSWORD },
      headers(enroll),
      h.runtime,
    );
    expect(begun.kind).toBe("ENROLLMENT_STARTED");
    if (begun.kind === "ENROLLMENT_STARTED") enroll.apply(begun.setCookies);
    expect(await resolves(enroll)).toBe(false);
  });

  it("resolves a principal only for eligible account, MFA, and session states: candidate email unverified is refused by every candidate surface", async () => {
    // Layering (M1.2/M1.5): sign-in never issues a session before
    // verification; if verification is later lost, the principal resolves
    // with emailVerified=false and the candidate self-service policy
    // (requiresVerifiedEmail) refuses every candidate surface.
    const session = await candidateSession("state-unverified");
    await setUser(session.accountId, "email_verified = false");
    const principal = await resolveCurrentAccount(
      headers(session.jar),
      h.runtime,
    );
    expect(principal?.emailVerified).toBe(false);
    expect(
      (await queryCandidateSecurity(headers(session.jar), h.runtime)).kind,
    ).not.toBe("OK");
  });

  it("keeps candidate and staff security surfaces isolated for every eligible principal", async () => {
    const candidate = await candidateSession("state-iso-candidate");
    const staff = await staffSession("state-iso-staff");
    expect(
      (await queryCandidateSecurity(headers(candidate.jar), h.runtime)).kind,
    ).toBe("OK");
    expect((await queryStaffSecurity(headers(staff.jar), h.runtime)).kind).toBe(
      "OK",
    );
    expect(
      (await queryStaffSecurity(headers(candidate.jar), h.runtime)).kind,
    ).toBe("NOT_PERMITTED");
    expect(
      (await queryCandidateSecurity(headers(staff.jar), h.runtime)).kind,
    ).toBe("NOT_PERMITTED");
  });
});

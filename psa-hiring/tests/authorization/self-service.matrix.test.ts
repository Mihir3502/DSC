import { describe, expect, it } from "vitest";
import type { AssuranceEvidence } from "@/modules/identity-access/domain/authentication-assurance";
import {
  evaluateSelfService,
  selfServicePolicies,
  type SelfServiceAccountFacts,
  type SelfServicePolicyDefinition,
} from "@/modules/identity-access/domain/self-service-policy";
import {
  account,
  candidateSession,
  principalOf,
  sessionOf,
  staffSession,
} from "../fixtures/authorization/matrix-harness";
import { NOW, at } from "../fixtures/scopes";
import { selfServiceRows } from "./matrix-manifest";

// M1.7 §9, §16: every account self-service policy (the only protected M1
// route/action authorization today) against owner, wrong audience,
// service, inactive, unverified, incomplete-MFA, password-only, foreign or
// stale session, and recent-authentication variants, through the pure
// policy the route/action boundary calls. The same policies run against
// PostgreSQL in tests/integration/authorization/route-object-field.test.ts.

type Variant = Readonly<{
  label: string;
  build: (p: SelfServicePolicyDefinition) => {
    principal: ReturnType<typeof principalOf> | null;
    account: SelfServiceAccountFacts | null;
    evidence: AssuranceEvidence | null;
  };
  expect: (p: SelfServicePolicyDefinition) => string;
}>;

const owner = (p: SelfServicePolicyDefinition) => {
  const id = p.audience === "CANDIDATE" ? account.CANDIDATE_A : account.ACTOR;
  const evidence =
    p.audience === "CANDIDATE"
      ? candidateSession(id)
      : staffSession(id, {
          primaryAuthenticatedAt: at(-10),
          mfaAuthenticatedAt: at(-10),
          reauthentication: p.recentAuth?.purpose
            ? {
                at: at(-10),
                method: "PASSWORD_TOTP",
                purpose: p.recentAuth.purpose,
              }
            : null,
        });
  return {
    principal: principalOf(id, p.audience),
    account: {
      id,
      accountType: p.audience,
      status: "ACTIVE",
      emailVerified: true,
      twoFactorEnabled: p.audience === "STAFF",
    } as SelfServiceAccountFacts,
    evidence,
  };
};

const variants: readonly Variant[] = [
  { label: "owner with a valid session", build: owner, expect: () => "ALLOW" },
  {
    label: "no principal",
    build: (p) => ({ ...owner(p), principal: null }),
    expect: () => "UNAUTHENTICATED",
  },
  {
    label: "wrong audience",
    build: (p) => {
      const other = p.audience === "CANDIDATE" ? "STAFF" : "CANDIDATE";
      const o = owner({ ...p, audience: other } as SelfServicePolicyDefinition);
      return o;
    },
    expect: () => "PERMISSION_MISSING",
  },
  {
    label: "service account",
    build: (p) => {
      const o = owner(p);
      return {
        ...o,
        principal: { ...o.principal!, accountType: "SERVICE" },
        account: { ...o.account!, accountType: "SERVICE" as never },
      };
    },
    expect: () => "PERMISSION_MISSING",
  },
  ...(["LOCKED", "DISABLED", "CLOSED", "INVITED"] as const).map((status) => ({
    label: `account ${status}`,
    build: (p: SelfServicePolicyDefinition) => {
      const o = owner(p);
      return { ...o, account: { ...o.account!, status } };
    },
    expect: () => "ACCOUNT_INACTIVE",
  })),
  {
    label: "principal and account mismatch",
    build: (p) => {
      const o = owner(p);
      return { ...o, account: { ...o.account!, id: account.OTHER_STAFF } };
    },
    expect: () => "ACCOUNT_INACTIVE",
  },
  {
    label: "unverified email",
    build: (p) => {
      const o = owner(p);
      return { ...o, account: { ...o.account!, emailVerified: false } };
    },
    expect: (p) => (p.audience === "CANDIDATE" ? "ACCOUNT_INACTIVE" : "ALLOW"),
  },
  {
    label: "foreign session evidence",
    build: (p) => ({
      ...owner(p),
      evidence: {
        ...owner(p).evidence!,
        sessionId: sessionOf(account.OTHER_STAFF),
      },
    }),
    expect: () => "UNAUTHENTICATED",
  },
  {
    label: "missing session evidence",
    build: (p) => ({ ...owner(p), evidence: null }),
    expect: () => "UNAUTHENTICATED",
  },
  {
    label: "staff MFA not enabled",
    build: (p) => {
      const o = owner(p);
      return { ...o, account: { ...o.account!, twoFactorEnabled: false } };
    },
    expect: (p) => (p.audience === "STAFF" ? "UNAUTHENTICATED" : "ALLOW"),
  },
  {
    label: "password-only staff session",
    build: (p) => ({
      ...owner(p),
      evidence: { ...owner(p).evidence!, method: "PASSWORD" },
    }),
    expect: (p) => (p.audience === "STAFF" ? "UNAUTHENTICATED" : "ALLOW"),
  },
  {
    label: "stale account version",
    build: (p) => ({
      ...owner(p),
      evidence: {
        ...owner(p).evidence!,
        sessionAccountVersion: 1,
        currentAccountVersion: 2,
      },
    }),
    expect: (p) => (p.audience === "STAFF" ? "UNAUTHENTICATED" : "ALLOW"),
  },
  {
    label: "temporary activation or challenge session",
    build: (p) => ({
      ...owner(p),
      evidence: { ...owner(p).evidence!, sessionPurpose: "STAFF_ACTIVATION" },
    }),
    expect: () => "UNAUTHENTICATED",
  },
  {
    label: "recent authentication expired",
    build: (p) => ({
      ...owner(p),
      evidence:
        p.audience === "STAFF"
          ? staffSession(account.ACTOR, {
              reauthentication: p.recentAuth?.purpose
                ? {
                    at: at(-3600),
                    method: "PASSWORD_TOTP",
                    purpose: p.recentAuth.purpose,
                  }
                : null,
            })
          : owner(p).evidence,
    }),
    expect: (p) => (p.recentAuth ? "RECENT_AUTH_REQUIRED" : "ALLOW"),
  },
];

describe("self-service policy matrix (§9, §16)", () => {
  it("covers every registered self-service policy", () => {
    expect(selfServiceRows.map((r) => r.policy).sort()).toEqual(
      selfServicePolicies.map((p) => p.code).sort(),
    );
  });

  const rows = selfServicePolicies.flatMap((p) =>
    variants.map((v) => [`${p.code}: ${v.label}`, p, v] as const),
  );
  it.each(rows)("%s", (_label, p, v) => {
    const { principal, account: facts, evidence } = v.build(p);
    const decision = evaluateSelfService({
      policy: p.code,
      principal,
      account: facts,
      evidence,
      now: NOW,
      recentWindowSeconds: 300,
    });
    const expected = v.expect(p);
    if (expected === "ALLOW")
      expect(decision.decision, JSON.stringify(decision)).toBe("ALLOW");
    else
      expect(decision, JSON.stringify(decision)).toMatchObject({
        decision: "DENY",
        reasonCode: expected,
      });
  });

  it("denies unknown or forged self-service policy codes", () => {
    for (const policy of ["ADMIN", "*", "candidate_security_read", null, 7]) {
      expect(
        evaluateSelfService({
          policy,
          principal: principalOf(account.CANDIDATE_A, "CANDIDATE"),
          account: null,
          evidence: null,
          now: NOW,
          recentWindowSeconds: 300,
        }),
      ).toMatchObject({ decision: "DENY", reasonCode: "PERMISSION_UNKNOWN" });
    }
  });
});

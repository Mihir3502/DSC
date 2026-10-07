import { describe, expect, it } from "vitest";
import type { AssuranceEvidence } from "./authentication-assurance";
import {
  evaluateSelfService,
  findSelfServicePolicy,
  selfServicePolicies,
  type SelfServiceAccountFacts,
  type SelfServiceInput,
} from "./self-service-policy";

// Account self-service policy matrix (packet M1.5 §8, §11, §25; ADR-0011).

const id = (n: number) =>
  `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const CANDIDATE = id(1);
const STAFF = id(2);
const SESSION = id(3);
const NOW = new Date("2026-10-06T12:00:00.000Z");
const ago = (s: number) => new Date(NOW.getTime() - s * 1000);

function account(
  overrides: Partial<SelfServiceAccountFacts> = {},
): SelfServiceAccountFacts {
  return {
    id: CANDIDATE,
    accountType: "CANDIDATE",
    status: "ACTIVE",
    emailVerified: true,
    twoFactorEnabled: false,
    ...overrides,
  };
}

function candidateEvidence(
  overrides: Partial<AssuranceEvidence> = {},
): AssuranceEvidence {
  return {
    accountId: CANDIDATE,
    sessionId: SESSION,
    sessionPurpose: "STANDARD",
    method: "PASSWORD",
    primaryAuthenticatedAt: ago(60),
    mfaAuthenticatedAt: null,
    sessionAccountVersion: 1,
    currentAccountVersion: 1,
    reauthentication: null,
    ...overrides,
  };
}

function staffEvidence(
  overrides: Partial<AssuranceEvidence> = {},
): AssuranceEvidence {
  return {
    accountId: STAFF,
    sessionId: SESSION,
    sessionPurpose: "STAFF",
    method: "PASSWORD_TOTP",
    primaryAuthenticatedAt: ago(3600),
    mfaAuthenticatedAt: ago(3600),
    sessionAccountVersion: 2,
    currentAccountVersion: 2,
    reauthentication: null,
    ...overrides,
  };
}

const candidate = (
  overrides: Partial<SelfServiceInput> = {},
): SelfServiceInput => ({
  policy: "CANDIDATE_SECURITY_READ",
  principal: {
    accountId: CANDIDATE,
    accountType: "CANDIDATE",
    sessionId: SESSION,
  },
  account: account(),
  evidence: candidateEvidence(),
  now: NOW,
  recentWindowSeconds: 300,
  ...overrides,
});

const staff = (
  overrides: Partial<SelfServiceInput> = {},
): SelfServiceInput => ({
  policy: "STAFF_SECURITY_READ",
  principal: { accountId: STAFF, accountType: "STAFF", sessionId: SESSION },
  account: account({ id: STAFF, accountType: "STAFF", twoFactorEnabled: true }),
  evidence: staffEvidence(),
  now: NOW,
  recentWindowSeconds: 300,
  ...overrides,
});

describe("self-service policy registry", () => {
  it("is closed, stable, audience-bound, and contains no catalog permission codes", () => {
    const codes = selfServicePolicies.map((p) => p.code);
    expect(new Set(codes).size).toBe(codes.length);
    for (const p of selfServicePolicies) {
      expect(p.code).toMatch(/^(CANDIDATE|STAFF)_[A-Z_]+$/);
      expect(p.code.startsWith(p.audience)).toBe(true);
      expect(Object.isFrozen(p)).toBe(true);
    }
    expect(findSelfServicePolicy("candidate.own_profile.read")).toBeNull();
    expect(findSelfServicePolicy("*")).toBeNull();
    expect(findSelfServicePolicy({ code: "STAFF_SECURITY_READ" })).toBeNull();
  });
});

describe("evaluateSelfService", () => {
  it("allows the current principal's own candidate and staff security", () => {
    expect(evaluateSelfService(candidate())).toEqual({
      decision: "ALLOW",
      policy: "CANDIDATE_SECURITY_READ",
      audience: "CANDIDATE",
      policyVersion: "self-p1",
      reasonCode: "ALLOWED",
    });
    expect(evaluateSelfService(staff()).decision).toBe("ALLOW");
  });

  it.each([
    ["unknown policy", candidate({ policy: "ADMIN" }), "PERMISSION_UNKNOWN"],
    ["no principal", candidate({ principal: null }), "UNAUTHENTICATED"],
    ["account missing", candidate({ account: null }), "ACCOUNT_INACTIVE"],
    [
      "account of another principal",
      candidate({ account: account({ id: STAFF }) }),
      "ACCOUNT_INACTIVE",
    ],
    [
      "principal type claim differs from the account",
      candidate({
        principal: {
          accountId: CANDIDATE,
          accountType: "STAFF",
          sessionId: SESSION,
        },
      }),
      "ACCOUNT_INACTIVE",
    ],
    [
      "unverified candidate",
      candidate({ account: account({ emailVerified: false }) }),
      "ACCOUNT_INACTIVE",
    ],
    [
      "candidate session gone",
      candidate({ evidence: null }),
      "UNAUTHENTICATED",
    ],
    [
      "candidate evidence for another session",
      candidate({ evidence: candidateEvidence({ sessionId: id(9) }) }),
      "UNAUTHENTICATED",
    ],
    [
      "candidate on a staff-purpose session",
      candidate({
        evidence: candidateEvidence({ sessionPurpose: "STAFF_ENROLLMENT" }),
      }),
      "UNAUTHENTICATED",
    ],
  ] as const)("denies: %s", (_name, input, reason) => {
    const decision = evaluateSelfService(input);
    expect(decision.decision).toBe("DENY");
    expect(decision.reasonCode).toBe(reason);
  });

  it.each(["INVITED", "LOCKED", "DISABLED", "CLOSED"] as const)(
    "denies a %s account for every policy",
    (status) => {
      for (const p of selfServicePolicies) {
        const input =
          p.audience === "CANDIDATE"
            ? candidate({ policy: p.code, account: account({ status }) })
            : staff({
                policy: p.code,
                account: account({
                  id: STAFF,
                  accountType: "STAFF",
                  status,
                  twoFactorEnabled: true,
                }),
              });
        expect(evaluateSelfService(input).reasonCode, p.code).toBe(
          "ACCOUNT_INACTIVE",
        );
      }
    },
  );

  it("never lets a principal use the other audience's policies", () => {
    for (const p of selfServicePolicies) {
      const input =
        p.audience === "STAFF"
          ? candidate({ policy: p.code })
          : staff({ policy: p.code });
      expect(evaluateSelfService(input).reasonCode, p.code).toBe(
        "PERMISSION_MISSING",
      );
    }
  });

  it("never lets a service account use any interactive policy", () => {
    for (const p of selfServicePolicies) {
      const decision = evaluateSelfService({
        policy: p.code,
        principal: {
          accountId: STAFF,
          accountType: "SERVICE",
          sessionId: SESSION,
        },
        account: account({
          id: STAFF,
          accountType: "SERVICE",
          twoFactorEnabled: true,
        }),
        evidence: staffEvidence(),
        now: NOW,
        recentWindowSeconds: 300,
      });
      expect(decision.decision, p.code).toBe("DENY");
    }
  });

  it.each([
    [
      "password-only first factor",
      { sessionPurpose: "STAFF_FIRST_FACTOR", method: "PASSWORD" as const },
    ],
    [
      "stale account version (MFA reset, password or role change)",
      { currentAccountVersion: 3 },
    ],
    ["wrong session", { sessionId: id(8) }],
    ["wrong account", { accountId: id(7) }],
  ])("denies staff with %s", (_name, overrides) => {
    expect(
      evaluateSelfService(staff({ evidence: staffEvidence(overrides) }))
        .reasonCode,
    ).toBe("UNAUTHENTICATED");
  });

  it("denies staff whose TOTP enrollment is gone", () => {
    expect(
      evaluateSelfService(
        staff({
          account: account({
            id: STAFF,
            accountType: "STAFF",
            twoFactorEnabled: false,
          }),
        }),
      ).reasonCode,
    ).toBe("UNAUTHENTICATED");
  });

  it("requires recent MFA for a staff password change and names the page step-up", () => {
    const stale = evaluateSelfService(
      staff({ policy: "STAFF_PASSWORD_CHANGE" }),
    );
    expect(stale).toEqual({
      decision: "DENY",
      policy: "STAFF_PASSWORD_CHANGE",
      policyVersion: "self-p1",
      reasonCode: "RECENT_AUTH_REQUIRED",
      stepUp: { kind: "PAGE", purpose: "CHANGE_PASSWORD" },
    });
    const fresh = evaluateSelfService(
      staff({
        policy: "STAFF_PASSWORD_CHANGE",
        evidence: staffEvidence({
          primaryAuthenticatedAt: ago(30),
          mfaAuthenticatedAt: ago(30),
        }),
      }),
    );
    expect(fresh.decision).toBe("ALLOW");
  });

  it("accepts backup-code regeneration only after a purpose-bound password + TOTP step-up", () => {
    const base = { policy: "STAFF_BACKUP_CODES_REGENERATE" } as const;
    expect(evaluateSelfService(staff(base))).toMatchObject({
      reasonCode: "RECENT_AUTH_REQUIRED",
      stepUp: { kind: "INLINE" },
    });
    // A fresh sign-in alone is not bound to the purpose.
    expect(
      evaluateSelfService(
        staff({
          ...base,
          evidence: staffEvidence({
            primaryAuthenticatedAt: ago(10),
            mfaAuthenticatedAt: ago(10),
          }),
        }),
      ).reasonCode,
    ).toBe("RECENT_AUTH_REQUIRED");
    // Bound to another purpose: still required.
    expect(
      evaluateSelfService(
        staff({
          ...base,
          evidence: staffEvidence({
            reauthentication: {
              at: ago(10),
              method: "PASSWORD_TOTP",
              purpose: "STAFF_SECURITY",
            },
          }),
        }),
      ).reasonCode,
    ).toBe("RECENT_AUTH_REQUIRED");
    expect(
      evaluateSelfService(
        staff({
          ...base,
          evidence: staffEvidence({
            reauthentication: {
              at: ago(10),
              method: "PASSWORD_TOTP",
              purpose: "REGENERATE_BACKUP_CODES",
            },
          }),
        }),
      ).decision,
    ).toBe("ALLOW");
    // Expired step-up: required again.
    expect(
      evaluateSelfService(
        staff({
          ...base,
          evidence: staffEvidence({
            reauthentication: {
              at: ago(301),
              method: "PASSWORD_TOTP",
              purpose: "REGENERATE_BACKUP_CODES",
            },
          }),
        }),
      ).reasonCode,
    ).toBe("RECENT_AUTH_REQUIRED");
  });

  it("returns only closed safe fields in every decision", () => {
    const decisions = [
      evaluateSelfService(candidate()),
      evaluateSelfService(staff({ policy: "STAFF_PASSWORD_CHANGE" })),
      evaluateSelfService(candidate({ policy: "STAFF_SECURITY_READ" })),
    ];
    for (const d of decisions) {
      expect(
        Object.keys(d).every((k) =>
          [
            "decision",
            "policy",
            "audience",
            "policyVersion",
            "reasonCode",
            "stepUp",
          ].includes(k),
        ),
      ).toBe(true);
      const text = JSON.stringify(d);
      expect(text).not.toContain(CANDIDATE);
      expect(text).not.toContain(STAFF);
      expect(text).not.toContain(SESSION);
    }
  });
});

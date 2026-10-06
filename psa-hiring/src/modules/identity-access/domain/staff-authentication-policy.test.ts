import { describe, expect, it } from "vitest";
import {
  evaluateAssurance,
  isReauthenticationPurpose,
  reauthenticationDestination,
  type AssuranceEvidence,
  type AssuranceRequest,
} from "./authentication-assurance";
import {
  decideSessionIssuance,
  type IssuanceAccount,
} from "./session-issuance-policy";
import {
  canIssueStaffInvitation,
  decideActivation,
  decideInvitationTransition,
  isLiveInvitation,
  type InvitationSnapshot,
} from "./staff-invitation";
import {
  decideRecoveryTransition,
  type RecoveryCaseSnapshot,
} from "./staff-recovery";

// Pure M1.3 policies: invitation lifecycle, session issuance, assurance
// evaluation, and the recovery state machine (packet M1.3 §7, §9, §13, §14).

const T0 = new Date("2026-10-06T12:00:00.000Z");
const at = (seconds: number) => new Date(T0.getTime() + seconds * 1000);
const ACCOUNT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const THIRD = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const SESSION = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

describe("staff invitation policy", () => {
  const pending: InvitationSnapshot = {
    status: "PENDING",
    purpose: "STAFF_ACTIVATION",
    expiresAt: at(3600),
    accountId: null,
  };

  it("is live strictly before expiry and never after a terminal state", () => {
    expect(isLiveInvitation(pending, at(3599))).toBe(true);
    expect(isLiveInvitation(pending, at(3600))).toBe(false);
    for (const status of [
      "ACCEPTED",
      "REVOKED",
      "EXPIRED",
      "SUPERSEDED",
    ] as const) {
      expect(isLiveInvitation({ ...pending, status }, T0)).toBe(false);
      for (const t of ["ACCEPT", "REVOKE", "SUPERSEDE", "EXPIRE"] as const) {
        expect(
          decideInvitationTransition({ ...pending, status }, t, T0),
        ).toEqual({
          kind: "not-allowed",
        });
      }
    }
  });

  it("turns accept/revoke/supersede of an expired invitation into expiry", () => {
    for (const t of ["ACCEPT", "REVOKE", "SUPERSEDE"] as const) {
      expect(decideInvitationTransition(pending, t, at(3600))).toEqual({
        kind: "expired",
      });
    }
    expect(decideInvitationTransition(pending, "EXPIRE", at(10))).toEqual({
      kind: "not-allowed",
    });
    expect(decideInvitationTransition(pending, "EXPIRE", at(3600))).toEqual({
      kind: "apply",
      to: "EXPIRED",
    });
    expect(decideInvitationTransition(pending, "ACCEPT", at(10))).toEqual({
      kind: "apply",
      to: "ACCEPTED",
    });
  });

  it("never converts candidate/service accounts or duplicates staff", () => {
    const staff = (status: "INVITED" | "ACTIVE" | "LOCKED") => ({
      id: ACCOUNT,
      accountType: "STAFF" as const,
      status,
    });
    expect(canIssueStaffInvitation(null, "STAFF_ACTIVATION")).toBe(true);
    expect(canIssueStaffInvitation(staff("INVITED"), "STAFF_ACTIVATION")).toBe(
      true,
    );
    expect(canIssueStaffInvitation(staff("ACTIVE"), "STAFF_ACTIVATION")).toBe(
      false,
    );
    expect(canIssueStaffInvitation(staff("LOCKED"), "STAFF_ACTIVATION")).toBe(
      false,
    );
    for (const accountType of ["CANDIDATE", "SERVICE"] as const) {
      expect(
        canIssueStaffInvitation(
          { id: ACCOUNT, accountType, status: "INVITED" },
          "STAFF_ACTIVATION",
        ),
      ).toBe(false);
    }
    expect(canIssueStaffInvitation(null, "STAFF_REENROLLMENT")).toBe(false);
    expect(
      canIssueStaffInvitation(staff("INVITED"), "STAFF_REENROLLMENT"),
    ).toBe(true);
  });

  it("creates or resumes only the bound staff account", () => {
    expect(decideActivation(pending, null)).toEqual({ kind: "CREATE" });
    const invited = {
      id: ACCOUNT,
      accountType: "STAFF" as const,
      status: "INVITED" as const,
    };
    expect(decideActivation(pending, invited)).toEqual({
      kind: "RESUME",
      accountId: ACCOUNT,
    });
    expect(decideActivation({ ...pending, accountId: OTHER }, invited)).toEqual(
      {
        kind: "NOT_ELIGIBLE",
      },
    );
    expect(
      decideActivation(pending, { ...invited, accountType: "CANDIDATE" }),
    ).toEqual({ kind: "NOT_ELIGIBLE" });
    expect(decideActivation(pending, { ...invited, status: "ACTIVE" })).toEqual(
      {
        kind: "NOT_ELIGIBLE",
      },
    );
    expect(
      decideActivation({ ...pending, purpose: "STAFF_REENROLLMENT" }, null),
    ).toEqual({ kind: "NOT_ELIGIBLE" });
  });
});

describe("session issuance policy", () => {
  const staff: IssuanceAccount = {
    id: ACCOUNT,
    accountType: "STAFF",
    status: "ACTIVE",
    emailVerified: true,
    twoFactorEnabled: true,
    version: 3,
  };

  it("refuses any staff session without a declared staff command", () => {
    expect(decideSessionIssuance(staff, undefined, T0)).toBeNull();
    expect(
      decideSessionIssuance({ ...staff, status: "INVITED" }, undefined, T0),
    ).toBeNull();
  });

  it("stamps candidate sessions STANDARD and refuses service accounts", () => {
    const candidate = { ...staff, accountType: "CANDIDATE" as const };
    expect(decideSessionIssuance(candidate, undefined, T0)).toMatchObject({
      authPurpose: "STANDARD",
      authMethod: "PASSWORD",
      mfaAuthenticatedAt: null,
    });
    expect(
      decideSessionIssuance(
        { ...candidate, emailVerified: false },
        undefined,
        T0,
      ),
    ).toBeNull();
    expect(
      decideSessionIssuance(
        { ...staff, accountType: "SERVICE" },
        undefined,
        T0,
      ),
    ).toBeNull();
    // A staff intent never issues a candidate session.
    expect(
      decideSessionIssuance(
        candidate,
        { kind: "STAFF_FIRST_FACTOR", accountId: ACCOUNT },
        T0,
      ),
    ).toBeNull();
  });

  it("binds the intent to one account and the right state", () => {
    expect(
      decideSessionIssuance(
        staff,
        { kind: "STAFF_FIRST_FACTOR", accountId: OTHER },
        T0,
      ),
    ).toBeNull();
    expect(
      decideSessionIssuance(
        { ...staff, twoFactorEnabled: false },
        { kind: "STAFF_FIRST_FACTOR", accountId: ACCOUNT },
        T0,
      ),
    ).toBeNull();
    expect(
      decideSessionIssuance(
        staff,
        {
          kind: "STAFF_ACTIVATION",
          accountId: ACCOUNT,
          primaryAuthenticatedAt: T0,
        },
        T0,
      ),
    ).toBeNull();
    expect(
      decideSessionIssuance(
        { ...staff, status: "INVITED", twoFactorEnabled: false },
        {
          kind: "STAFF_ACTIVATION",
          accountId: ACCOUNT,
          primaryAuthenticatedAt: T0,
        },
        T0,
      ),
    ).toMatchObject({
      authPurpose: "STAFF_ACTIVATION",
      authMethod: "PASSWORD",
    });
    expect(
      decideSessionIssuance(
        { ...staff, status: "LOCKED" },
        {
          kind: "STAFF_MFA",
          accountId: ACCOUNT,
          method: "PASSWORD_TOTP",
          primaryAuthenticatedAt: T0,
          mfaAuthenticatedAt: T0,
        },
        T0,
      ),
    ).toBeNull();
    expect(
      decideSessionIssuance(
        staff,
        {
          kind: "STAFF_MFA",
          accountId: ACCOUNT,
          method: "PASSWORD_BACKUP_CODE",
          primaryAuthenticatedAt: at(-30),
          mfaAuthenticatedAt: T0,
        },
        T0,
      ),
    ).toEqual({
      authPurpose: "STAFF",
      authMethod: "PASSWORD_BACKUP_CODE",
      primaryAuthenticatedAt: at(-30),
      mfaAuthenticatedAt: T0,
      accountVersion: 3,
    });
  });
});

describe("authentication assurance", () => {
  const evidence: AssuranceEvidence = {
    accountId: ACCOUNT,
    sessionId: SESSION,
    sessionPurpose: "STAFF",
    method: "PASSWORD_TOTP",
    primaryAuthenticatedAt: T0,
    mfaAuthenticatedAt: at(20),
    sessionAccountVersion: 2,
    currentAccountVersion: 2,
    reauthentication: null,
  };
  const request = (
    overrides: Partial<AssuranceRequest> = {},
  ): AssuranceRequest => ({
    policy: "RECENT_STAFF_AUTH",
    accountId: ACCOUNT,
    sessionId: SESSION,
    now: at(60),
    recentWindowSeconds: 300,
    ...overrides,
  });

  it("denies missing, foreign, non-MFA, stale, and impossible evidence", () => {
    expect(evaluateAssurance(null, request())).toEqual({
      kind: "DENY",
      reason: "NO_EVIDENCE",
    });
    expect(evaluateAssurance(evidence, request({ accountId: OTHER }))).toEqual({
      kind: "DENY",
      reason: "ACCOUNT_MISMATCH",
    });
    expect(evaluateAssurance(evidence, request({ sessionId: OTHER }))).toEqual({
      kind: "DENY",
      reason: "SESSION_MISMATCH",
    });
    for (const broken of [
      { sessionPurpose: "STAFF_ACTIVATION" },
      { sessionPurpose: "STAFF_FIRST_FACTOR" },
      { method: "PASSWORD" as const },
      { mfaAuthenticatedAt: null },
    ]) {
      expect(evaluateAssurance({ ...evidence, ...broken }, request())).toEqual({
        kind: "DENY",
        reason: "NOT_MFA_SESSION",
      });
    }
    expect(
      evaluateAssurance({ ...evidence, currentAccountVersion: 3 }, request()),
    ).toEqual({ kind: "DENY", reason: "STALE_ACCOUNT_VERSION" });
    expect(evaluateAssurance(evidence, request({ now: at(14) }))).toEqual({
      kind: "DENY",
      reason: "CLOCK_SKEW",
    });
    expect(
      evaluateAssurance(evidence, request({ recentWindowSeconds: 0 })),
    ).toEqual({ kind: "DENY", reason: "INVALID_REQUEST" });
  });

  it("allows a normal staff session however old", () => {
    expect(
      evaluateAssurance(
        evidence,
        request({ policy: "NORMAL_STAFF_SESSION", now: at(86_400) }),
      ),
    ).toMatchObject({ kind: "ALLOW" });
  });

  it("dates sign-in by the older factor and expires exactly at the boundary", () => {
    // The password at T0 bounds freshness even though MFA was at T0+20.
    expect(
      evaluateAssurance(evidence, request({ now: at(299) })),
    ).toMatchObject({
      kind: "ALLOW",
      at: T0,
    });
    expect(evaluateAssurance(evidence, request({ now: at(300) }))).toEqual({
      kind: "CHALLENGE",
      reason: "REAUTHENTICATION_REQUIRED",
    });
  });

  it("never lets a backup code satisfy the strongest policy", () => {
    const backup = { ...evidence, method: "PASSWORD_BACKUP_CODE" as const };
    expect(evaluateAssurance(backup, request())).toMatchObject({
      kind: "ALLOW",
    });
    expect(
      evaluateAssurance(backup, request({ policy: "RECENT_STRONG_AUTH" })),
    ).toEqual({ kind: "CHALLENGE", reason: "STRONGER_METHOD_REQUIRED" });
    expect(
      evaluateAssurance(
        {
          ...backup,
          reauthentication: {
            at: at(200),
            method: "PASSWORD_TOTP",
            purpose: "STAFF_SECURITY",
          },
        },
        request({ policy: "RECENT_STRONG_AUTH", now: at(400) }),
      ),
    ).toMatchObject({ kind: "ALLOW", method: "PASSWORD_TOTP", at: at(200) });
  });

  it("binds purpose-specific checks to reauthentication for that purpose", () => {
    const reauthed = {
      ...evidence,
      reauthentication: {
        at: at(100),
        method: "PASSWORD_TOTP" as const,
        purpose: "CHANGE_PASSWORD",
      },
    };
    // A fresh sign-in alone does not satisfy a purpose-bound check.
    expect(
      evaluateAssurance(
        evidence,
        request({ purpose: "REGENERATE_BACKUP_CODES" }),
      ),
    ).toEqual({ kind: "CHALLENGE", reason: "REAUTHENTICATION_REQUIRED" });
    expect(
      evaluateAssurance(
        reauthed,
        request({ purpose: "REGENERATE_BACKUP_CODES", now: at(120) }),
      ),
    ).toEqual({ kind: "CHALLENGE", reason: "REAUTHENTICATION_REQUIRED" });
    expect(
      evaluateAssurance(
        reauthed,
        request({ purpose: "CHANGE_PASSWORD", now: at(399) }),
      ),
    ).toMatchObject({ kind: "ALLOW", at: at(100) });
    expect(
      evaluateAssurance(
        reauthed,
        request({ purpose: "CHANGE_PASSWORD", now: at(400) }),
      ),
    ).toEqual({ kind: "CHALLENGE", reason: "REAUTHENTICATION_REQUIRED" });
  });

  it("resolves only registry purposes to same-origin destinations", () => {
    expect(isReauthenticationPurpose("CHANGE_PASSWORD")).toBe(true);
    expect(isReauthenticationPurpose("REGENERATE_BACKUP_CODES")).toBe(true);
    expect(isReauthenticationPurpose("toString")).toBe(false);
    expect(reauthenticationDestination("CHANGE_PASSWORD")).toBe(
      "/staff/security#password",
    );
    for (const evil of [
      "https://evil.example",
      "//evil.example",
      "/\\evil",
      "javascript:alert(1)",
      "__proto__",
      "REGENERATE_BACKUP_CODES",
      undefined,
    ]) {
      expect(reauthenticationDestination(evil)).toBe("/staff/security");
    }
  });
});

describe("staff recovery state machine", () => {
  const open: RecoveryCaseSnapshot = {
    status: "REQUESTED",
    accountId: ACCOUNT,
    expiresAt: at(3600),
    verifierAccountId: null,
    approverAccountId: null,
    approvalExpiresAt: null,
  };
  const step = (
    snapshot: RecoveryCaseSnapshot,
    type: Parameters<typeof decideRecoveryTransition>[1]["type"],
    actor: string,
    now = at(10),
  ) => decideRecoveryTransition(snapshot, { type, actorAccountId: actor }, now);

  it("walks the approved path with distinct verifier and approver", () => {
    expect(step(open, "START_VERIFICATION", OTHER)).toEqual({
      kind: "apply",
      to: "IDENTITY_VERIFICATION_PENDING",
      actorRole: "VERIFIER",
    });
    const verifying = {
      ...open,
      status: "IDENTITY_VERIFICATION_PENDING" as const,
      verifierAccountId: OTHER,
    };
    expect(step(verifying, "CONFIRM_IDENTITY", THIRD)).toEqual({
      kind: "denied",
      reason: "NOT_ASSIGNED_VERIFIER",
    });
    expect(step(verifying, "CONFIRM_IDENTITY", OTHER)).toEqual({
      kind: "apply",
      to: "APPROVAL_PENDING",
    });
    const awaiting = { ...verifying, status: "APPROVAL_PENDING" as const };
    expect(step(awaiting, "APPROVE", OTHER)).toEqual({
      kind: "denied",
      reason: "VERIFIER_CANNOT_APPROVE",
    });
    expect(step(awaiting, "APPROVE", THIRD)).toMatchObject({
      kind: "apply",
      to: "APPROVED",
      actorRole: "APPROVER",
    });
    const approved = {
      ...awaiting,
      status: "APPROVED" as const,
      approverAccountId: THIRD,
      approvalExpiresAt: at(600),
    };
    expect(step(approved, "COMPLETE", THIRD)).toMatchObject({
      kind: "apply",
      to: "COMPLETED",
      resolution: "RESET_COMPLETED",
    });
  });

  it("denies self-action, invalid transitions, and terminal changes", () => {
    for (const type of [
      "START_VERIFICATION",
      "CONFIRM_IDENTITY",
      "APPROVE",
      "COMPLETE",
      "REJECT",
      "CANCEL",
    ] as const) {
      expect(step(open, type, ACCOUNT)).toEqual({
        kind: "denied",
        reason: "SELF_ACTION",
      });
    }
    expect(step(open, "APPROVE", OTHER)).toEqual({
      kind: "denied",
      reason: "INVALID_TRANSITION",
    });
    expect(step(open, "COMPLETE", OTHER)).toEqual({
      kind: "denied",
      reason: "INVALID_TRANSITION",
    });
    for (const status of [
      "COMPLETED",
      "REJECTED",
      "EXPIRED",
      "CANCELLED",
    ] as const) {
      expect(step({ ...open, status }, "CANCEL", OTHER)).toEqual({
        kind: "denied",
        reason: "TERMINAL",
      });
    }
    expect(step(open, "REJECT", OTHER)).toMatchObject({
      to: "REJECTED",
      resolution: "IDENTITY_NOT_VERIFIED",
    });
  });

  it("expires requests and approvals exactly at their deadlines", () => {
    expect(step(open, "START_VERIFICATION", OTHER, at(3600))).toEqual({
      kind: "expired",
      resolution: "REQUEST_EXPIRED",
    });
    const approved = {
      ...open,
      status: "APPROVED" as const,
      verifierAccountId: OTHER,
      approverAccountId: THIRD,
      approvalExpiresAt: at(600),
    };
    expect(step(approved, "COMPLETE", THIRD, at(599))).toMatchObject({
      kind: "apply",
    });
    expect(step(approved, "COMPLETE", THIRD, at(600))).toEqual({
      kind: "expired",
      resolution: "APPROVAL_EXPIRED",
    });
  });
});

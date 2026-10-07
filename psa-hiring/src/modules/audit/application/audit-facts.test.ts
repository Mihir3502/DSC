import { describe, expect, it } from "vitest";
import {
  AuditValidationError,
  prepareEvent,
  type AuditFacts,
} from "./audit-facts";

// Packet M1.6 §9–§11, §26 (1–4), AC-M1.6-02/03: strict catalog validation
// and server-owned envelopes. Synthetic identifiers only.

const ACCOUNT = "0b9a7a3e-6a55-4c8e-9a3b-2f1d0c4e5a6b";
const ACTOR = "1c8b6b4f-7b66-4d9f-8b4c-3e2e1d5f6b7c";
const RECORD = "2d7c5c3a-8c77-4e0a-9c5d-4f3f2e6a7c8d";
const context = {
  source: "LOCAL_TEST" as const,
  requestId: "3e6d4d2b-9d88-4f1b-8d6e-5a4a3f7b8d9e",
  eventId: "4f5e3e1c-ae99-4a2c-9e7f-6b5b4a8c9eaf",
};

const reason = (facts: unknown) => {
  try {
    prepareEvent(facts as AuditFacts, context);
    return "ACCEPTED";
  } catch (error) {
    return error instanceof AuditValidationError ? error.reason : "THREW";
  }
};

describe("audit event construction", () => {
  it("builds one exact safe envelope for a registered event and context", () => {
    const prepared = prepareEvent(
      {
        code: "auth.sessions_revoked",
        accountRef: ACCOUNT,
        permissionCode: "self_service.candidate_sessions_end_all",
        policyVersion: "self-p1",
        count: 2,
      },
      context,
    );
    expect(prepared.kind).toBe("AUDIT");
    if (prepared.kind !== "AUDIT") return;
    expect(prepared.envelope).toEqual({
      id: context.eventId,
      schemaVersion: 1,
      eventName: "auth.sessions_revoked",
      eventVersion: 1,
      category: "IDENTITY",
      outcome: "SUCCEEDED",
      organizationId: null,
      candidacyId: null,
      actorType: "USER",
      actorUserId: ACCOUNT,
      effectiveRoleCode: null,
      effectiveAssignmentId: null,
      effectiveScopeType: null,
      effectiveScopeReferenceId: null,
      permissionCode: "self_service.candidate_sessions_end_all",
      action: "SESSIONS_REVOKE",
      targetType: "USER_ACCOUNT",
      targetId: ACCOUNT,
      source: "LOCAL_TEST",
      reasonCode: null,
      correlationId: context.requestId,
      requestId: context.requestId,
      idempotencyKey: null,
      metadata: { policy_version: "self-p1", affected_count: 2 },
      previousRecordVersion: null,
      newRecordVersion: null,
      retentionClassCode: "AUDIT_STANDARD_UNSET",
    });
  });

  it("rejects unknown events, versions, and facts before any write", () => {
    expect(reason({ code: "auth.not_registered" })).toBe("UNKNOWN_EVENT");
    expect(reason({ code: "Robert'); DROP TABLE" })).toBe("UNKNOWN_EVENT");
    expect(
      reason({ code: "auth.sign_in_failed", category: "denied", extra: 1 }),
    ).toBe("UNEXPECTED_FACT");
    // Metadata cannot be smuggled in as a fact.
    expect(
      reason({
        code: "auth.sign_in_failed",
        category: "denied",
        metadata: { note: "x" },
      }),
    ).toBe("UNEXPECTED_FACT");
  });

  it("rejects missing required actor, target, reason, or authority facts", () => {
    expect(
      reason({ code: "auth.session_revoked", permissionCode: "x.y" }),
    ).toBe("MISSING_FACT");
    expect(
      reason({ code: "authz.high_risk_denied", permissionCode: "a.b" }),
    ).toBe("MISSING_FACT");
    expect(
      reason({
        code: "authz.assignment_approved",
        recordRef: RECORD,
        accountRef: ACCOUNT,
        roleCode: "RECRUITER",
        scopeType: "BRANCH",
        newVersion: 2,
      }),
    ).toBe("MISSING_ACTOR");
    expect(
      reason({
        code: "authz.restricted_access_allowed",
        actorRef: ACTOR,
        recordRef: RECORD,
        permissionCode: "medical_document.download",
        effective: {
          roleCode: "COMPLIANCE_REVIEWER",
          assignmentId: null,
          scopeType: "BRANCH",
          scopeReferenceId: null,
        },
      }),
    ).toBe("INVALID_AUTHORITY");
  });

  it("ignores or rejects client-supplied actor, time, outcome, role, and scope", () => {
    for (const key of [
      "occurredAt",
      "outcome",
      "actorType",
      "eventName",
      "partition",
      "retentionClassCode",
      "integrityHash",
    ]) {
      expect(
        reason({ code: "auth.sign_in_failed", category: "denied", [key]: "X" }),
        key,
      ).toBe("UNEXPECTED_FACT");
    }
    // The actor of a self-service event is the subject; another actor rejects.
    expect(
      reason({
        code: "auth.session_revoked",
        accountRef: ACCOUNT,
        actorRef: ACTOR,
        permissionCode: "a.b",
      }),
    ).toBe("UNEXPECTED_FACT");
    expect(
      reason({
        code: "authz.assignment_approved",
        actorRef: ACTOR,
        recordRef: RECORD,
        accountRef: ACCOUNT,
        roleCode: "RECRUITER",
        scopeType: "NOT_A_SCOPE",
        newVersion: 2,
      }),
    ).toBe("INVALID_SCOPE");
  });

  it("rejects prohibited, free-text, and oversized values", () => {
    const canaries = [
      "test.person@example.test",
      "TESTCANARY password hunter2",
      "198.51.100.7",
      "Mozilla/5.0 TEST-agent",
      "Bearer TESTCANARY-token",
      "SELECT * FROM auth.user",
      "free text reason: candidate was rude",
    ];
    for (const canary of canaries) {
      expect(
        reason({
          code: "auth.sign_in_failed",
          category: "denied",
          accountRef: canary,
        }),
      ).toBe("INVALID_REFERENCE");
      expect(
        reason({
          code: "auth.sign_in_failed",
          category: "denied",
          reasonCode: canary,
        }),
      ).toBe("INVALID_CODE");
      expect(
        reason({
          code: "auth.sign_in_failed",
          category: canary,
        }),
      ).toBe("INVALID_CATEGORY");
    }
    expect(
      reason({
        code: "audit.query_executed",
        actorRef: ACTOR,
        permissionCode: "audit.read.assigned",
        count: 1,
        filterCodes: Array.from({ length: 13 }, () => "IDENTITY"),
      }),
    ).toBe("INVALID_FILTER");
    expect(
      reason({
        code: "auth.sessions_revoked",
        accountRef: ACCOUNT,
        permissionCode: "a.b",
        count: 10_000_000,
      }),
    ).toBe("INVALID_INTEGER");
  });

  it("derives an idempotency key from the target and new record version", () => {
    const prepared = prepareEvent(
      {
        code: "authz.assignment_approved",
        actorRef: ACTOR,
        recordRef: RECORD,
        accountRef: ACCOUNT,
        roleCode: "RECRUITER",
        scopeType: "BRANCH",
        previousVersion: 1,
        newVersion: 2,
      },
      context,
    );
    expect(prepared.kind === "AUDIT" && prepared.envelope.idempotencyKey).toBe(
      `${RECORD}:2`,
    );
    expect(
      reason({
        code: "authz.assignment_approved",
        actorRef: ACTOR,
        recordRef: RECORD,
        accountRef: ACCOUNT,
        roleCode: "RECRUITER",
        scopeType: "BRANCH",
        previousVersion: 1,
        newVersion: 5,
      }),
    ).toBe("INVALID_VERSIONS");
  });

  it("keeps a malformed correlation ID from dropping required evidence", () => {
    const prepared = prepareEvent(
      {
        code: "auth.sign_in_failed",
        category: "invalid_credentials",
        correlationId: "not-a-uuid",
      },
      context,
    );
    expect(
      prepared.kind === "SECURITY" && prepared.envelope.correlationId,
    ).toBe(context.requestId);
  });

  it("keeps telemetry codes out of durable streams", () => {
    expect(
      prepareEvent({ code: "auth.registration_requested" }, context).kind,
    ).toBe("TELEMETRY");
  });
});

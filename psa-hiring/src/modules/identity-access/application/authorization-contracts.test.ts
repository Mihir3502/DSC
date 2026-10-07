import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  candidatePrincipal,
  ids,
  memoryAuthorization,
  NOW,
  ago,
  staffEvidence,
  staffPrincipal,
  sid,
} from "../../../../tests/fixtures/authorization/memory-facts";
import type { AuthorizationRequest } from "../domain/authorization-decision";
import {
  denialReasons,
  type SensitivityLevel,
} from "../domain/authorization-vocabulary";
import {
  outcomeForDenial,
  outcomeForResult,
  publicCodeForOutcome,
} from "../delivery/authorization-error-mapper";
import { defineProjection } from "../presentation/authorized-projector";
import type { FieldRule } from "../presentation/field-policy";
import { evaluateAuthorization, evaluateQueryScope } from "./authorize";
import { projectAuthorized } from "./authorize-fields";
import {
  narrowConstraint,
  parseListQuery,
  type ListQuerySpec,
} from "./authorize-query";
import {
  authorizeDocumentAccess,
  productionDocumentPermissions,
  type DocumentEnvelope,
} from "./ports/authorized-document-access";
import {
  authorizeProviderCallback,
  authorizeServiceOperation,
  parseJobPayload,
  productionServiceGrants,
} from "./ports/noninteractive-authorization";
import {
  authorizeEnvelopeAccess,
  type ResourceEnvelope,
} from "./ports/resource-authorization-envelope";

// Reusable M1.5 authorization contracts over in-memory M1.4 facts (packet
// M1.5 §10, §14–§17; AC-M1.5-04/05/08/09/10). Synthetic resources only;
// no business endpoint, table, or file exists. Real-PostgreSQL proofs are
// in tests/integration/authorization/route-object-field.test.ts.

function harness() {
  const h = memoryAuthorization();
  const decide = (request: AuthorizationRequest) =>
    evaluateAuthorization(request, h.facts, h.deps);
  const scope = (request: Parameters<typeof evaluateQueryScope>[0]) =>
    evaluateQueryScope(request, h.facts, h.deps);
  return { ...h, decide, scope };
}

/** Purpose-bound restricted-data step-up made 30 s ago on this session. */
const restrictedStepUp = () =>
  staffEvidence({
    reauthentication: {
      at: ago(30),
      method: "PASSWORD_TOTP",
      purpose: "RESTRICTED_DATA_ACCESS",
    },
  });

const read = (
  permission: string,
  sensitivity: SensitivityLevel = "CONFIDENTIAL_PERSONNEL",
) =>
  ({
    principal: staffPrincipal,
    permission,
    operation: "READ",
    sensitivity,
  }) as const;

describe("scoped list/search authorization (query constraints)", () => {
  it("builds the union of current assignment scopes and excludes the actor's own file", async () => {
    const h = harness();
    h.assign("RECRUITER", "BRANCH", ids.BRANCH);
    h.assign("RECRUITER", "TEAM", ids.TEAM);
    const decision = await h.scope(read("candidate.read.assigned"));
    expect(decision).toMatchObject({
      decision: "ALLOW",
      effectiveRoleCodes: ["RECRUITER"],
      constraint: {
        kind: "SCOPES",
        excludeSubjectAccountId: ids.STAFF,
        scopes: expect.arrayContaining([
          { type: "BRANCH", organizationId: ids.ORG, branchId: ids.BRANCH },
          {
            type: "TEAM",
            organizationId: ids.ORG,
            branchId: ids.BRANCH,
            teamId: ids.TEAM,
          },
        ]),
      },
    });
  });

  it("binds candidate self-service lists to the server principal only", async () => {
    const h = harness();
    const decision = await h.scope({
      principal: candidatePrincipal,
      permission: "candidacy.own_status.read",
      operation: "READ",
      sensitivity: "INTERNAL",
    });
    expect(decision).toMatchObject({
      decision: "ALLOW",
      constraint: { kind: "OWNER", accountId: ids.CANDIDATE },
    });
  });

  it.each([
    [
      "candidate asks for a staff list",
      { ...read("candidate.read.assigned"), principal: candidatePrincipal },
      "PERMISSION_MISSING",
    ],
    [
      "staff without assignments",
      read("candidate.read.assigned"),
      "PERMISSION_MISSING",
    ],
    [
      "unknown permission",
      read("candidate.read.everything"),
      "PERMISSION_UNKNOWN",
    ],
    [
      "anonymous",
      { ...read("candidate.read.assigned"), principal: null },
      "UNAUTHENTICATED",
    ],
    [
      "restricted data on a confidential permission",
      read("candidate.read.assigned", "RESTRICTED_SCREENING_MEDICAL"),
      "SENSITIVITY_DENIED",
    ],
  ] as const)("denies: %s", async (_name, request, reason) => {
    const h = harness();
    expect(await h.scope(request)).toMatchObject({
      decision: "DENY",
      reasonCode: reason,
    });
  });

  it("rejects client-asserted roles, scopes, and fields in the request", async () => {
    const h = harness();
    h.assign("RECRUITER", "BRANCH", ids.BRANCH);
    for (const extra of [
      { roles: ["PSA_MANAGER"] },
      { scopes: [{ type: "ORGANIZATION", id: ids.ORG }] },
      { fields: ["taxIdentifier"] },
      { projection: "full" },
    ]) {
      expect(
        await h.scope({
          ...read("candidate.read.assigned"),
          ...extra,
        } as never),
      ).toMatchObject({ decision: "DENY", reasonCode: "INVALID_CONTEXT" });
    }
  });

  it("gives the system administrator no implicit business search authority", async () => {
    const h = harness();
    h.assign("SYSTEM_ADMINISTRATOR", "ORGANIZATION", ids.ORG);
    for (const permission of [
      "candidate.read.assigned",
      "application.read",
      "screening.result.read_restricted",
    ]) {
      const decision = await h.scope(read(permission));
      expect(decision.decision, permission).toBe("DENY");
    }
  });

  it("bounds auditors by assignment record groups, dates, and categories", async () => {
    const h = harness();
    h.assign("AUDITOR_READ_ONLY", "AUDIT_ASSIGNMENT", ids.AUDIT);
    expect(await h.scope(read("audit.read.assigned"))).toMatchObject({
      decision: "ALLOW",
      constraint: {
        scopes: [
          {
            type: "AUDIT_ASSIGNMENT",
            organizationId: ids.ORG,
            recordGroupIds: [ids.GROUP],
            recordsFrom: new Date("2026-01-01T00:00:00Z"),
            recordsTo: new Date("2026-07-01T00:00:00Z"),
          },
        ],
      },
    });
    // A category outside the assignment denies.
    expect(
      await h.scope(read("audit.read.assigned", "INTERNAL")),
    ).toMatchObject({
      decision: "DENY",
      reasonCode: "SCOPE_MISMATCH",
    });
  });

  it("never lets a participant-conditioned grant widen a list", async () => {
    const h = harness();
    h.assign("TRAINER_EVALUATOR", "BRANCH", ids.BRANCH);
    expect(
      await h.scope(read("interview.schedule.read", "INTERNAL")),
    ).toMatchObject({
      decision: "DENY",
      reasonCode: "CONDITION_UNMET",
    });
  });

  it("requires current recent authentication for restricted lists", async () => {
    const h = harness();
    h.assign("COMPLIANCE_REVIEWER", "BRANCH", ids.BRANCH);
    const request = {
      ...read(
        "screening.result.read_restricted",
        "RESTRICTED_SCREENING_MEDICAL",
      ),
      reasonCode: "COMPLIANCE_REVIEW",
    };
    // A restricted read needs a server-chosen purpose.
    expect(
      await h.scope(
        read(
          "screening.result.read_restricted",
          "RESTRICTED_SCREENING_MEDICAL",
        ),
      ),
    ).toMatchObject({ reasonCode: "INVALID_CONTEXT" });
    expect(await h.scope(request)).toMatchObject({
      decision: "DENY",
      reasonCode: "RECENT_AUTH_REQUIRED",
    });
    // A fresh sign-in is not purpose-bound: still required.
    h.facts.evidence.set(
      ids.SESSION,
      staffEvidence({
        primaryAuthenticatedAt: ago(30),
        mfaAuthenticatedAt: ago(30),
      }),
    );
    expect((await h.scope(request)).decision).toBe("DENY");
    h.facts.evidence.set(ids.SESSION, restrictedStepUp());
    expect((await h.scope(request)).decision).toBe("ALLOW");
  });

  it("denies immediately after the account is restricted or the session is gone", async () => {
    const h = harness();
    h.assign("RECRUITER", "BRANCH", ids.BRANCH);
    expect((await h.scope(read("candidate.read.assigned"))).decision).toBe(
      "ALLOW",
    );
    h.facts.evidence.delete(ids.SESSION);
    expect(await h.scope(read("candidate.read.assigned"))).toMatchObject({
      reasonCode: "UNAUTHENTICATED",
    });
    h.facts.evidence.set(ids.SESSION, staffEvidence());
    h.facts.accounts.set(ids.STAFF, {
      id: ids.STAFF,
      accountType: "STAFF",
      status: "LOCKED",
    });
    expect(await h.scope(read("candidate.read.assigned"))).toMatchObject({
      reasonCode: "ACCOUNT_INACTIVE",
    });
  });
});

describe("list query input", () => {
  const spec: ListQuerySpec = {
    maxPageSize: 50,
    defaultPageSize: 20,
    sorts: ["created_desc", "name_asc"],
    defaultSort: "created_desc",
    filters: {
      stage: (v) => typeof v === "string" && /^[A-Z_]{1,40}$/.test(v),
    },
    maxSearchLength: 64,
  };

  it("accepts bounded, allowlisted input with defaults", () => {
    expect(parseListQuery(undefined, spec)).toEqual({
      kind: "ACCEPTED",
      query: {
        pageSize: 20,
        cursor: null,
        sort: "created_desc",
        filters: {},
        search: null,
      },
    });
    expect(
      parseListQuery(
        {
          pageSize: 50,
          sort: "name_asc",
          filters: { stage: "INTERVIEW" },
          search: " TEST ",
        },
        spec,
      ),
    ).toMatchObject({ kind: "ACCEPTED", query: { search: "TEST" } });
  });

  it.each([
    [{ select: ["taxIdentifier"] }, "UNKNOWN_KEY"],
    [{ fields: "all" }, "UNKNOWN_KEY"],
    [{ include: { screening: true } }, "UNKNOWN_KEY"],
    [{ projection: "full" }, "UNKNOWN_KEY"],
    [{ scope: "ORGANIZATION" }, "UNKNOWN_KEY"],
    [{ permission: "candidate.read.assigned" }, "UNKNOWN_KEY"],
    [{ pageSize: 0 }, "INVALID_PAGE_SIZE"],
    [{ pageSize: 51 }, "INVALID_PAGE_SIZE"],
    [{ pageSize: 10.5 }, "INVALID_PAGE_SIZE"],
    [{ pageSize: "10" }, "INVALID_PAGE_SIZE"],
    [{ sort: "ssn_asc" }, "UNKNOWN_SORT"],
    [{ filters: { ssn: "123" } }, "UNKNOWN_FILTER"],
    [{ filters: { stage: "x OR 1=1" } }, "INVALID_FILTER"],
    [{ filters: [] }, "UNKNOWN_FILTER"],
    [{ search: "x".repeat(65) }, "SEARCH_TOO_LONG"],
    [{ search: "a\u0000b" }, "SEARCH_TOO_LONG"],
    [{ cursor: "../../etc" }, "INVALID_CURSOR"],
    [[], "UNKNOWN_KEY"],
  ] as const)(
    "rejects %j (%s), never falling back to a broad query",
    (input, reason) => {
      expect(parseListQuery(input, spec)).toEqual({ kind: "REJECTED", reason });
    },
  );
});

describe("scope selector narrows only", () => {
  const constraint = {
    kind: "SCOPES",
    excludeSubjectAccountId: ids.STAFF,
    scopes: [
      { type: "BRANCH", organizationId: ids.ORG, branchId: ids.BRANCH },
      {
        type: "TEAM",
        organizationId: ids.ORG,
        branchId: ids.BRANCH,
        teamId: ids.TEAM,
      },
    ],
  } as const;

  it("intersects with a selected current scope", () => {
    expect(
      narrowConstraint(constraint, { type: "TEAM", id: ids.TEAM }),
    ).toEqual({
      ...constraint,
      scopes: [constraint.scopes[1]],
    });
    expect(narrowConstraint(constraint, null)).toBe(constraint);
  });

  it("never widens to a scope the principal does not hold", () => {
    expect(
      narrowConstraint(constraint, { type: "ORGANIZATION", id: ids.ORG }),
    ).toBeNull();
    expect(
      narrowConstraint(constraint, { type: "BRANCH", id: ids.BRANCH2 }),
    ).toBeNull();
    expect(
      narrowConstraint(
        { kind: "OWNER", accountId: ids.CANDIDATE },
        { type: "BRANCH", id: ids.BRANCH },
      ),
    ).toBeNull();
  });
});

describe("object authorization envelope and existence protection", () => {
  const envelope = (
    overrides: Partial<ResourceEnvelope> = {},
  ): ResourceEnvelope => ({
    id: ids.RECORD,
    resourceType: "TEST_RECORD",
    sensitivity: "CONFIDENTIAL_PERSONNEL",
    hidden: false,
    version: 1,
    ...overrides,
  });
  const source = (rows: ResourceEnvelope[]) => ({
    loadEnvelope: async (id: string) => rows.find((r) => r.id === id) ?? null,
  });
  const request = (
    resourceId: unknown,
    principal = staffPrincipal as
      typeof staffPrincipal | typeof candidatePrincipal,
  ) => ({
    principal,
    resourceId,
    resourceType: "TEST_RECORD",
    permission: "candidate.read.assigned",
    operation: "READ" as const,
  });

  it("authorizes an in-scope record by its minimal envelope", async () => {
    const h = harness();
    h.assign("RECRUITER", "BRANCH", ids.BRANCH);
    expect(
      await authorizeEnvelopeAccess(
        request(ids.RECORD),
        source([envelope()]),
        h.decide,
      ),
    ).toMatchObject({ kind: "AUTHORIZED", envelope: { id: ids.RECORD } });
  });

  it("makes invalid, unknown, wrong-type, hidden, wrong-scope, and foreign IDs indistinguishable", async () => {
    const h = harness();
    h.assign("RECRUITER", "BRANCH", ids.BRANCH);
    const rows = [
      envelope(),
      envelope({ id: ids.RECORD_BRANCH2 }),
      envelope({ id: ids.RECORD_ORG2, resourceType: "OTHER" }),
      envelope({ id: sid(77), hidden: true }),
    ];
    const outcomes = await Promise.all(
      [
        "not-a-uuid",
        sid(999),
        ids.RECORD_ORG2,
        sid(77),
        ids.RECORD_BRANCH2,
        `${ids.RECORD}'--`,
      ].map(async (id) => {
        const result = await authorizeEnvelopeAccess(
          request(id),
          source(rows),
          h.decide,
        );
        expect(result.kind).toBe("NOT_FOUND");
        return result.kind === "NOT_FOUND"
          ? outcomeForDenial({ reasonCode: "SCOPE_MISMATCH" }, "UNKNOWN")
          : null;
      }),
    );
    expect(new Set(outcomes.map((o) => JSON.stringify(o)))).toEqual(
      new Set([JSON.stringify({ kind: "NOT_FOUND" })]),
    );
  });

  it("Candidate A cannot reach Candidate B's record or learn that it exists", async () => {
    const h = harness();
    const ownRequest = {
      ...request(ids.RECORD, candidatePrincipal),
      permission: "candidacy.own_status.read",
    };
    const otherRequest = {
      ...request(ids.RECORD_BRANCH2, candidatePrincipal),
      permission: "candidacy.own_status.read",
    };
    const rows = [
      envelope({ sensitivity: "INTERNAL" }),
      envelope({ id: ids.RECORD_BRANCH2, sensitivity: "INTERNAL" }),
    ];
    expect(
      (await authorizeEnvelopeAccess(ownRequest, source(rows), h.decide)).kind,
    ).toBe("AUTHORIZED");
    const foreign = await authorizeEnvelopeAccess(
      otherRequest,
      source(rows),
      h.decide,
    );
    const unknown = await authorizeEnvelopeAccess(
      { ...otherRequest, resourceId: sid(12345) },
      source(rows),
      h.decide,
    );
    expect(foreign.kind).toBe("NOT_FOUND");
    expect(unknown.kind).toBe("NOT_FOUND");
  });

  it("asks an anonymous caller to sign in without loading anything", async () => {
    let loaded = false;
    const result = await authorizeEnvelopeAccess(
      { ...request(ids.RECORD), principal: null as never },
      { loadEnvelope: async () => ((loaded = true), envelope()) },
      harness().decide,
    );
    expect(result).toEqual({ kind: "UNAUTHENTICATED" });
    expect(loaded).toBe(false);
  });

  it("view authority never grants edit, approve, download, or export", async () => {
    const h = harness();
    h.assign("RECRUITER", "BRANCH", ids.BRANCH);
    const base = {
      principal: staffPrincipal,
      resource: {
        kind: "RECORD",
        id: ids.RECORD,
        sensitivity: "CONFIDENTIAL_PERSONNEL",
      },
    } as const;
    expect(
      (
        await h.decide({
          ...base,
          permission: "candidate.read.assigned",
          operation: "READ",
        })
      ).decision,
    ).toBe("ALLOW");
    for (const [permission, operation] of [
      ["candidate.profile.edit", "EDIT"],
      ["offer.approve", "APPROVE"],
      ["identity_document.download", "DOWNLOAD"],
      ["record.export.restricted", "EXPORT"],
      ["role_assignment.approve", "ADMINISTER"],
    ] as const) {
      expect(
        (await h.decide({ ...base, permission, operation })).decision,
        permission,
      ).toBe("DENY");
    }
  });
});

describe("document access gate", () => {
  const doc = (
    overrides: Partial<DocumentEnvelope> = {},
  ): DocumentEnvelope => ({
    id: sid(500),
    category: "TEST_MEDICAL",
    parentRecordId: ids.RECORD,
    sensitivity: "RESTRICTED_SCREENING_MEDICAL",
    audience: "RESTRICTED_REVIEW",
    scanState: "CLEAN",
    hidden: false,
    ...overrides,
  });
  const registry = {
    TEST_MEDICAL: {
      METADATA: {
        permission: "medical_document.read_restricted",
        operation: "READ",
      },
      PREVIEW: {
        permission: "medical_document.read_restricted",
        operation: "READ",
      },
      DOWNLOAD: {
        permission: "medical_document.download",
        operation: "DOWNLOAD",
      },
    },
  } as const;
  function gate(
    h: ReturnType<typeof harness>,
    documents: DocumentEnvelope[],
    reg: typeof registry | typeof productionDocumentPermissions = registry,
  ) {
    return (
      documentId: unknown,
      action: "METADATA" | "PREVIEW" | "DOWNLOAD" | "PRINT" | "EXPORT",
    ) =>
      authorizeDocumentAccess(
        {
          principal: staffPrincipal,
          documentId,
          action,
          purposeCode: "COMPLIANCE_REVIEW",
        },
        {
          source: {
            loadDocumentEnvelope: async (id) =>
              documents.find((d) => d.id === id) ?? null,
          },
          registry: reg,
          authorize: h.decide,
          events: h.deps.events,
          clock: () => NOW,
        },
      );
  }
  const fresh = restrictedStepUp;

  it("denies everything with the empty production registry", async () => {
    const h = harness();
    h.assign("COMPLIANCE_REVIEWER", "BRANCH", ids.BRANCH);
    h.facts.evidence.set(ids.SESSION, fresh());
    expect(
      await gate(
        h,
        [doc()],
        productionDocumentPermissions,
      )(sid(500), "DOWNLOAD"),
    ).toEqual({
      kind: "NOT_FOUND",
    });
  });

  it("issues a short-lived grant without any storage key only after current authorization", async () => {
    const h = harness();
    h.assign("COMPLIANCE_REVIEWER", "BRANCH", ids.BRANCH);
    h.facts.evidence.set(ids.SESSION, fresh());
    const result = await gate(h, [doc()])(sid(500), "DOWNLOAD");
    expect(result).toEqual({
      kind: "AUTHORIZED",
      grant: {
        documentId: sid(500),
        action: "DOWNLOAD",
        expiresAt: new Date(NOW.getTime() + 60_000),
      },
    });
    expect(h.events.map((e) => e.code)).toEqual([
      "authz.restricted_access_allowed",
    ]);
    // M1.6 (ADR-0012): the durable restricted-access event names the
    // document only as its opaque audit target; no other field carries it.
    const [event] = h.events;
    expect(event.recordRef).toBe(sid(500));
    expect(JSON.stringify({ ...event, recordRef: undefined })).not.toContain(
      sid(500),
    );
  });

  it("requires recent authentication for restricted documents", async () => {
    const h = harness();
    h.assign("COMPLIANCE_REVIEWER", "BRANCH", ids.BRANCH);
    expect(await gate(h, [doc()])(sid(500), "PREVIEW")).toEqual({
      kind: "REAUTHENTICATION_REQUIRED",
    });
    // Reported once, by the M1.4 service (no duplicate denial event).
    expect(h.events.map((e) => e.code)).toEqual(["authz.high_risk_denied"]);
  });

  it("separates view from download, print, and export", async () => {
    const h = harness();
    h.assign("AUDITOR_READ_ONLY", "AUDIT_ASSIGNMENT", ids.AUDIT);
    h.facts.evidence.set(ids.SESSION, fresh());
    const check = gate(h, [doc({ sensitivity: "CONFIDENTIAL_PERSONNEL" })], {
      TEST_MEDICAL: {
        METADATA: { permission: "audit.read.assigned", operation: "READ" },
        DOWNLOAD: {
          permission: "medical_document.download",
          operation: "DOWNLOAD",
        },
      },
    } as never);
    expect((await check(sid(500), "METADATA")).kind).toBe("AUTHORIZED");
    for (const action of ["DOWNLOAD", "PRINT", "EXPORT"] as const) {
      expect((await check(sid(500), action)).kind, action).toBe("NOT_FOUND");
    }
  });

  it("never treats storage keys, URLs, filenames, or wrong-scope IDs as authority", async () => {
    const h = harness();
    h.assign("COMPLIANCE_REVIEWER", "BRANCH", ids.BRANCH2);
    h.facts.evidence.set(ids.SESSION, fresh());
    const check = gate(h, [doc()]);
    for (const id of [
      "documents/2026/TEST.pdf",
      "https://storage.example.test/bucket/obj?sig=TESTCANARY",
      "../../etc/passwd",
      sid(501),
      sid(500), // exists, but the reviewer's scope is another branch
    ]) {
      expect(await check(id, "DOWNLOAD")).toEqual({ kind: "NOT_FOUND" });
    }
  });

  it("keeps unscanned or quarantined files unavailable, and hidden ones not found", async () => {
    const h = harness();
    h.assign("COMPLIANCE_REVIEWER", "BRANCH", ids.BRANCH);
    h.facts.evidence.set(ids.SESSION, fresh());
    expect(
      await gate(h, [doc({ scanState: "PENDING" })])(sid(500), "DOWNLOAD"),
    ).toEqual({
      kind: "UNAVAILABLE",
    });
    expect(
      await gate(h, [doc({ scanState: "QUARANTINED" })])(sid(500), "PREVIEW"),
    ).toEqual({
      kind: "UNAVAILABLE",
    });
    expect(
      await gate(h, [doc({ hidden: true })])(sid(500), "METADATA"),
    ).toEqual({
      kind: "NOT_FOUND",
    });
  });
});

describe("jobs, service principals, and provider callbacks", () => {
  const service = {
    kind: "SERVICE",
    serviceCode: "TEST_OUTBOX",
    purpose: "NOTIFY",
  } as const;

  it("denies every service operation with the empty production registry", async () => {
    expect(
      await authorizeServiceOperation(service, "notification.send", {
        grants: productionServiceGrants,
        isRevoked: async () => false,
      }),
    ).toEqual({ decision: "DENY", reasonCode: "UNKNOWN_SERVICE" });
  });

  it("binds purpose and rechecks revocation before protected work", async () => {
    const grants = [
      {
        serviceCode: "TEST_OUTBOX",
        purpose: "NOTIFY",
        operation: "notification.send",
      },
    ];
    let revoked = false;
    const deps = { grants, isRevoked: async () => revoked };
    expect(
      (await authorizeServiceOperation(service, "notification.send", deps))
        .decision,
    ).toBe("ALLOW");
    expect(
      await authorizeServiceOperation(
        { ...service, purpose: "EXPORT" },
        "notification.send",
        deps,
      ),
    ).toMatchObject({ reasonCode: "PURPOSE_MISMATCH" });
    revoked = true;
    expect(
      await authorizeServiceOperation(service, "notification.send", deps),
    ).toMatchObject({
      reasonCode: "REVOKED",
    });
  });

  it("rejects job payloads that try to carry authority or field selection", () => {
    const spec = {
      references: ["candidacyId"],
      codes: { template: ["REMINDER"] },
    };
    expect(
      parseJobPayload({ candidacyId: ids.RECORD, template: "REMINDER" }, spec),
    ).toEqual({
      kind: "ACCEPTED",
      values: { candidacyId: ids.RECORD, template: "REMINDER" },
    });
    for (const [payload, reason] of [
      [{ candidacyId: ids.RECORD, actorRole: "PSA_MANAGER" }, "FORBIDDEN_KEY"],
      [{ candidacyId: ids.RECORD, onBehalfOf: ids.STAFF }, "FORBIDDEN_KEY"],
      [{ candidacyId: ids.RECORD, Scopes: ["ORG"] }, "FORBIDDEN_KEY"],
      [{ candidacyId: ids.RECORD, fields: ["ssn"] }, "FORBIDDEN_KEY"],
      [{ candidacyId: ids.RECORD, note: "x" }, "UNKNOWN_KEY"],
      [{ candidacyId: "1 OR 1=1" }, "INVALID_VALUE"],
      [{ template: "EXPORT_ALL" }, "INVALID_VALUE"],
      [[ids.RECORD], "NOT_AN_OBJECT"],
    ] as const) {
      expect(parseJobPayload(payload, spec)).toMatchObject({
        kind: "REJECTED",
        reason,
      });
    }
  });

  it("authenticates the provider independently, then authorizes the affected operation", async () => {
    const spec = { references: ["orderId"] };
    const request = new Request("http://127.0.0.1:3100/api/test-provider", {
      method: "POST",
    });
    const authenticator = (ok: boolean) => ({
      authenticate: async () =>
        ok ? { providerCode: "TEST_PROVIDER", eventId: "evt-1" } : null,
    });
    expect(
      await authorizeProviderCallback(
        request,
        { orderId: ids.RECORD },
        spec,
        authenticator(false),
        async () => "ALLOW",
      ),
    ).toEqual({ kind: "UNAUTHENTICATED" });
    expect(
      await authorizeProviderCallback(
        request,
        { orderId: ids.RECORD },
        spec,
        authenticator(true),
        async () => "DENY",
      ),
    ).toEqual({ kind: "REJECTED" });
    expect(
      await authorizeProviderCallback(
        request,
        { orderId: ids.RECORD, role: "ADMIN" },
        spec,
        authenticator(true),
        async () => "ALLOW",
      ),
    ).toEqual({ kind: "REJECTED" });
    expect(
      await authorizeProviderCallback(
        request,
        { orderId: ids.RECORD },
        spec,
        authenticator(true),
        async () => "ALLOW",
      ),
    ).toEqual({ kind: "ACCEPTED", values: { orderId: ids.RECORD } });
  });
});

describe("field authorization through real M1.4 decisions", () => {
  type Source = {
    displayName: string;
    screeningResult: string | null;
    screeningStatus: string;
  };
  const screening: FieldRule = {
    sensitivity: "RESTRICTED_SCREENING_MEDICAL",
    includeWith: "screening.result.read_restricted",
    statusWith: "screening.status.read",
    otherwise: "OMIT",
  };
  const contract = defineProjection<
    Source,
    { displayName: string; screening?: string }
  >({
    name: "test.candidate_review.v1",
    audience: "STAFF",
    purpose: "REVIEW",
    fields: {
      displayName: {
        rule: { sensitivity: "CONFIDENTIAL_PERSONNEL", otherwise: "INCLUDE" },
        value: (s) => s.displayName,
      },
      screening: {
        rule: screening,
        value: (s) => s.screeningResult ?? "",
        status: (s) => s.screeningStatus,
      },
    },
    schema: z.strictObject({
      displayName: z.string(),
      screening: z.string().optional(),
    }),
  });
  const source: Source = {
    displayName: "TEST Person",
    screeningResult: "TESTCANARY-report",
    screeningStatus: "CLEAR",
  };
  const request = {
    principal: staffPrincipal,
    audience: "STAFF",
    resource: { id: ids.RECORD, sensitivity: "CONFIDENTIAL_PERSONNEL" },
    purposeCode: "COMPLIANCE_REVIEW",
  } as const;

  it("gives a recruiter status only, a fresh compliance reviewer the value", async () => {
    const recruiter = harness();
    recruiter.assign("RECRUITER", "BRANCH", ids.BRANCH);
    expect(
      await projectAuthorized(contract, source, request, recruiter.decide),
    ).toEqual({
      kind: "PROJECTED",
      value: { displayName: "TEST Person", screening: "CLEAR" },
    });

    const reviewer = harness();
    reviewer.assign("COMPLIANCE_REVIEWER", "BRANCH", ids.BRANCH);
    // Without recent authentication the restricted value is omitted.
    expect(
      await projectAuthorized(contract, source, request, reviewer.decide),
    ).toEqual({
      kind: "PROJECTED",
      value: { displayName: "TEST Person" },
    });
    reviewer.facts.evidence.set(ids.SESSION, restrictedStepUp());
    expect(
      await projectAuthorized(contract, source, request, reviewer.decide),
    ).toEqual({
      kind: "PROJECTED",
      value: { displayName: "TEST Person", screening: "TESTCANARY-report" },
    });
  });

  it("gives a wrong-scope reviewer nothing restricted", async () => {
    const h = harness();
    h.assign("COMPLIANCE_REVIEWER", "BRANCH", ids.BRANCH2);
    h.facts.evidence.set(ids.SESSION, restrictedStepUp());
    const result = await projectAuthorized(contract, source, request, h.decide);
    expect(JSON.stringify(result)).not.toContain("TESTCANARY");
  });
});

describe("denial and error mapping", () => {
  it("maps every M1.4 denial reason without disclosing it", () => {
    for (const reason of denialReasons) {
      const unknown = outcomeForDenial({ reasonCode: reason }, "UNKNOWN");
      const known = outcomeForDenial({ reasonCode: reason }, "KNOWN");
      if (reason === "UNAUTHENTICATED" || reason === "ACCOUNT_INACTIVE") {
        expect(unknown).toEqual({ kind: "AUTHENTICATION_REQUIRED" });
        expect(known).toEqual({ kind: "AUTHENTICATION_REQUIRED" });
      } else {
        expect(unknown, reason).toEqual({ kind: "NOT_FOUND" });
        expect(known, reason).toEqual(
          reason === "RECENT_AUTH_REQUIRED"
            ? { kind: "REAUTHENTICATION_REQUIRED" }
            : { kind: "FORBIDDEN" },
        );
      }
      for (const outcome of [unknown, known]) {
        expect(Object.keys(outcome)).toEqual(["kind"]);
      }
    }
  });

  it("maps application result kinds and public codes consistently", () => {
    expect(outcomeForResult("UNAUTHENTICATED")).toEqual({
      kind: "AUTHENTICATION_REQUIRED",
    });
    expect(outcomeForResult("NOT_PERMITTED")).toEqual(
      outcomeForResult("NOT_FOUND"),
    );
    expect(publicCodeForOutcome({ kind: "AUTHENTICATION_REQUIRED" })).toBe(
      "UNAUTHENTICATED",
    );
    expect(publicCodeForOutcome({ kind: "NOT_FOUND" })).toBe("NOT_FOUND");
    expect(publicCodeForOutcome({ kind: "FORBIDDEN" })).toBe("FORBIDDEN");
    expect(publicCodeForOutcome({ kind: "REAUTHENTICATION_REQUIRED" })).toBe(
      "REAUTHENTICATION_REQUIRED",
    );
    expect(publicCodeForOutcome({ kind: "INVALID_INPUT" })).toBe(
      "VALIDATION_FAILED",
    );
    expect(publicCodeForOutcome({ kind: "CONFLICT" })).toBe("CONFLICT");
    expect(publicCodeForOutcome({ kind: "RATE_LIMITED" })).toBe("RATE_LIMITED");
    expect(publicCodeForOutcome({ kind: "SYSTEM_ERROR" })).toBe(
      "INTERNAL_ERROR",
    );
  });
});

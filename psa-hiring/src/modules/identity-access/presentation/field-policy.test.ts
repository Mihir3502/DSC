import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineProjection, project, projectAll } from "./authorized-projector";
import {
  evaluateFieldRule,
  fieldOutcomes,
  findNeverReturnKeys,
  isValidFieldRule,
  neverReturnKeys,
  permissionsReferenced,
  type FieldPolicyContext,
  type FieldRule,
} from "./field-policy";
import {
  candidateSecurityContract,
  staffSecurityContract,
  type CandidateSecuritySource,
  type StaffSecuritySource,
} from "./security-view-models";

// Field-level authorization and exact projections (packet M1.5 §12,
// AC-M1.5-06). Synthetic resources and canary values only.

const CANARY = {
  ssn: "TESTCANARY-999-00-1234",
  email: "test.person.canary@example.test",
  userAgent:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) TESTCANARY-UA Chrome/140.0 Safari/537.36",
  sessionId: "00000000-0000-4000-8000-00000000abcd",
  token: "TESTCANARY-session-token-0f3a",
};

const staffCtx = (allowed: string[] = []): FieldPolicyContext => ({
  audience: "STAFF",
  purpose: "DETAIL",
  allowed: new Set(allowed),
});

// A synthetic restricted-field resource for the policy matrix only.
type PersonSource = Readonly<{
  id: string;
  displayName: string;
  taxIdentifier: string | null;
  screeningResult: string | null;
  screeningStatus: "PENDING" | "CLEAR" | "REVIEW";
  internalNote: string;
  // Present on the source but in no contract: must never reach output.
  passwordHash: string;
}>;

const taxRule: FieldRule = {
  sensitivity: "RESTRICTED_IDENTITY_FINANCIAL",
  includeWith: "identity_document.read_restricted",
  maskWith: "identity_document.read_masked",
  otherwise: "OMIT",
};
const screeningRule: FieldRule = {
  sensitivity: "RESTRICTED_SCREENING_MEDICAL",
  includeWith: "screening.result.read_restricted",
  statusWith: "screening.status.read",
  otherwise: "OMIT",
};

const personSchema = z.strictObject({
  displayName: z.string(),
  taxIdentifier: z.string().optional(),
  screening: z.string().optional(),
});
type PersonView = z.infer<typeof personSchema>;

const personContract = defineProjection<PersonSource, PersonView>({
  name: "test.person_detail.v1",
  audience: "STAFF",
  purpose: "DETAIL",
  fields: {
    displayName: {
      rule: { sensitivity: "CONFIDENTIAL_PERSONNEL", otherwise: "INCLUDE" },
      value: (s) => s.displayName,
    },
    taxIdentifier: {
      rule: taxRule,
      value: (s) => s.taxIdentifier ?? "",
      // Constant shape whether or not a value exists.
      mask: (s) => `•••-••-${(s.taxIdentifier ?? "").slice(-4) || "••••"}`,
    },
    screening: {
      rule: screeningRule,
      value: (s) => s.screeningResult ?? "",
      status: (s) => s.screeningStatus,
    },
  },
  schema: personSchema,
});

const person: PersonSource = {
  id: "00000000-0000-4000-8000-000000000001",
  displayName: "TEST Person",
  taxIdentifier: CANARY.ssn,
  screeningResult: "TESTCANARY-report-contents",
  screeningStatus: "CLEAR",
  internalNote: "TESTCANARY-internal-note",
  passwordHash: "TESTCANARY-hash",
};

describe("field rules", () => {
  it("covers the closed outcome vocabulary", () => {
    expect(fieldOutcomes).toEqual([
      "INCLUDE",
      "MASK",
      "STATUS_ONLY",
      "OMIT",
      "DENY_RESOURCE",
    ]);
  });

  it("includes, masks, gives status, or omits from allowed permissions only", () => {
    expect(
      evaluateFieldRule(
        taxRule,
        staffCtx(["identity_document.read_restricted"]),
      ),
    ).toBe("INCLUDE");
    expect(
      evaluateFieldRule(taxRule, staffCtx(["identity_document.read_masked"])),
    ).toBe("MASK");
    expect(evaluateFieldRule(taxRule, staffCtx())).toBe("OMIT");
    expect(
      evaluateFieldRule(screeningRule, staffCtx(["screening.status.read"])),
    ).toBe("STATUS_ONLY");
    expect(
      evaluateFieldRule(screeningRule, staffCtx(["candidate.read.assigned"])),
    ).toBe("OMIT");
  });

  it("denies the resource for malformed, unknown, or unsafe rules (never includes)", () => {
    for (const rule of [
      null,
      {},
      { sensitivity: "SECRET", otherwise: "INCLUDE" },
      { sensitivity: "INTERNAL", otherwise: "SHOW" },
      { sensitivity: "INTERNAL", otherwise: "INCLUDE", extra: 1 },
      // Restricted data cannot be included without a permission.
      { sensitivity: "RESTRICTED_SCREENING_MEDICAL", otherwise: "INCLUDE" },
    ]) {
      expect(isValidFieldRule(rule)).toBe(false);
      expect(evaluateFieldRule(rule, staffCtx(["x"]))).toBe("DENY_RESOURCE");
    }
  });

  it("lists the permissions a contract may consult, without duplicates", () => {
    expect(permissionsReferenced([taxRule, screeningRule, taxRule])).toEqual([
      "identity_document.read_masked",
      "identity_document.read_restricted",
      "screening.result.read_restricted",
      "screening.status.read",
    ]);
  });
});

describe("authorized projector", () => {
  it("returns full values only with the full-value permission", () => {
    const full = project(
      personContract,
      person,
      staffCtx([
        "identity_document.read_restricted",
        "screening.result.read_restricted",
      ]),
    );
    expect(full).toEqual({
      kind: "PROJECTED",
      value: {
        displayName: "TEST Person",
        taxIdentifier: CANARY.ssn,
        screening: "TESTCANARY-report-contents",
      },
    });
  });

  it("masks and status-limits restricted values for narrower permissions", () => {
    const narrow = project(
      personContract,
      person,
      staffCtx(["identity_document.read_masked", "screening.status.read"]),
    );
    expect(narrow).toEqual({
      kind: "PROJECTED",
      value: {
        displayName: "TEST Person",
        taxIdentifier: "•••-••-1234",
        screening: "CLEAR",
      },
    });
    expect(JSON.stringify(narrow)).not.toContain("999-00");
    expect(JSON.stringify(narrow)).not.toContain("report-contents");
  });

  it("omits restricted keys entirely without a field permission, whether or not a value exists", () => {
    const withValue = project(personContract, person, staffCtx());
    const withoutValue = project(
      personContract,
      { ...person, taxIdentifier: null, screeningResult: null },
      staffCtx(),
    );
    expect(withValue).toEqual({
      kind: "PROJECTED",
      value: { displayName: "TEST Person" },
    });
    expect(withoutValue).toEqual(withValue);
  });

  it("never copies unnamed source properties (no spread, no rest)", () => {
    const result = project(
      personContract,
      person,
      staffCtx(["identity_document.read_restricted"]),
    );
    const text = JSON.stringify(result);
    for (const leaked of ["internal-note", "TESTCANARY-hash", person.id]) {
      expect(text).not.toContain(leaked);
    }
  });

  it("refuses the wrong audience or purpose (candidate and staff contracts differ)", () => {
    expect(
      project(personContract, person, { ...staffCtx(), audience: "CANDIDATE" }),
    ).toEqual({ kind: "REFUSED", reason: "AUDIENCE_MISMATCH" });
    expect(
      project(personContract, person, { ...staffCtx(), purpose: "LIST" }),
    ).toEqual({
      kind: "REFUSED",
      reason: "PURPOSE_MISMATCH",
    });
  });

  it("denies the whole resource when a field rule says DENY_RESOURCE", () => {
    const contract = defineProjection<PersonSource, { displayName: string }>({
      name: "test.deny.v1",
      audience: "STAFF",
      purpose: "DETAIL",
      fields: {
        displayName: {
          rule: {
            sensitivity: "RESTRICTED_SCREENING_MEDICAL",
            otherwise: "DENY_RESOURCE",
          },
        },
      },
      schema: z.strictObject({ displayName: z.string() }),
    });
    expect(project(contract, person, staffCtx())).toEqual({
      kind: "REFUSED",
      reason: "FIELD_DENIED",
    });
  });

  it("fails closed when the output does not match the exact schema", () => {
    const contract = defineProjection<PersonSource, { displayName: string }>({
      name: "test.schema.v1",
      audience: "STAFF",
      purpose: "DETAIL",
      fields: {
        displayName: {
          rule: { sensitivity: "INTERNAL", otherwise: "INCLUDE" },
          value: (s) => s.displayName,
        },
      },
      // An introduced unknown key (or wrong type) is rejected.
      schema: z.strictObject({ displayName: z.number() }) as never,
    });
    expect(project(contract, person, staffCtx())).toEqual({
      kind: "REFUSED",
      reason: "SCHEMA_MISMATCH",
    });
  });

  it("refuses an output carrying a never-return key at any depth", () => {
    const contract = defineProjection<PersonSource, { nested: unknown }>({
      name: "test.nested.v1",
      audience: "STAFF",
      purpose: "DETAIL",
      fields: {
        nested: {
          rule: { sensitivity: "INTERNAL", otherwise: "INCLUDE" },
          value: () => ({ list: [{ token: CANARY.token }] }),
        },
      },
      schema: z.strictObject({ nested: z.unknown() }),
    });
    expect(project(contract, person, staffCtx())).toEqual({
      kind: "REFUSED",
      reason: "NEVER_RETURN_FIELD",
    });
  });

  it("rejects contracts that name never-return fields or lack an outcome function", () => {
    for (const key of [
      "password",
      "token",
      "sessionId",
      "backupCodes",
      "totpSecret",
    ]) {
      expect(() =>
        defineProjection<PersonSource, Record<string, string>>({
          name: "test.bad.v1",
          audience: "STAFF",
          purpose: "DETAIL",
          fields: {
            [key]: {
              rule: { sensitivity: "INTERNAL", otherwise: "INCLUDE" },
              value: () => "x",
            },
          },
          schema: z.strictObject({}) as never,
        }),
      ).toThrow(/never-return/);
    }
    expect(() =>
      defineProjection<PersonSource, { a: string }>({
        name: "test.missing.v1",
        audience: "STAFF",
        purpose: "DETAIL",
        fields: { a: { rule: taxRule, value: () => "x" } },
        schema: z.strictObject({ a: z.string() }),
      }),
    ).toThrow(/missing field function/);
  });

  it("projects lists with the same contract, refusing the list if any row is refused", () => {
    expect(
      projectAll(personContract, [person, person], staffCtx()),
    ).toMatchObject({
      kind: "PROJECTED",
      value: [{ displayName: "TEST Person" }, { displayName: "TEST Person" }],
    });
    expect(
      projectAll(personContract, [person], {
        ...staffCtx(),
        audience: "CANDIDATE",
      }),
    ).toEqual({ kind: "REFUSED", reason: "AUDIENCE_MISMATCH" });
  });

  it("finds never-return keys case-insensitively and reports names only", () => {
    expect(
      findNeverReturnKeys({ a: [{ SessionToken: "x" }], b: new Date() }),
    ).toEqual(["SessionToken"]);
    expect(findNeverReturnKeys({ code: "NOT_FOUND", ref: "abc" })).toEqual([]);
    expect(neverReturnKeys).toEqual(
      expect.arrayContaining(["password", "secret", "ipAddress"]),
    );
  });
});

describe("current M1 security view models", () => {
  const sessions = [
    {
      ref: "A".repeat(32),
      current: true,
      userAgent: CANARY.userAgent,
      createdAt: new Date("2026-10-06T10:00:00Z"),
      updatedAt: new Date("2026-10-06T11:00:00Z"),
      expiresAt: new Date("2026-10-13T10:00:00Z"),
    },
  ];
  const candidateSource: CandidateSecuritySource = {
    email: CANARY.email,
    emailVerified: true,
    sessions,
  };
  const staffSource: StaffSecuritySource = {
    email: CANARY.email,
    signedInWith: "PASSWORD_TOTP",
    recent: true,
    strong: false,
    recentAt: new Date("2026-10-06T11:59:00Z"),
    windowSeconds: 300,
    sessions,
  };
  const ctx = (audience: "CANDIDATE" | "STAFF"): FieldPolicyContext => ({
    audience,
    purpose: "SECURITY",
    allowed: new Set(),
  });

  it("projects the exact candidate account-security contract", () => {
    const result = project(
      candidateSecurityContract,
      candidateSource,
      ctx("CANDIDATE"),
    );
    expect(result.kind).toBe("PROJECTED");
    if (result.kind !== "PROJECTED") return;
    expect(Object.keys(result.value).sort()).toEqual([
      "emailVerified",
      "maskedEmail",
      "sessions",
    ]);
    expect(result.value.maskedEmail).toBe("t•••@example.test");
    expect(Object.keys(result.value.sessions[0]).sort()).toEqual([
      "createdAt",
      "current",
      "deviceLabel",
      "expiresAt",
      "lastActiveAt",
      "ref",
    ]);
    expect(result.value.sessions[0].deviceLabel).toBe("Chrome on macOS");
    const text = JSON.stringify(result);
    for (const secret of [
      CANARY.email,
      "TESTCANARY-UA",
      CANARY.sessionId,
      CANARY.token,
    ]) {
      expect(text).not.toContain(secret);
    }
  });

  it("projects the exact staff account-security contract", () => {
    const result = project(staffSecurityContract, staffSource, ctx("STAFF"));
    expect(result.kind).toBe("PROJECTED");
    if (result.kind !== "PROJECTED") return;
    expect(Object.keys(result.value).sort()).toEqual([
      "maskedEmail",
      "mfaMethod",
      "recentAuthentication",
      "sessions",
      "signedInWith",
    ]);
    expect(result.value.recentAuthentication).toEqual({
      recent: true,
      strong: false,
      at: new Date("2026-10-06T11:59:00Z"),
      windowSeconds: 300,
    });
    expect(JSON.stringify(result)).not.toMatch(
      /role|scope|branch|permission|token|TESTCANARY/i,
    );
  });

  it("never serves one audience's contract to the other", () => {
    expect(
      project(candidateSecurityContract, candidateSource, ctx("STAFF")).kind,
    ).toBe("REFUSED");
    expect(
      project(staffSecurityContract, staffSource, ctx("CANDIDATE")).kind,
    ).toBe("REFUSED");
  });

  it("refuses a malformed opaque session reference instead of returning it", () => {
    const bad = {
      ...candidateSource,
      sessions: [{ ...sessions[0], ref: CANARY.sessionId }],
    };
    expect(project(candidateSecurityContract, bad, ctx("CANDIDATE"))).toEqual({
      kind: "REFUSED",
      reason: "SCHEMA_MISMATCH",
    });
  });

  it("hides the recent-auth time when the session is not recent", () => {
    const result = project(
      staffSecurityContract,
      { ...staffSource, recent: false },
      ctx("STAFF"),
    );
    expect(
      result.kind === "PROJECTED" && result.value.recentAuthentication.at,
    ).toBeNull();
  });
});

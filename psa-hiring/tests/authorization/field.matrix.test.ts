import { describe, expect, it } from "vitest";
import { z } from "zod";
import { authorizeFields } from "@/modules/identity-access/application/authorize-fields";
import type { RoleCode } from "@/modules/identity-access/domain/authorization-vocabulary";
import {
  defineProjection,
  project,
} from "@/modules/identity-access/presentation/authorized-projector";
import {
  evaluateFieldRule,
  fieldOutcomes,
  neverReturnKeys,
  projectionAudiences,
  projectionPurposes,
  type FieldOutcome,
  type FieldRule,
} from "@/modules/identity-access/presentation/field-policy";
import { findPermission } from "@/modules/identity-access/policy/permission-catalog";
import {
  account,
  matrixWorld,
  principalOf,
  sessionOf,
  staffSession,
  type MatrixWorld,
} from "../fixtures/authorization/matrix-harness";
import { at, record, scope } from "../fixtures/scopes";
import { fieldRows } from "./matrix-manifest";

// M1.7 §13: each classification × field outcome, with the allowed
// permission set computed by the REAL decision pipeline for each persona
// (authorizeFields → evaluateAuthorization), never supplied by a test or a
// client. Synthetic canary values only; failure messages print outcome
// codes, never values.

const CANARY = {
  publicName: "TEST Public Label",
  note: "TESTCANARY-internal-note",
  personnel: "TESTCANARY-personnel-detail",
  tax: "TESTCANARY-tax-identifier-9876",
  screening: "TESTCANARY-screening-report",
  audit: "TESTCANARY-security-audit-detail",
} as const;

type Source = Readonly<{
  label: string;
  note: string;
  personnel: string;
  tax: string | null;
  screening: string | null;
  screeningStatus: "PENDING" | "CLEAR";
  audit: string;
  passwordHash: string;
}>;

/** One representative rule per classification (packet §13 table). */
const rules = {
  PUBLIC: { sensitivity: "PUBLIC", otherwise: "INCLUDE" },
  INTERNAL: {
    sensitivity: "INTERNAL",
    includeWith: "candidate.read.assigned",
    otherwise: "OMIT",
  },
  CONFIDENTIAL_PERSONNEL: {
    sensitivity: "CONFIDENTIAL_PERSONNEL",
    includeWith: "candidate.read.assigned",
    otherwise: "OMIT",
  },
  RESTRICTED_IDENTITY_FINANCIAL: {
    sensitivity: "RESTRICTED_IDENTITY_FINANCIAL",
    includeWith: "identity_document.read_restricted",
    maskWith: "identity_document.read_masked",
    otherwise: "OMIT",
  },
  RESTRICTED_SCREENING_MEDICAL: {
    sensitivity: "RESTRICTED_SCREENING_MEDICAL",
    includeWith: "screening.result.read_restricted",
    statusWith: "screening.status.read",
    otherwise: "OMIT",
  },
  SECURITY_AUDIT_RESTRICTED: {
    sensitivity: "SECURITY_AUDIT_RESTRICTED",
    includeWith: "audit.restricted.read.assigned",
    otherwise: "OMIT",
  },
} as const satisfies Record<string, FieldRule>;
type Classification = keyof typeof rules;

const schema = z.strictObject({
  label: z.string(),
  note: z.string().optional(),
  personnel: z.string().optional(),
  tax: z.string().optional(),
  screening: z.string().optional(),
  audit: z.string().optional(),
});

const contract = defineProjection<Source, z.infer<typeof schema>>({
  name: "test.m17_field_matrix.v1",
  audience: "STAFF",
  purpose: "DETAIL",
  fields: {
    label: { rule: rules.PUBLIC, value: (s) => s.label },
    note: { rule: rules.INTERNAL, value: (s) => s.note },
    personnel: {
      rule: rules.CONFIDENTIAL_PERSONNEL,
      value: (s) => s.personnel,
    },
    tax: {
      rule: rules.RESTRICTED_IDENTITY_FINANCIAL,
      value: (s) => s.tax ?? "",
      // Constant shape with or without a stored value.
      mask: () => "•••-••-••••",
    },
    screening: {
      rule: rules.RESTRICTED_SCREENING_MEDICAL,
      value: (s) => s.screening ?? "",
      status: (s) => s.screeningStatus,
    },
    audit: { rule: rules.SECURITY_AUDIT_RESTRICTED, value: (s) => s.audit },
  },
  schema,
});

const source: Source = {
  label: CANARY.publicName,
  note: CANARY.note,
  personnel: CANARY.personnel,
  tax: CANARY.tax,
  screening: CANARY.screening,
  screeningStatus: "CLEAR",
  audit: CANARY.audit,
  passwordHash: "TESTCANARY-hash",
};

type Persona = Readonly<{
  name: string;
  role: RoleCode;
  scopeType: "TEAM" | "ORGANIZATION" | "AUDIT_ASSIGNMENT";
  scopeId: string;
  fresh: boolean;
  actor?: string;
  /** ADR-0005 R1: restricted identity access needs this designation. */
  designated?: boolean;
}>;

const personas: readonly Persona[] = [
  {
    name: "recruiter",
    role: "RECRUITER",
    scopeType: "TEAM",
    scopeId: scope.TEAM,
    fresh: false,
  },
  {
    name: "hr-specialist",
    role: "HR_SPECIALIST",
    scopeType: "TEAM",
    scopeId: scope.TEAM,
    fresh: false,
  },
  {
    name: "hr-specialist-fresh",
    role: "HR_SPECIALIST",
    scopeType: "TEAM",
    scopeId: scope.TEAM,
    fresh: true,
  },
  {
    name: "hr-designated",
    role: "HR_SPECIALIST",
    scopeType: "TEAM",
    scopeId: scope.TEAM,
    fresh: false,
    designated: true,
  },
  {
    name: "hr-designated-fresh",
    role: "HR_SPECIALIST",
    scopeType: "TEAM",
    scopeId: scope.TEAM,
    fresh: true,
    designated: true,
  },
  {
    name: "compliance-stale",
    role: "COMPLIANCE_REVIEWER",
    scopeType: "TEAM",
    scopeId: scope.TEAM,
    fresh: false,
  },
  {
    name: "compliance-fresh",
    role: "COMPLIANCE_REVIEWER",
    scopeType: "TEAM",
    scopeId: scope.TEAM,
    fresh: true,
  },
  {
    name: "compliance-designated-fresh",
    role: "COMPLIANCE_REVIEWER",
    scopeType: "TEAM",
    scopeId: scope.TEAM,
    fresh: true,
    designated: true,
  },
  {
    name: "compliance-wrong-scope",
    role: "COMPLIANCE_REVIEWER",
    scopeType: "TEAM",
    scopeId: scope.TEAM2,
    fresh: true,
  },
  {
    name: "administrator",
    role: "SYSTEM_ADMINISTRATOR",
    scopeType: "ORGANIZATION",
    scopeId: scope.ORG,
    fresh: true,
  },
  {
    name: "auditor-fresh",
    role: "AUDITOR_READ_ONLY",
    scopeType: "AUDIT_ASSIGNMENT",
    scopeId: scope.AUDIT,
    fresh: true,
    actor: account.AUDITOR,
  },
  {
    name: "auditor-narrow",
    role: "AUDITOR_READ_ONLY",
    scopeType: "AUDIT_ASSIGNMENT",
    scopeId: scope.AUDIT_NARROW,
    fresh: true,
    actor: account.AUDITOR,
  },
];

async function outcomesFor(persona: Persona) {
  const world: MatrixWorld = matrixWorld();
  const actor = persona.actor ?? account.ACTOR;
  world.assign(actor, persona.role, persona.scopeType, persona.scopeId);
  if (persona.designated) {
    world.resolver.addDesignation(
      actor,
      "RESTRICTED_IDENTITY_REVIEWER",
      persona.scopeId,
    );
  }
  if (persona.fresh) {
    world.facts.evidence.set(
      sessionOf(actor),
      staffSession(actor, {
        reauthentication: {
          at: at(-10),
          method: "PASSWORD_TOTP",
          purpose: "RESTRICTED_DATA_ACCESS",
        },
      }),
    );
  }
  const allowed = await authorizeFields(
    Object.values(rules),
    {
      principal: principalOf(actor),
      audience: "STAFF",
      resource: { id: record.IN_TEAM, sensitivity: "CONFIDENTIAL_PERSONNEL" },
      purposeCode: "MATRIX_TEST",
    },
    world.decide,
  );
  const context = { audience: "STAFF", purpose: "DETAIL", allowed } as const;
  const outcomes = Object.fromEntries(
    (Object.keys(rules) as Classification[]).map((c) => [
      c,
      evaluateFieldRule(rules[c], context),
    ]),
  ) as Record<Classification, FieldOutcome>;
  return { outcomes, allowed, view: project(contract, source, context), world };
}

describe("field outcome matrix (§13)", () => {
  it("names a real catalog permission for every classification rule", () => {
    for (const rule of Object.values(rules) as FieldRule[]) {
      for (const code of [rule.includeWith, rule.maskWith, rule.statusWith]) {
        if (code) expect(findPermission(code), code).not.toBeNull();
      }
    }
  });

  const expected: Record<string, Record<Classification, FieldOutcome>> = {
    recruiter: {
      PUBLIC: "INCLUDE",
      INTERNAL: "INCLUDE",
      CONFIDENTIAL_PERSONNEL: "INCLUDE",
      RESTRICTED_IDENTITY_FINANCIAL: "OMIT",
      RESTRICTED_SCREENING_MEDICAL: "STATUS_ONLY",
      SECURITY_AUDIT_RESTRICTED: "OMIT",
    },
    // Not designated (ADR-0005 R1): no identity/tax value or mask at all.
    "hr-specialist": {
      PUBLIC: "INCLUDE",
      INTERNAL: "INCLUDE",
      CONFIDENTIAL_PERSONNEL: "INCLUDE",
      RESTRICTED_IDENTITY_FINANCIAL: "OMIT",
      RESTRICTED_SCREENING_MEDICAL: "STATUS_ONLY",
      SECURITY_AUDIT_RESTRICTED: "OMIT",
    },
    "hr-specialist-fresh": {
      PUBLIC: "INCLUDE",
      INTERNAL: "INCLUDE",
      CONFIDENTIAL_PERSONNEL: "INCLUDE",
      RESTRICTED_IDENTITY_FINANCIAL: "OMIT",
      RESTRICTED_SCREENING_MEDICAL: "STATUS_ONLY",
      SECURITY_AUDIT_RESTRICTED: "OMIT",
    },
    // Designated: masked by default; the full value needs fresh step-up.
    "hr-designated": {
      PUBLIC: "INCLUDE",
      INTERNAL: "INCLUDE",
      CONFIDENTIAL_PERSONNEL: "INCLUDE",
      RESTRICTED_IDENTITY_FINANCIAL: "MASK",
      RESTRICTED_SCREENING_MEDICAL: "STATUS_ONLY",
      SECURITY_AUDIT_RESTRICTED: "OMIT",
    },
    "hr-designated-fresh": {
      PUBLIC: "INCLUDE",
      INTERNAL: "INCLUDE",
      CONFIDENTIAL_PERSONNEL: "INCLUDE",
      RESTRICTED_IDENTITY_FINANCIAL: "INCLUDE",
      RESTRICTED_SCREENING_MEDICAL: "STATUS_ONLY",
      SECURITY_AUDIT_RESTRICTED: "OMIT",
    },
    // Compliance holds no status-only screening permission: stale step-up
    // means nothing, fresh step-up means the specialist value.
    "compliance-stale": {
      PUBLIC: "INCLUDE",
      INTERNAL: "INCLUDE",
      CONFIDENTIAL_PERSONNEL: "INCLUDE",
      RESTRICTED_IDENTITY_FINANCIAL: "OMIT",
      RESTRICTED_SCREENING_MEDICAL: "OMIT",
      SECURITY_AUDIT_RESTRICTED: "OMIT",
    },
    "compliance-fresh": {
      PUBLIC: "INCLUDE",
      INTERNAL: "INCLUDE",
      CONFIDENTIAL_PERSONNEL: "INCLUDE",
      RESTRICTED_IDENTITY_FINANCIAL: "OMIT",
      RESTRICTED_SCREENING_MEDICAL: "INCLUDE",
      SECURITY_AUDIT_RESTRICTED: "OMIT",
    },
    "compliance-designated-fresh": {
      PUBLIC: "INCLUDE",
      INTERNAL: "INCLUDE",
      CONFIDENTIAL_PERSONNEL: "INCLUDE",
      RESTRICTED_IDENTITY_FINANCIAL: "INCLUDE",
      RESTRICTED_SCREENING_MEDICAL: "INCLUDE",
      SECURITY_AUDIT_RESTRICTED: "OMIT",
    },
    "compliance-wrong-scope": {
      PUBLIC: "INCLUDE",
      INTERNAL: "OMIT",
      CONFIDENTIAL_PERSONNEL: "OMIT",
      RESTRICTED_IDENTITY_FINANCIAL: "OMIT",
      RESTRICTED_SCREENING_MEDICAL: "OMIT",
      SECURITY_AUDIT_RESTRICTED: "OMIT",
    },
    administrator: {
      PUBLIC: "INCLUDE",
      INTERNAL: "OMIT",
      CONFIDENTIAL_PERSONNEL: "OMIT",
      RESTRICTED_IDENTITY_FINANCIAL: "OMIT",
      RESTRICTED_SCREENING_MEDICAL: "OMIT",
      SECURITY_AUDIT_RESTRICTED: "OMIT",
    },
    "auditor-fresh": {
      PUBLIC: "INCLUDE",
      INTERNAL: "INCLUDE",
      CONFIDENTIAL_PERSONNEL: "INCLUDE",
      RESTRICTED_IDENTITY_FINANCIAL: "INCLUDE",
      RESTRICTED_SCREENING_MEDICAL: "INCLUDE",
      SECURITY_AUDIT_RESTRICTED: "INCLUDE",
    },
    // Assignment covers CONFIDENTIAL_PERSONNEL only. The same permission
    // backs the INTERNAL rule, and authorizeFields counts a permission only
    // when it is allowed at EVERY classification a rule uses it at, so the
    // conservative result is that neither field is returned.
    "auditor-narrow": {
      PUBLIC: "INCLUDE",
      INTERNAL: "OMIT",
      CONFIDENTIAL_PERSONNEL: "OMIT",
      RESTRICTED_IDENTITY_FINANCIAL: "OMIT",
      RESTRICTED_SCREENING_MEDICAL: "OMIT",
      SECURITY_AUDIT_RESTRICTED: "OMIT",
    },
  };

  it.each(personas.map((p) => [p.name, p] as const))(
    "field outcome for %s follows the decision pipeline exactly",
    async (name, persona) => {
      const { outcomes, view } = await outcomesFor(persona);
      expect(outcomes).toEqual(expected[name]);
      expect(view.kind).toBe("PROJECTED");
      if (view.kind !== "PROJECTED") return;
      // Omitted is absent (never null); masked/status never carry the value.
      const keys = {
        note: "INTERNAL",
        personnel: "CONFIDENTIAL_PERSONNEL",
        tax: "RESTRICTED_IDENTITY_FINANCIAL",
        screening: "RESTRICTED_SCREENING_MEDICAL",
        audit: "SECURITY_AUDIT_RESTRICTED",
      } as const;
      for (const [key, classification] of Object.entries(keys)) {
        const outcome = outcomes[classification];
        const value = (view.value as Record<string, unknown>)[key];
        if (outcome === "OMIT") expect(key in view.value, key).toBe(false);
        if (outcome === "MASK") expect(value).toBe("•••-••-••••");
        if (outcome === "STATUS_ONLY") expect(value).toBe("CLEAR");
      }
      const text = JSON.stringify(view.value);
      if (outcomes.RESTRICTED_SCREENING_MEDICAL !== "INCLUDE") {
        expect(text.includes(CANARY.screening)).toBe(false);
      }
      if (outcomes.RESTRICTED_IDENTITY_FINANCIAL !== "INCLUDE") {
        expect(text.includes(CANARY.tax)).toBe(false);
      }
      expect(text.includes("TESTCANARY-hash")).toBe(false);
    },
  );

  it("reaches every field outcome in the closed vocabulary", async () => {
    const reached = new Set<FieldOutcome>();
    for (const persona of personas) {
      for (const outcome of Object.values(
        (await outcomesFor(persona)).outcomes,
      )) {
        reached.add(outcome);
      }
    }
    // DENY_RESOURCE is reached by unknown/malformed metadata below.
    reached.add(
      evaluateFieldRule(
        { sensitivity: "SECRET", otherwise: "INCLUDE" },
        {
          audience: "STAFF",
          purpose: "DETAIL",
          allowed: new Set(),
        },
      ),
    );
    expect([...reached].sort()).toEqual([...fieldOutcomes].sort());
    expect(fieldRows.map((r) => r.outcome).sort()).toEqual(
      [...fieldOutcomes].sort(),
    );
  });

  it("fails closed on unknown or new field metadata and never includes restricted data by default", () => {
    const ctx = {
      audience: "STAFF",
      purpose: "DETAIL",
      allowed: new Set(["identity_document.read_restricted"]),
    } as const;
    for (const rule of [
      null,
      {},
      { sensitivity: "TOP_SECRET", otherwise: "INCLUDE" },
      { sensitivity: "PUBLIC", otherwise: "SHOW" },
      { sensitivity: "PUBLIC", otherwise: "INCLUDE", showAll: true },
      { sensitivity: "RESTRICTED_SCREENING_MEDICAL", otherwise: "INCLUDE" },
      { sensitivity: "PUBLIC", includeWith: 7, otherwise: "OMIT" },
    ]) {
      expect(evaluateFieldRule(rule, ctx), JSON.stringify(rule)).toBe(
        "DENY_RESOURCE",
      );
    }
  });

  it("refuses never-return keys for every audience and purpose", () => {
    for (const audience of projectionAudiences) {
      for (const purpose of projectionPurposes) {
        for (const key of neverReturnKeys) {
          expect(() =>
            defineProjection({
              name: "test.never.v1",
              audience,
              purpose,
              fields: {
                [key]: { rule: rules.PUBLIC, value: () => "x" },
              } as never,
              schema: z.strictObject({ [key]: z.string() }) as never,
            }),
          ).toThrow();
        }
      }
    }
  });

  it("does not reveal whether a restricted value exists through null, omission, mask, or status", async () => {
    const recruiter = personas.find((p) => p.name === "recruiter")!;
    const hr = personas.find((p) => p.name === "hr-specialist")!;
    for (const persona of [recruiter, hr]) {
      const { allowed } = await outcomesFor(persona);
      const context = {
        audience: "STAFF",
        purpose: "DETAIL",
        allowed,
      } as const;
      const withValue = project(contract, source, context);
      const without = project(
        contract,
        { ...source, tax: null, screening: null },
        context,
      );
      expect(withValue).toEqual(without);
    }
  });

  it("ignores client field selection, audience, and purpose: only server facts decide", async () => {
    const recruiter = personas.find((p) => p.name === "recruiter")!;
    const { allowed } = await outcomesFor(recruiter);
    const forged = {
      audience: "STAFF",
      purpose: "DETAIL",
      allowed,
      fields: ["tax", "screening", "passwordHash"],
      includeRestricted: true,
    } as never;
    const view = project(contract, source, forged);
    expect(view.kind === "PROJECTED" && "tax" in view.value).toBe(false);
    for (const [audience, purpose] of [
      ["CANDIDATE", "DETAIL"],
      ["SERVICE", "DETAIL"],
      ["STAFF", "LIST"],
    ] as const) {
      expect(project(contract, source, { audience, purpose, allowed })).toEqual(
        {
          kind: "REFUSED",
          reason:
            audience === "STAFF" ? "PURPOSE_MISMATCH" : "AUDIENCE_MISMATCH",
        },
      );
    }
  });

  it("rejects exact-schema drift instead of returning an extra field", () => {
    const drifted = defineProjection<Source, { label: string }>({
      name: "test.m17_drift.v1",
      audience: "STAFF",
      purpose: "DETAIL",
      fields: { label: { rule: rules.PUBLIC, value: (s) => s.label } },
      schema: z.strictObject({ other: z.string() }) as never,
    });
    expect(
      project(drifted, source, {
        audience: "STAFF",
        purpose: "DETAIL",
        allowed: new Set(),
      }),
    ).toEqual({ kind: "REFUSED", reason: "SCHEMA_MISMATCH" });
  });
});

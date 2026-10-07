import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { roleCodes } from "../domain/authorization-vocabulary";
import { parseGrantCondition } from "../domain/grant-condition";
import { allowedScopeTypesByRole } from "../domain/role-assignment";
import {
  AUTHORIZATION_CATALOG_DIGEST,
  AUTHORIZATION_CATALOG_VERSION,
  AUTHORIZATION_POLICY_VERSION,
  authorizationCatalog,
  canonicalCatalog,
} from "./authorization-catalog";
import {
  findPermission,
  permissionCatalog,
  permissionCodePattern,
} from "./permission-catalog";
import { roleCatalog } from "./role-catalog";
import {
  grantCatalog,
  pendingMatrixDecisions,
} from "./role-permission-catalog";

// Catalog integrity (AC-M1.4-01..03). Any change to roles, permissions, or
// grants must be deliberate: it changes the digest, which fails here until
// the catalog version and digest are updated in the same reviewed change.

const grantsOf = (role: string) =>
  grantCatalog.filter((g) => g.roleCode === role);
const permissionsOf = (role: string) =>
  grantsOf(role).map((g) => findPermission(g.permissionCode)!);

describe("authorization catalog integrity", () => {
  it("is reviewed: the canonical digest matches the recorded digest", () => {
    const digest = createHash("sha256")
      .update(canonicalCatalog())
      .digest("hex");
    expect(
      digest,
      `catalog changed: bump AUTHORIZATION_CATALOG_VERSION and set AUTHORIZATION_CATALOG_DIGEST to ${digest}`,
    ).toBe(AUTHORIZATION_CATALOG_DIGEST);
    expect(authorizationCatalog.version).toBe(AUTHORIZATION_CATALOG_VERSION);
    expect(AUTHORIZATION_POLICY_VERSION).toMatch(/^authz-p\d+-c\d+$/);
  });

  it("defines exactly the nine controlled roles with stable codes", () => {
    expect(roleCatalog.map((r) => r.code)).toEqual([...roleCodes]);
    expect(roleCatalog.map((r) => r.code)).toEqual([
      "CANDIDATE",
      "RECRUITER",
      "HR_SPECIALIST",
      "CLASSIFICATION_REVIEWER",
      "COMPLIANCE_REVIEWER",
      "TRAINER_EVALUATOR",
      "PSA_MANAGER",
      "SYSTEM_ADMINISTRATOR",
      "AUDITOR_READ_ONLY",
    ]);
    for (const role of roleCatalog) {
      expect(role.principalType).toBe(
        role.code === "CANDIDATE" ? "CANDIDATE" : "STAFF",
      );
      expect(role.status).toBe("ACTIVE");
      // No admin, wildcard, superuser, or bypass field exists at all.
      expect(Object.keys(role).sort()).toEqual(
        [
          "code",
          "description",
          "isSystemRole",
          "name",
          "principalType",
          "status",
        ].sort(),
      );
    }
  });

  it("uses narrow, unique, stable permission codes with no wildcard", () => {
    const codes = permissionCatalog.map((p) => p.code);
    expect(new Set(codes).size).toBe(codes.length);
    for (const p of permissionCatalog) {
      expect(p.code).toMatch(permissionCodePattern);
      expect(p.code).toBe(`${p.resource}.${p.action}`);
      // No wildcard, catch-all, admin, route, row ID, or digit identifiers.
      expect(p.code).not.toMatch(
        /[*/:0-9]|(^|\.)(all|any|admin|superuser|root)(\.|$)/,
      );
      expect(p.description.length).toBeGreaterThan(0);
      expect(p.description.length).toBeLessThanOrEqual(500);
      expect(p.matrixRefs.length).toBeGreaterThan(0);
      expect(p.isExport).toBe(p.operation === "EXPORT");
    }
  });

  it("references only defined roles/permissions in unique, valid grants", () => {
    const keys = grantCatalog.map((g) => `${g.roleCode}|${g.permissionCode}`);
    expect(new Set(keys).size).toBe(keys.length);
    for (const grant of grantCatalog) {
      expect(
        findPermission(grant.permissionCode),
        grant.permissionCode,
      ).not.toBeNull();
      expect(roleCodes).toContain(grant.roleCode);
      expect(parseGrantCondition(grant.condition)).not.toBe("INVALID");
    }
  });

  it("limits the system administrator to technical permissions", () => {
    const perms = permissionsOf("SYSTEM_ADMINISTRATOR");
    expect(perms.length).toBeGreaterThan(0);
    for (const p of perms) {
      expect(p.domain, p.code).toBe("TECHNICAL");
      expect(["APPROVE", "REVIEW", "EXPORT", "DOWNLOAD"]).not.toContain(
        p.operation,
      );
    }
    const codes = perms.map((p) => p.code);
    // Implements approved access changes; never approves them.
    expect(codes).not.toContain("role_assignment.approve");
    for (const business of [
      "candidate.read.assigned",
      "screening.result.read_restricted",
      "medical_document.download",
      "compensation.read",
      "classification.review.decide",
      "readiness.final_approval",
      "record.export.standard",
    ]) {
      expect(codes).not.toContain(business);
    }
    expect(allowedScopeTypesByRole.SYSTEM_ADMINISTRATOR).toEqual([
      "ORGANIZATION",
    ]);
  });

  it("keeps the auditor read/export-only within audit assignments", () => {
    for (const p of permissionsOf("AUDITOR_READ_ONLY")) {
      expect(["READ", "EXPORT"], p.code).toContain(p.operation);
    }
    expect(allowedScopeTypesByRole.AUDITOR_READ_ONLY).toEqual([
      "AUDIT_ASSIGNMENT",
    ]);
    for (const role of roleCodes) {
      if (role === "AUDITOR_READ_ONLY") continue;
      expect(allowedScopeTypesByRole[role]).not.toContain("AUDIT_ASSIGNMENT");
    }
  });

  it("gives candidate-self permissions only to the CANDIDATE relationship", () => {
    const self = permissionCatalog.filter((p) => p.domain === "CANDIDATE_SELF");
    const candidate = grantsOf("CANDIDATE");
    expect(candidate.map((g) => g.permissionCode).sort()).toEqual(
      self.map((p) => p.code).sort(),
    );
    for (const grant of candidate) {
      expect(grant.condition).toEqual({ v: 1, kind: "CANDIDATE_OWNERSHIP" });
    }
    for (const grant of grantCatalog) {
      if (grant.roleCode === "CANDIDATE") continue;
      expect(findPermission(grant.permissionCode)!.domain).not.toBe(
        "CANDIDATE_SELF",
      );
      expect(grant.condition?.kind).not.toBe("CANDIDATE_OWNERSHIP");
    }
    expect(allowedScopeTypesByRole.CANDIDATE).toEqual([]);
  });

  it("grants pending-decision permissions to nobody", () => {
    for (const code of [
      "application.assist",
      "screening.result.intake",
      "compliance.waiver.approve",
      "break_glass.start",
      "impersonation.start",
    ]) {
      expect(findPermission(code), code).not.toBeNull();
      expect(grantCatalog.filter((g) => g.permissionCode === code)).toEqual([]);
    }
    expect(pendingMatrixDecisions.length).toBeGreaterThan(0);
  });

  it("applies the restrictive interpretation to key matrix cells", () => {
    const holds = (role: string, code: string) =>
      grantCatalog.find(
        (g) => g.roleCode === role && g.permissionCode === code,
      );
    // Recruiters never approve readiness or see restricted screening.
    expect(holds("RECRUITER", "readiness.final_approval")).toBeUndefined();
    expect(
      holds("RECRUITER", "screening.result.read_restricted"),
    ).toBeUndefined();
    expect(holds("RECRUITER", "record.export.restricted")).toBeUndefined();
    // Managers act on classification/readiness only when designated.
    expect(
      holds("PSA_MANAGER", "classification.review.decide")?.condition,
    ).toEqual({
      v: 1,
      kind: "DESIGNATION",
      designation: "CLASSIFICATION_APPROVER",
    });
    expect(holds("PSA_MANAGER", "readiness.final_approval")?.condition).toEqual(
      {
        v: 1,
        kind: "DESIGNATION",
        designation: "READINESS_APPROVER",
      },
    );
    // Limited hold authority is category-bound.
    expect(holds("HR_SPECIALIST", "compliance_hold.place")?.condition).toEqual({
      v: 1,
      kind: "HOLD_CATEGORY",
      categories: ["DOCUMENT"],
    });
    // Interviewing requires the interviewer relationship.
    expect(
      holds("RECRUITER", "interview.scorecard.submit")?.condition?.kind,
    ).toBe("PARTICIPANT");
    // Restricted screening/medical content is compliance (and audit) only.
    for (const p of permissionCatalog.filter(
      (p) =>
        p.maxSensitivity === "RESTRICTED_SCREENING_MEDICAL" &&
        p.domain === "BUSINESS",
    )) {
      for (const g of grantCatalog.filter((g) => g.permissionCode === p.code)) {
        expect(["COMPLIANCE_REVIEWER", "AUDITOR_READ_ONLY"], p.code).toContain(
          g.roleCode,
        );
      }
    }
  });

  it("requires named recent authentication for high-risk permissions", () => {
    const strong = [
      "classification.review.decide",
      "screening.disposition.decide",
      "adverse_action.final_record",
      "readiness.final_approval",
      "record.export.restricted",
      "role_assignment.propose",
      "role_assignment.approve",
      "break_glass.start",
    ];
    for (const code of strong) {
      expect(findPermission(code)!.recentAuth?.policy, code).toBe(
        "RECENT_STRONG_AUTH",
      );
    }
    expect(findPermission("break_glass.start")!.recentAuth?.purpose).toBe(
      "BREAK_GLASS",
    );
    expect(findPermission("role_assignment.approve")!.recentAuth?.purpose).toBe(
      "PRIVILEGED_ACCESS_CHANGE",
    );
    for (const p of permissionCatalog) {
      // Viewing/downloading restricted values always needs recent auth.
      if (
        p.domain === "BUSINESS" &&
        p.restrictedData &&
        (p.action.includes("read_restricted") || p.operation === "DOWNLOAD")
      ) {
        expect(p.recentAuth, p.code).not.toBeNull();
      }
    }
  });

  it("separates view, edit, approve, download, export, and configure", () => {
    const ops = new Set(permissionCatalog.map((p) => p.operation));
    for (const op of [
      "READ",
      "CREATE",
      "EDIT",
      "REVIEW",
      "APPROVE",
      "DOWNLOAD",
      "EXPORT",
      "CONFIGURE",
      "ADMINISTER",
    ]) {
      expect(ops.has(op as never), op).toBe(true);
    }
    // Export is never implied by view.
    for (const p of permissionCatalog.filter((p) => p.operation === "EXPORT")) {
      expect(p.code).toMatch(/export/);
    }
  });
});

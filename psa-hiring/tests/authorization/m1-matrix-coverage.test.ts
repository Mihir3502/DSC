import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { routeManifest } from "@/app/_security/route-manifest";
import { eventCatalog } from "@/modules/audit/application/event-catalog";
import {
  roleCodes,
  scopeTypes,
} from "@/modules/identity-access/domain/authorization-vocabulary";
import { selfServicePolicies } from "@/modules/identity-access/domain/self-service-policy";
import { fieldOutcomes } from "@/modules/identity-access/presentation/field-policy";
import {
  AUTHORIZATION_CATALOG_DIGEST,
  AUTHORIZATION_CATALOG_VERSION,
} from "@/modules/identity-access/policy/authorization-catalog";
import {
  findPermission,
  permissionCatalog,
} from "@/modules/identity-access/policy/permission-catalog";
import { grantCatalog } from "@/modules/identity-access/policy/role-permission-catalog";
import { criticalScope, scanForMarkers } from "../guards/critical-tests";
import approved from "./approved-grants.json";
import {
  eventRows,
  fieldRows,
  pairRows,
  requiredScenarios,
  revocationRows,
  routeRows,
  routeScenarios,
  scenarioCoverage,
  scopeConditions,
  scopeRows,
  sectionSuites,
  selfServiceRows,
  type TestRef,
} from "./matrix-manifest";

// M1.7 §7 drift control: CI fails when a catalog role/permission/grant,
// scope type, route-manifest entry, field outcome, self-service policy, or
// event lacks coverage; when a referenced test is missing or renamed; when
// the catalog drifts from the reviewed grant snapshot without an approved
// change; or when a critical test is skipped, focused, or todo.

const root = path.resolve(import.meta.dirname, "../..");
const titleCache = new Map<string, string[]>();
function titles(file: string): string[] {
  if (!titleCache.has(file)) {
    const text = readFileSync(path.join(root, file), "utf8");
    titleCache.set(
      file,
      [
        ...text.matchAll(
          /\b(?:it|test)(?:\.each\([\s\S]*?\))?\(\s*(["'`])([\s\S]*?)\1/g,
        ),
      ].map((m) => m[2]!.replace(/\s+/g, " ")),
    );
  }
  return titleCache.get(file)!;
}
const missingRefs = (refs: readonly TestRef[]) =>
  refs
    .filter(
      (r) =>
        !existsSync(path.join(root, r.file)) ||
        !titles(r.file).some((t) => t.includes(r.title)),
    )
    .map((r) => `${r.file} :: ${r.title}`);

describe("M1 matrix drift and coverage (§7)", () => {
  it("the accepted grant catalog equals the reviewed approved-grants snapshot", () => {
    const current = grantCatalog
      .map((g) => ({
        role: g.roleCode,
        permission: g.permissionCode,
        condition: g.condition ?? null,
        status: g.status,
      }))
      .sort((a, b) => (a.role + a.permission < b.role + b.permission ? -1 : 1));
    expect(JSON.parse(JSON.stringify(current))).toEqual(approved.grants);
    expect(approved.catalogVersion).toBe(AUTHORIZATION_CATALOG_VERSION);
    expect(approved.catalogDigest).toBe(AUTHORIZATION_CATALOG_DIGEST);
  });

  it("covers every catalog role × permission pair with a matrix row and known codes", () => {
    expect(pairRows).toHaveLength(roleCodes.length * permissionCatalog.length);
    for (const row of pairRows) {
      expect(findPermission(row.permission), row.id).not.toBeNull();
      expect(roleCodes, row.id).toContain(row.role);
    }
    for (const grant of grantCatalog) {
      expect(
        pairRows.some(
          (r) =>
            r.granted &&
            r.role === grant.roleCode &&
            r.permission === grant.permissionCode,
        ),
        `${grant.roleCode}|${grant.permissionCode}`,
      ).toBe(true);
    }
  });

  it("covers every scope type and condition, field outcome, and self-service policy", () => {
    expect(scopeRows).toHaveLength(scopeTypes.length * scopeConditions.length);
    expect(fieldRows.map((r) => r.outcome).sort()).toEqual(
      [...fieldOutcomes].sort(),
    );
    // The self-service matrix iterates the registry itself and asserts it
    // equals these rows, so coverage is by construction.
    expect(selfServiceRows).toHaveLength(selfServicePolicies.length);
    expect(
      missingRefs([
        {
          file: "tests/authorization/self-service.matrix.test.ts",
          title: "covers every registered self-service policy",
        },
        {
          file: "tests/authorization/field.matrix.test.ts",
          title: "reaches every field outcome in the closed vocabulary",
        },
        {
          file: "tests/authorization/scope.matrix.test.ts",
          title: "covers every scope type and condition",
        },
      ]),
    ).toEqual([]);
  });

  it("requires scenario coverage for every route-manifest entry", () => {
    expect(routeRows).toHaveLength(routeManifest.length);
    for (const row of routeRows) {
      for (const scenario of row.scenarios) {
        expect(routeScenarios, row.id).toContain(scenario);
        expect(
          scenarioCoverage[scenario].length,
          `${row.id} ${scenario}`,
        ).toBeGreaterThan(0);
      }
    }
    // Every scenario that any entry requires names only existing tests.
    const used = new Set(routeManifest.flatMap(requiredScenarios));
    expect(missingRefs([...used].flatMap((s) => scenarioCoverage[s]))).toEqual(
      [],
    );
  });

  it("requires an executable test for every audit/security event in the catalog", () => {
    const integration = execFileSync(
      "git",
      [
        "ls-files",
        "--cached",
        "--others",
        "--exclude-standard",
        "--",
        ":(glob)tests/integration/**/*.ts",
      ],
      { cwd: root, encoding: "utf8" },
    )
      .split("\n")
      .filter(Boolean)
      .map((f) => readFileSync(path.join(root, f), "utf8"))
      .join("\n");
    for (const row of eventRows) {
      expect(integration.includes(`"${row.name}"`), row.id).toBe(true);
    }
    expect(eventRows).toHaveLength(eventCatalog.length);
  });

  it("names only existing tests for every packet section and revocation row", () => {
    expect(missingRefs(Object.values(sectionSuites).flat())).toEqual([]);
    expect(missingRefs(Object.values(revocationRows).flat())).toEqual([]);
    expect(Object.keys(revocationRows)).toHaveLength(11);
  });

  it("has no skipped, todo, focused, or fixme critical test anywhere in scope", () => {
    const files = execFileSync(
      "git",
      [
        "ls-files",
        "--cached",
        "--others",
        "--exclude-standard",
        "--",
        ...criticalScope.map((g) => `:(glob)${g}`),
      ],
      { cwd: root, encoding: "utf8" },
    )
      .split("\n")
      .filter(Boolean);
    expect(files.length).toBeGreaterThan(50);
    const findings = files.flatMap((f) =>
      scanForMarkers(f, readFileSync(path.join(root, f), "utf8")),
    );
    expect(findings).toEqual([]);
  });

  it("detects drift: a perturbed grant snapshot or a renamed test reference fails", () => {
    const perturbed = approved.grants.slice(1);
    expect(perturbed).not.toEqual(approved.grants);
    expect(
      missingRefs([
        {
          file: "tests/authorization/scope.matrix.test.ts",
          title: "a renamed title that does not exist",
        },
      ]),
    ).toHaveLength(1);
  });
});

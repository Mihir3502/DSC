import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { permissionCatalog } from "@/modules/identity-access/policy/permission-catalog";
import { pendingMatrixDecisions } from "@/modules/identity-access/policy/role-permission-catalog";

// Catalog ↔ matrix traceability and production-surface guards (packet M1.4
// §16, §24.19, §24.21, AC-M1.4-02, AC-M1.4-13). If ROLE_PERMISSION_MATRIX.md
// gains, renames, or removes a §7 data domain, §8 command, or §14
// configuration row, this fails until the catalog (and ADR-0005) traces it.

const projectRoot = path.resolve(import.meta.dirname, "../..");
const matrixPath = path.resolve(
  projectRoot,
  "../docs/ROLE_PERMISSION_MATRIX.md",
);

function tableRows(markdown: string, heading: string): string[] {
  const start = markdown.indexOf(heading);
  if (start < 0) throw new Error(`matrix section missing: ${heading}`);
  const rest = markdown.slice(start + heading.length);
  const end = rest.search(/\n## /);
  const section = end < 0 ? rest : rest.slice(0, end);
  return section
    .split("\n")
    .filter((line) => line.startsWith("|"))
    .slice(2) // header + separator
    .map((line) => line.split("|")[1]!.trim())
    .filter(Boolean);
}

const traced = new Set([
  ...permissionCatalog.flatMap((p) => p.matrixRefs),
  ...pendingMatrixDecisions.map((d) => d.matrixRef),
]);

describe("authorization matrix traceability", () => {
  const matrix = readFileSync(matrixPath, "utf8");
  const sections = [
    ["§7", "## 7. Data-Domain Permission Matrix", 31],
    ["§8", "## 8. Workflow Command Permission Matrix", 33],
    ["§14", "## 14. Configuration Permissions", 15],
  ] as const;

  for (const [ref, heading, expected] of sections) {
    it(`traces every ${ref} row to the catalog`, () => {
      const rows = tableRows(matrix, heading);
      expect(rows.length, `${ref} row count changed; review the catalog`).toBe(
        expected,
      );
      const untraced = rows.filter((row) => !traced.has(`${ref}:${row}`));
      expect(untraced).toEqual([]);
    });
  }

  it("references only rows that exist in the matrix", () => {
    const known = new Set(
      sections.flatMap(([ref, heading]) =>
        tableRows(matrix, heading).map((row) => `${ref}:${row}`),
      ),
    );
    const dangling = [...traced].filter(
      (r) => /^§(7|8|14):/.test(r) && !known.has(r),
    );
    expect(dangling).toEqual([]);
  });
});

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.(ts|tsx|mts)$/.test(name) ? [full] : [];
  });
}

describe("no production authorization-administration surface", () => {
  const forbidden =
    /role-assignments|assignment-harness|NonproductionAssignmentHarness|SyntheticScopeResolver|SyntheticCandidateOwnership|proposeRoleAssignment|approveRoleAssignment|revokeRoleAssignment|replaceRoleAssignment|listRoleAssignments/;

  it("no route, page, action, proxy, or CLI script reaches assignment commands or test adapters", () => {
    const delivery = [
      ...sourceFiles(path.join(projectRoot, "src/app")),
      path.join(projectRoot, "src/proxy.ts"),
      ...sourceFiles(path.join(projectRoot, "scripts")),
    ].filter((file) => !/\.test\.tsx?$/.test(file));
    const offenders = delivery.filter((file) =>
      forbidden.test(readFileSync(file, "utf8")),
    );
    expect(offenders.map((f) => path.relative(projectRoot, f))).toEqual([]);
  });

  it("the module's public index does not export assignment administration", () => {
    const index = readFileSync(
      path.join(projectRoot, "src/modules/identity-access/index.ts"),
      "utf8",
    );
    expect(index).not.toMatch(forbidden);
    expect(index).not.toMatch(/isAdmin|superuser|wildcard/i);
  });
});

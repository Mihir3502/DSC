import { describe, expect, it } from "vitest";
import { canaries } from "../../tests/fixtures/canaries";
import { checkArtifactFile } from "./artifact-guard";
import { evaluateGate, REQUIRED_JOBS } from "./ci-gate";
import {
  blockingAdvisories,
  parseAudit,
  validateExceptions,
  type AuditException,
} from "./dependency-audit";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  scannedCommits,
  summarize,
  validateGitleaksConfig,
} from "./secret-scan";

const allSuccess = Object.fromEntries(
  REQUIRED_JOBS.map((j) => [j, { result: "success" }]),
);

describe("ci-gate", () => {
  it("passes only when every required job succeeded", () => {
    expect(evaluateGate(allSuccess, REQUIRED_JOBS)).toEqual([]);
  });

  it.each(["failure", "cancelled", "skipped"])(
    "fails when a job is %s",
    (result) => {
      const needs = { ...allSuccess, "unit-component-coverage": { result } };
      expect(evaluateGate(needs, REQUIRED_JOBS)).toEqual([
        `unit-component-coverage: ${result}`,
      ]);
    },
  );

  it("fails when a required job is missing or an unknown job appears", () => {
    const withoutBuild: Record<string, { result: string }> = { ...allSuccess };
    delete withoutBuild.build;
    expect(evaluateGate(withoutBuild, REQUIRED_JOBS)).toEqual([
      "build: missing",
    ]);
    expect(
      evaluateGate(
        { ...allSuccess, extra: { result: "success" } },
        REQUIRED_JOBS,
      ),
    ).toEqual(["extra: not in the required job list"]);
  });
});

// Deterministic scanner fixture (no network): the shape of `pnpm audit --json`.
const auditFixture = JSON.stringify({
  advisories: {
    "1": {
      github_advisory_id: "GHSA-test-high-0001",
      module_name: "fixture-high",
      severity: "high",
      findings: [{ paths: [".>fixture-parent>fixture-high"] }],
    },
    "2": {
      github_advisory_id: "GHSA-test-crit-0002",
      module_name: "fixture-critical",
      severity: "critical",
      findings: [{ paths: [".>fixture-critical"] }],
    },
    "3": {
      github_advisory_id: "GHSA-test-mod-0003",
      module_name: "fixture-moderate",
      severity: "moderate",
      findings: [{ paths: [".>fixture-moderate"] }],
    },
  },
});

const exception: AuditException = {
  advisory: "GHSA-test-high-0001",
  package: "fixture-high",
  path: ".>fixture-parent>fixture-high",
  rationale: "TEST fixture rationale",
  compensatingControl: "TEST fixture control",
  owner: "TEST owner",
  approvedBy: "TEST approver",
  expires: "2026-12-31",
};

describe("dependency-audit", () => {
  it("blocks HIGH and CRITICAL but not MODERATE advisories", () => {
    const blocking = blockingAdvisories(parseAudit(auditFixture), []);
    expect(blocking.map((a) => a.ghsa).sort()).toEqual([
      "GHSA-test-crit-0002",
      "GHSA-test-high-0001",
    ]);
  });

  it("honors an exact, valid exception only for its advisory, package, and path", () => {
    const blocking = blockingAdvisories(parseAudit(auditFixture), [exception]);
    expect(blocking.map((a) => a.ghsa)).toEqual(["GHSA-test-crit-0002"]);
    const wrongPath = { ...exception, path: ".>other" };
    expect(
      blockingAdvisories(parseAudit(auditFixture), [wrongPath]),
    ).toHaveLength(2);
  });

  it("rejects expired or incomplete exceptions", () => {
    expect(validateExceptions([exception], "2026-10-06")).toEqual([]);
    expect(
      validateExceptions(
        [{ ...exception, expires: "2026-01-01" }],
        "2026-10-06",
      ),
    ).toEqual(["exception #1: expired on 2026-01-01"]);
    expect(
      validateExceptions([{ ...exception, approvedBy: "" }], "2026-10-06"),
    ).toEqual(["exception #1: missing approvedBy"]);
    expect(validateExceptions({}, "2026-10-06")).toEqual([
      "exceptions file must contain a JSON array",
    ]);
  });

  it("treats unusable scanner output as a failure, not a pass", () => {
    expect(() =>
      parseAudit('{"error":{"code":"ERR_PNPM_AUDIT_BAD_RESPONSE"}}'),
    ).toThrow();
    expect(() => parseAudit("not json")).toThrow();
  });
});

describe("secret-scan", () => {
  it("reads the scanned-commit count and refuses unknown output", () => {
    expect(scannedCommits("INF 9 commits scanned.")).toBe(9);
    expect(scannedCommits("INF 1 commit scanned.")).toBe(1);
    expect(scannedCommits("fatal: detected dubious ownership")).toBeUndefined();
  });

  it("summarizes findings without any secret value", () => {
    const lines = summarize([
      {
        RuleID: "generic-api-key",
        File: "src/x.ts",
        StartLine: 3,
        Commit: "0123456789abcdef",
      },
    ]);
    expect(lines).toEqual(["generic-api-key src/x.ts:3 (commit 01234567)"]);
  });

  const repoConfig = readFileSync(
    path.resolve(import.meta.dirname, "../../../.gitleaks.toml"),
    "utf8",
  );

  it("accepts the committed .gitleaks.toml and a missing file", () => {
    expect(validateGitleaksConfig(repoConfig, "2026-10-06")).toEqual([]);
    expect(validateGitleaksConfig(undefined, "2026-10-06")).toEqual([]);
  });

  it("fails once an allowlist review-by date has passed", () => {
    expect(validateGitleaksConfig(repoConfig, "2027-01-07")).toEqual([
      "allowlist #1: review-by date 2027-01-06 has passed",
    ]);
  });

  it.each([
    [
      "missing metadata",
      (t: string) => t.replace(/^# owner:.*$/m, ""),
      "owner",
    ],
    [
      "OR condition",
      (t: string) => t.replace(/^condition = "AND"$/m, 'condition = "OR"'),
      'condition must be "AND"',
    ],
    [
      "rule-wide entry",
      (t: string) => t.replace(/^commits = .*$/m, ""),
      "commits must list exactly one",
    ],
    [
      "wildcard path",
      (t: string) =>
        t.replace(/^paths = .*$/m, "paths = ['''^psa-hiring/.*$''']"),
      "paths must list exactly one",
    ],
    [
      "disabled defaults",
      (t: string) => t.replace("useDefault = true", "useDefault = false"),
      "useDefault = true is required",
    ],
    [
      "global allowlist",
      (t: string) => `${t}\n[allowlist]\npaths = ['''.*''']\n`,
      "global [allowlist]",
    ],
    [
      "regex allowlist",
      (t: string) => `${t}regexes = ['''.*''']\n`,
      "regexes is not allowed",
    ],
  ])("rejects %s", (_label, mutate, message) => {
    const problems = validateGitleaksConfig(mutate(repoConfig), "2026-10-06");
    expect(problems.some((p) => p.includes(message))).toBe(true);
  });
});

describe("artifact-guard", () => {
  it.each([
    ".env.local",
    "test-results/storage-state.json",
    "playwright/.auth/user.json",
    "coverage/app.js.map",
    "dump/psa.sql",
  ])("rejects prohibited file %s", (file) => {
    expect(checkArtifactFile(file, "")).not.toEqual([]);
  });

  it("rejects text containing a synthetic canary or real-data pattern, naming only the rule", () => {
    const problems = checkArtifactFile(
      "playwright-report/index.html",
      `<p>${canaries.password}</p>`,
    );
    expect(problems.map((p) => p.reason)).toEqual(["synthetic canary present"]);
    expect(JSON.stringify(problems).includes("9f3c2a")).toBe(false);
  });

  it("accepts ordinary synthetic report files", () => {
    expect(
      checkArtifactFile("coverage/index.html", "<h1>All files 83%</h1>"),
    ).toEqual([]);
    expect(checkArtifactFile("test-results/trace.zip")).toEqual([]);
  });
});

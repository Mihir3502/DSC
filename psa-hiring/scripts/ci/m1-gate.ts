import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

// `pnpm test:m1:gate` — the M1 exit gate (packet M1.7 §24). Runs every
// required stage in order from a controlled clean state and stops at the
// first failure. Test stages use JSON reporters so the gate also fails on
// any skipped, todo, flaky, or missing critical test (packet §6, §23), not
// only on failures. Evidence (counts, durations, versions, identifiers;
// never secrets, logs, or test output) is written to the ignored
// .local/m1-gate/<run>.json for docs/reports/M1_EXIT_GATE.md.

const root = path.resolve(import.meta.dirname, "../..");
const runId = new Date().toISOString().replace(/[:.]/g, "-");
const outDir = path.join(root, ".local/m1-gate", runId);
mkdirSync(outDir, { recursive: true });

type Stage = Readonly<{
  name: string;
  command: string;
  args: readonly string[];
  env?: Record<string, string>;
  /** Parses a JSON report written by the stage, if any. */
  report?: { kind: "vitest" | "playwright"; file: string; minTests: number };
}>;

type StageResult = {
  name: string;
  status: "passed" | "failed";
  durationMs: number;
  counts?: Record<string, number>;
  problem?: string;
};

const vitest = (
  name: string,
  projects: string[],
  extra: string[],
  minTests: number,
): Stage => {
  const file = path.join(outDir, `${name}.json`);
  return {
    name,
    command: "pnpm",
    args: [
      "exec",
      "vitest",
      "run",
      ...projects.flatMap((p) => ["--project", p]),
      ...extra,
      "--reporter=default",
      "--reporter=json",
      `--outputFile.json=${file}`,
    ],
    report: { kind: "vitest", file, minTests },
  };
};

const playwright = (name: string, script: string, minTests: number): Stage => {
  const file = path.join(outDir, `${name}.json`);
  return {
    name,
    command: "pnpm",
    args: [script, "--reporter=list,json,html"],
    env: { PLAYWRIGHT_JSON_OUTPUT_NAME: file },
    report: { kind: "playwright", file, minTests },
  };
};

const stages: readonly Stage[] = [
  { name: "install", command: "pnpm", args: ["install", "--frozen-lockfile"] },
  { name: "security", command: "pnpm", args: ["test:security"] },
  { name: "data-guard", command: "pnpm", args: ["test:data-guard"] },
  { name: "critical-guard", command: "pnpm", args: ["test:critical-guard"] },
  { name: "format", command: "pnpm", args: ["format:check"] },
  { name: "lint", command: "pnpm", args: ["lint"] },
  { name: "typecheck", command: "pnpm", args: ["typecheck"] },
  { name: "auth-schema", command: "pnpm", args: ["auth:schema:check"] },
  { name: "migration-drift", command: "pnpm", args: ["db:check-drift"] },
  vitest(
    "unit-component-coverage",
    ["unit", "component"],
    ["--coverage"],
    2500,
  ),
  vitest("integration", ["integration"], [], 250),
  { name: "build", command: "pnpm", args: ["build"] },
  { name: "routes", command: "pnpm", args: ["test:routes"] },
  playwright("e2e-critical", "test:e2e:critical", 30),
  playwright("accessibility", "test:a11y", 15),
  {
    name: "artifact-guard-coverage",
    command: "pnpm",
    args: ["test:artifact-guard", "coverage"],
  },
  {
    name: "artifact-guard-playwright",
    command: "pnpm",
    args: ["test:artifact-guard", "playwright-report", "test-results"],
  },
  { name: "whitespace", command: "git", args: ["diff", "--check"] },
];

function parseReport(stage: Stage): {
  counts: Record<string, number>;
  problem?: string;
} {
  const spec = stage.report!;
  if (!existsSync(spec.file))
    return { counts: {}, problem: "missing JSON report" };
  const data = JSON.parse(readFileSync(spec.file, "utf8"));
  if (spec.kind === "vitest") {
    const counts = {
      files: data.numTotalTestSuites ?? 0,
      tests: data.numTotalTests ?? 0,
      passed: data.numPassedTests ?? 0,
      failed: data.numFailedTests ?? 0,
      skipped: data.numPendingTests ?? 0,
      todo: data.numTodoTests ?? 0,
    };
    if (counts.failed > 0) return { counts, problem: "failed tests" };
    if (counts.skipped + counts.todo > 0)
      return { counts, problem: "skipped or todo tests" };
    if (counts.tests < spec.minTests)
      return {
        counts,
        problem: "fewer tests than the gate requires (missing suite?)",
      };
    return { counts };
  }
  const stats = data.stats ?? {};
  const counts = {
    passed: stats.expected ?? 0,
    failed: stats.unexpected ?? 0,
    skipped: stats.skipped ?? 0,
    flaky: stats.flaky ?? 0,
  };
  if (counts.failed > 0) return { counts, problem: "failed tests" };
  if (counts.skipped > 0) return { counts, problem: "skipped tests" };
  if (counts.flaky > 0)
    return { counts, problem: "flaky tests (passed only on retry)" };
  if (counts.passed < spec.minTests)
    return {
      counts,
      problem: "fewer tests than the gate requires (missing suite?)",
    };
  return { counts };
}

function capture(command: string, args: string[]): string {
  const r = spawnSync(command, args, { cwd: root, encoding: "utf8" });
  return (r.stdout ?? "").trim().split("\n")[0] ?? "";
}

/**
 * The git tree ID of psa-hiring/ exactly as tested (tracked + untracked,
 * excluding ignored files), via a temporary index so the real index is
 * untouched. Compare with `git rev-parse <commit>:psa-hiring` later.
 */
function testedTree(): string {
  const gitDir = capture("git", ["rev-parse", "--absolute-git-dir"]);
  const tmpIndex = path.join(outDir, "index.tmp");
  const env = { ...process.env, GIT_INDEX_FILE: tmpIndex };
  spawnSync("cp", [path.join(gitDir, "index"), tmpIndex]);
  spawnSync("git", ["add", "-A", "."], { cwd: root, env });
  const tree = spawnSync("git", ["write-tree", "--prefix=psa-hiring/"], {
    cwd: root,
    env,
    encoding: "utf8",
  });
  rmSync(tmpIndex, { force: true });
  return (tree.stdout ?? "").trim();
}

function sha256(file: string): string {
  return createHash("sha256")
    .update(readFileSync(path.join(root, file)))
    .digest("hex");
}

function main() {
  // Controlled clean state: no build, report, or coverage output survives.
  for (const dir of [
    ".next",
    "coverage",
    "test-results",
    "playwright-report",
  ]) {
    rmSync(path.join(root, dir), { recursive: true, force: true });
  }
  const journal = JSON.parse(
    readFileSync(path.join(root, "drizzle/meta/_journal.json"), "utf8"),
  );
  const evidence = {
    runId,
    startedAt: new Date().toISOString(),
    commit: capture("git", ["rev-parse", "HEAD"]),
    workingTreeClean:
      capture("git", ["status", "--porcelain", "--", "."]) === "",
    testedTree: testedTree(),
    lockfileSha256: sha256("pnpm-lock.yaml"),
    lastMigration: journal.entries.at(-1)?.tag,
    versions: {
      node: process.version,
      pnpm: capture("pnpm", ["--version"]),
      playwright: capture("pnpm", ["exec", "playwright", "--version"]),
      postgresImage: "postgres:18.6-trixie",
    },
    stages: [] as StageResult[],
    status: "BLOCKED" as "PASS" | "BLOCKED",
  };

  for (const stage of stages) {
    const started = Date.now();
    console.log(`\n=== m1-gate: ${stage.name}`);
    const result = spawnSync(stage.command, stage.args as string[], {
      cwd: root,
      stdio: "inherit",
      env: { ...process.env, ...stage.env },
    });
    const durationMs = Date.now() - started;
    const entry: StageResult = {
      name: stage.name,
      status: "passed",
      durationMs,
    };
    if (stage.report) {
      const parsed = parseReport(stage);
      entry.counts = parsed.counts;
      if (parsed.problem) entry.problem = parsed.problem;
    }
    if (result.status !== 0 || entry.problem) {
      entry.status = "failed";
      entry.problem ??= `exit status ${result.status ?? "signal"}`;
    }
    evidence.stages.push(entry);
    if (entry.status === "failed") {
      console.error(
        `m1-gate: stage "${stage.name}" failed (${entry.problem}).`,
      );
      break;
    }
  }

  const passed =
    evidence.stages.length === stages.length &&
    evidence.stages.every((s) => s.status === "passed");
  evidence.status = passed ? "PASS" : "BLOCKED";
  const file = path.join(root, ".local/m1-gate", `${runId}.json`);
  writeFileSync(
    file,
    JSON.stringify(
      { ...evidence, finishedAt: new Date().toISOString() },
      null,
      2,
    ) + "\n",
  );
  console.log(
    `\nm1-gate ${evidence.status}: evidence written to ${path.relative(root, file)}`,
  );
  process.exitCode = passed ? 0 : 1;
}

main();

import { execFile, execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

// Secret scan of the full git history with Gitleaks (MIT), run from the
// official image pinned by immutable digest. No network, read-only mount,
// redacted output, and only rule/file/line/commit are printed. It scans the
// history reachable from the checked-out commit and fails unless Gitleaks
// reports scanning every one of those commits that carries a text patch, so
// a git ownership or checkout problem can never pass as "no leaks found".
// Gitleaks scans `git log -p` patches, so a commit whose only changes are
// binary files (no text patch) is never counted by it; it is excluded from
// the expected count too, and is still covered because no text exists in it.

export const GITLEAKS_IMAGE =
  "zricethezav/gitleaks@sha256:c00b6bd0aeb3071cbcb79009cb16a60dd9e0a7c60e2be9ab65d25e6bc8abbb7f"; // v8.30.1

export type Finding = {
  RuleID: string;
  File: string;
  StartLine: number;
  Commit: string;
};

/** Extracts the scanned-commit count from Gitleaks log output. */
export function scannedCommits(log: string): number | undefined {
  const match = log.match(/(\d+) commits? scanned/);
  return match ? Number(match[1]) : undefined;
}

/**
 * Counts commits with at least one text (non-binary) change, from
 * `git log --format=@@%H --numstat` output. Binary files show as "-\t-".
 */
export function textCommitCount(numstatLog: string): number {
  let count = 0;
  for (const block of numstatLog.split(/^@@[0-9a-f]{40}$/m).slice(1)) {
    const text = block.split("\n").some((line) => /^\d+\t\d+\t/.test(line));
    if (text) count += 1;
  }
  return count;
}

/** Summarizes findings without any secret material. */
export function summarize(findings: Finding[]): string[] {
  return findings.map(
    (f) =>
      `${f.RuleID} ${f.File}:${f.StartLine} (commit ${f.Commit.slice(0, 8)})`,
  );
}

/**
 * Enforces the allowlist policy for `.gitleaks.toml` (docs/CI.md): the default
 * rules stay enabled, and every `[[allowlists]]` entry targets exactly one
 * rule, commit, and anchored file path (condition AND) with fingerprint,
 * owner, approver, reason, and an unexpired review-by date. Returns problems
 * (empty when compliant). A missing file is compliant (no exceptions).
 */
export function validateGitleaksConfig(
  text: string | undefined,
  today: string,
): string[] {
  if (text === undefined) return [];
  const problems: string[] = [];
  if (!/^\s*useDefault\s*=\s*true\s*$/m.test(text))
    problems.push("[extend] useDefault = true is required");
  if (/^\s*\[allowlist\]\s*$/m.test(text))
    problems.push("global [allowlist] tables are not allowed");
  if (/^\s*disabledRules\s*=/m.test(text))
    problems.push("disabledRules is not allowed");
  if (/^\s*\[\[rules\]\]\s*$/m.test(text))
    problems.push("custom [[rules]] are not allowed");

  const blocks = text.split(/^\s*\[\[allowlists\]\]\s*$/m).slice(1);
  blocks.forEach((block, index) => {
    const label = `allowlist #${index + 1}`;
    const meta = (key: string) =>
      block.match(new RegExp(`^#\\s*${key}:\\s*(\\S.*)$`, "m"))?.[1].trim();
    for (const key of ["fingerprint", "owner", "approver", "reason"]) {
      if (!meta(key)) problems.push(`${label}: missing "${key}" metadata`);
    }
    const review = meta("review-by");
    if (!review || !/^\d{4}-\d{2}-\d{2}$/.test(review))
      problems.push(`${label}: missing or invalid "review-by" date`);
    else if (review < today)
      problems.push(`${label}: review-by date ${review} has passed`);
    if (!/^condition\s*=\s*"AND"\s*$/m.test(block))
      problems.push(`${label}: condition must be "AND"`);
    const single = (key: string, pattern: RegExp) => {
      const value = block.match(
        new RegExp(`^${key}\\s*=\\s*\\[(.*)\\]\\s*$`, "m"),
      )?.[1];
      const items = value?.split(",").map((item) => item.trim()) ?? [];
      if (items.length !== 1 || !pattern.test(items[0]))
        problems.push(`${label}: ${key} must list exactly one valid entry`);
    };
    single("targetRules", /^"[a-z0-9-]+"$/);
    single("commits", /^"[0-9a-f]{40}"$/);
    single("paths", /^'''\^[^*]+\$'''$/);
    for (const key of ["regexes", "stopwords"]) {
      if (new RegExp(`^${key}\\s*=`, "m").test(block))
        problems.push(`${label}: ${key} is not allowed`);
    }
  });
  return problems;
}

const run = promisify(execFile);

async function main() {
  const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: import.meta.dirname,
    encoding: "utf8",
  }).trim();
  const configPath = path.join(repoRoot, ".gitleaks.toml");
  const configProblems = validateGitleaksConfig(
    existsSync(configPath) ? readFileSync(configPath, "utf8") : undefined,
    new Date().toISOString().slice(0, 10),
  );
  if (configProblems.length > 0) {
    throw new Error(
      `.gitleaks.toml violates the allowlist policy: ${configProblems.join("; ")}`,
    );
  }
  const expected = textCommitCount(
    execFileSync(
      "git",
      ["log", "--format=@@%H", "--numstat", "--no-renames", "HEAD"],
      { cwd: repoRoot, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
    ),
  );
  const { uid, gid } = os.userInfo();
  const args = [
    "run",
    "--rm",
    "--network",
    "none",
    "--user",
    `${uid}:${gid}`,
    "-e",
    "GIT_CONFIG_COUNT=1",
    "-e",
    "GIT_CONFIG_KEY_0=safe.directory",
    "-e",
    "GIT_CONFIG_VALUE_0=/repo",
    "-v",
    `${repoRoot}:/repo:ro`,
    GITLEAKS_IMAGE,
    "git",
    "/repo",
    "--log-opts",
    "HEAD",
    "--redact",
    "--no-banner",
    "--log-level",
    "info",
    "--report-format",
    "json",
    "--report-path",
    "/dev/stdout",
  ];

  let stdout = "";
  let stderr = "";
  let leaks = false;
  try {
    ({ stdout, stderr } = await run("docker", args, {
      maxBuffer: 32 * 1024 * 1024,
    }));
  } catch (error) {
    const e = error as {
      code?: number | string;
      stdout?: string;
      stderr?: string;
    };
    if (e.code === "ENOENT")
      throw new Error("docker is not available; the secret scan cannot run");
    stdout = e.stdout ?? "";
    stderr = e.stderr ?? "";
    if (e.code !== 1)
      throw new Error(`gitleaks did not complete (exit ${String(e.code)})`);
    leaks = true;
  }

  const scanned = scannedCommits(stderr);
  if (scanned === undefined || scanned !== expected) {
    throw new Error(
      `gitleaks scanned ${scanned ?? "an unknown number of"} commit(s) but the repository has ${expected} with text changes; refusing to pass`,
    );
  }

  const findings: Finding[] = stdout.trim()
    ? (JSON.parse(stdout) as Finding[])
    : [];
  if (leaks || findings.length > 0) {
    console.error(
      `secret-scan failed: ${findings.length} potential secret(s) (values redacted):`,
    );
    for (const line of summarize(findings)) console.error(`  ${line}`);
    console.error(
      "Treat each as real until reviewed; see docs/CI.md for the exception and rotation procedure.",
    );
    process.exitCode = 1;
    return;
  }
  console.log(
    `secret-scan passed (gitleaks v8.30.1, ${scanned} commit(s) scanned, no leaks).`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  main().catch((error: unknown) => {
    console.error(`secret-scan: ${(error as Error).message}`);
    process.exitCode = 1;
  });
}

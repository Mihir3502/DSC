import { execFile, execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

// Secret scan of the full git history with Gitleaks (MIT), run from the
// official image pinned by immutable digest. No network, read-only mount,
// redacted output, and only rule/file/line/commit are printed. It scans the
// history reachable from the checked-out commit and fails unless Gitleaks
// reports scanning every one of those commits, so a git ownership or
// checkout problem can never pass as "no leaks found".

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

/** Summarizes findings without any secret material. */
export function summarize(findings: Finding[]): string[] {
  return findings.map(
    (f) =>
      `${f.RuleID} ${f.File}:${f.StartLine} (commit ${f.Commit.slice(0, 8)})`,
  );
}

const run = promisify(execFile);

async function main() {
  const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: import.meta.dirname,
    encoding: "utf8",
  }).trim();
  const expected = Number(
    execFileSync("git", ["rev-list", "--count", "HEAD"], {
      cwd: repoRoot,
      encoding: "utf8",
    }).trim(),
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
      `gitleaks scanned ${scanned ?? "an unknown number of"} commit(s) but the repository has ${expected}; refusing to pass`,
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

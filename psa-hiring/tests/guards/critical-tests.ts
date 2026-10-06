import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

// Fails when committed critical browser tests (tests/e2e, tests/accessibility)
// contain focused tests or unapproved skip/fixme markers. A skip is approved
// only when the same line carries `approved-skip:` with an issue reference.
// Vitest projects additionally run with `allowOnly: false`.

export type MarkerFinding = { file: string; line: number; marker: string };

const marker =
  /\b(?:test|it|describe|test\.describe)\.(only|skip|fixme)\s*\(|\b(?:test|it|describe)\.(only|skip|fixme)\b/g;

/** Scans a critical test file for focus/skip markers. Pure; no I/O. */
export function scanForMarkers(file: string, text: string): MarkerFinding[] {
  const findings: MarkerFinding[] = [];
  text.split("\n").forEach((content, index) => {
    const code = content.replace(/\/\/.*$/, "");
    for (const match of code.matchAll(marker)) {
      const kind = match[1] ?? match[2];
      if (kind !== "only" && /approved-skip:\s*\S+/.test(content)) continue;
      findings.push({ file, line: index + 1, marker: `.${kind}` });
    }
  });
  return findings;
}

export const criticalScope = [
  "tests/e2e/**/*.ts",
  "tests/accessibility/**/*.ts",
];

function main() {
  const root = path.resolve(import.meta.dirname, "../..");
  const files = execFileSync(
    "git",
    [
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "--",
      ...criticalScope.map((glob) => `:(glob)${glob}`),
    ],
    { cwd: root, encoding: "utf8" },
  )
    .split("\n")
    .filter(Boolean);
  const findings = files.flatMap((file) =>
    scanForMarkers(file, readFileSync(path.join(root, file), "utf8")),
  );
  if (files.length === 0) {
    console.error("test:critical-guard found no critical test files to check.");
    process.exitCode = 1;
    return;
  }
  if (findings.length > 0) {
    console.error(
      `test:critical-guard found ${findings.length} focused/skipped critical test(s):`,
    );
    for (const f of findings)
      console.error(`  ${f.file}:${f.line}  ${f.marker}`);
    process.exitCode = 1;
    return;
  }
  console.log(
    `test:critical-guard passed (${files.length} critical test files checked).`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  main();
}

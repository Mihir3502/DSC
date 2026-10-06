import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { scanForCanaries } from "../../tests/guards/data-canary";

// Runs before any CI artifact upload. Fails if an artifact directory contains
// a prohibited file type or text containing a synthetic canary, real-data
// pattern, or secret-shaped value. Reports file names and rule names only.

const forbiddenName =
  /(^\.env)|(\.(sqlite3?|db|dump|sql|pem|key|p12|map)$)|(storage-?state)|(^auth[\w.-]*\.json$)|(^cookies?\.json$)/i;
const forbiddenDir = /^(\.auth|\.local|node_modules|\.next)$/;
const textExtension =
  /\.(json|html?|txt|md|xml|log|csv|lcov|info|js|css|svg)$/i;
const CANARY_TAG = "TESTCANARY";

export type ArtifactProblem = { file: string; reason: string };

export function checkArtifactFile(
  relativePath: string,
  content?: string,
): ArtifactProblem[] {
  const problems: ArtifactProblem[] = [];
  const name = path.basename(relativePath);
  const segments = relativePath.split(/[\\/]/);
  if (forbiddenName.test(name))
    problems.push({ file: relativePath, reason: "prohibited file type" });
  if (segments.some((s) => forbiddenDir.test(s)))
    problems.push({ file: relativePath, reason: "prohibited directory" });
  if (content !== undefined) {
    if (content.includes(CANARY_TAG))
      problems.push({ file: relativePath, reason: "synthetic canary present" });
    for (const finding of scanForCanaries(relativePath, content)) {
      problems.push({ file: relativePath, reason: finding.rule });
    }
  }
  return problems;
}

function walk(dir: string, root: string, out: ArtifactProblem[]) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const rel = path.relative(root, full);
    if (statSync(full).isDirectory()) {
      if (forbiddenDir.test(entry))
        out.push({ file: rel, reason: "prohibited directory" });
      else walk(full, root, out);
      continue;
    }
    const content = textExtension.test(entry)
      ? readFileSync(full, "utf8")
      : undefined;
    out.push(...checkArtifactFile(rel, content));
  }
}

function main() {
  const root = path.resolve(import.meta.dirname, "../..");
  const dirs = process.argv.slice(2);
  if (dirs.length === 0) {
    console.error("artifact-guard: pass the artifact directories to check");
    process.exitCode = 1;
    return;
  }
  const problems: ArtifactProblem[] = [];
  for (const dir of dirs) {
    const full = path.resolve(root, dir);
    try {
      statSync(full);
    } catch {
      continue; // nothing to upload from this directory
    }
    walk(full, root, problems);
  }
  if (problems.length > 0) {
    console.error(
      `artifact-guard failed: ${problems.length} problem(s); nothing may be uploaded.`,
    );
    for (const p of problems.slice(0, 50))
      console.error(`  ${p.file}: ${p.reason}`);
    process.exitCode = 1;
    return;
  }
  console.log(`artifact-guard passed (${dirs.join(", ")}).`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  main();
}

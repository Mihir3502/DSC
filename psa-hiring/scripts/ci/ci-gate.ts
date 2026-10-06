import path from "node:path";

// Aggregate CI gate. GitHub passes `${{ toJSON(needs) }}` through the NEEDS
// environment variable (never interpolated into shell). The gate passes only
// when every required job concluded `success`; failure, cancellation, or a
// skip is a failed gate.

export type NeedsContext = Record<string, { result?: string }>;

export function evaluateGate(
  needs: NeedsContext,
  required: readonly string[],
): string[] {
  const problems: string[] = [];
  for (const job of required) {
    const result = needs[job]?.result;
    if (result !== "success") problems.push(`${job}: ${result ?? "missing"}`);
  }
  for (const job of Object.keys(needs)) {
    if (!required.includes(job))
      problems.push(`${job}: not in the required job list`);
  }
  return problems;
}

export const REQUIRED_JOBS = [
  "static-and-security",
  "unit-component-coverage",
  "database-integration",
  "build",
  "critical-e2e",
] as const;

function main() {
  let needs: NeedsContext;
  try {
    needs = JSON.parse(process.env.NEEDS ?? "") as NeedsContext;
  } catch {
    console.error("ci-gate: NEEDS is missing or not valid JSON");
    process.exitCode = 1;
    return;
  }
  const problems = evaluateGate(needs, REQUIRED_JOBS);
  if (problems.length > 0) {
    console.error("ci-gate failed:");
    for (const p of problems) console.error(`  ${p}`);
    process.exitCode = 1;
    return;
  }
  console.log(
    `ci-gate passed (${REQUIRED_JOBS.length} required jobs succeeded).`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  main();
}

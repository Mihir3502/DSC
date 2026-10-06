import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

// Dependency vulnerability gate (M0.6 §8.7). Policy: HIGH or CRITICAL
// advisories in production dependencies fail CI unless covered by a valid,
// unexpired exception in security/audit-exceptions.json. Advisories in
// development-only dependencies are printed for visibility but do not gate.
// Registry/scanner errors fail the check.

export const BLOCKING_SEVERITIES = new Set(["high", "critical"]);

export type Advisory = {
  ghsa: string;
  module: string;
  severity: string;
  paths: string[];
};

export type AuditException = {
  advisory: string;
  package: string;
  path: string;
  rationale: string;
  compensatingControl: string;
  owner: string;
  approvedBy: string;
  expires: string; // YYYY-MM-DD
};

type PnpmAuditJson = {
  advisories?: Record<
    string,
    {
      github_advisory_id?: string;
      module_name: string;
      severity: string;
      findings?: { paths?: string[] }[];
    }
  >;
  error?: unknown;
};

/** Normalizes `pnpm audit --json` output; throws on malformed output. */
export function parseAudit(json: string): Advisory[] {
  const data = JSON.parse(json) as PnpmAuditJson;
  if (data.error || !data.advisories || typeof data.advisories !== "object") {
    throw new Error("audit output did not contain an advisories object");
  }
  return Object.values(data.advisories).map((a) => ({
    ghsa: a.github_advisory_id ?? "unknown",
    module: a.module_name,
    severity: a.severity,
    paths: [...new Set((a.findings ?? []).flatMap((f) => f.paths ?? []))],
  }));
}

const requiredFields: (keyof AuditException)[] = [
  "advisory",
  "package",
  "path",
  "rationale",
  "compensatingControl",
  "owner",
  "approvedBy",
  "expires",
];

/** Validates exception records; returns problems (empty when valid). */
export function validateExceptions(
  exceptions: unknown,
  today: string,
): string[] {
  if (!Array.isArray(exceptions))
    return ["exceptions file must contain a JSON array"];
  const problems: string[] = [];
  exceptions.forEach((entry, index) => {
    const e = entry as Partial<AuditException>;
    for (const field of requiredFields) {
      if (typeof e[field] !== "string" || !e[field]?.trim()) {
        problems.push(`exception #${index + 1}: missing ${field}`);
      }
    }
    if (typeof e.expires === "string") {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(e.expires))
        problems.push(`exception #${index + 1}: expires must be YYYY-MM-DD`);
      else if (e.expires < today)
        problems.push(`exception #${index + 1}: expired on ${e.expires}`);
    }
  });
  return problems;
}

/** Returns blocking advisories not covered by a matching exception. */
export function blockingAdvisories(
  advisories: Advisory[],
  exceptions: AuditException[],
): Advisory[] {
  return advisories.filter((a) => {
    if (!BLOCKING_SEVERITIES.has(a.severity)) return false;
    const uncovered = a.paths.filter(
      (p) =>
        !exceptions.some(
          (e) =>
            e.advisory === a.ghsa && e.package === a.module && e.path === p,
        ),
    );
    return uncovered.length > 0 || a.paths.length === 0;
  });
}

const run = promisify(execFile);

async function audit(prodOnly: boolean): Promise<Advisory[]> {
  try {
    const { stdout } = await run(
      "pnpm",
      ["audit", "--json", ...(prodOnly ? ["--prod"] : [])],
      {
        maxBuffer: 32 * 1024 * 1024,
      },
    );
    return parseAudit(stdout);
  } catch (error) {
    // pnpm audit exits nonzero when advisories exist; its stdout is still JSON.
    const stdout = (error as { stdout?: string }).stdout ?? "";
    try {
      return parseAudit(stdout);
    } catch {
      throw new Error(
        "pnpm audit failed to return results (registry or scanner unavailable)",
      );
    }
  }
}

async function main() {
  const root = path.resolve(import.meta.dirname, "../..");
  const today = new Date().toISOString().slice(0, 10);
  const exceptions = JSON.parse(
    readFileSync(path.join(root, "security/audit-exceptions.json"), "utf8"),
  ) as unknown;
  const exceptionProblems = validateExceptions(exceptions, today);
  if (exceptionProblems.length > 0) {
    for (const p of exceptionProblems) console.error(`  ${p}`);
    console.error("dependency-audit: invalid or expired exception(s).");
    process.exitCode = 1;
    return;
  }

  const prod = await audit(true);
  const all = await audit(false);
  const prodIds = new Set(prod.map((a) => a.ghsa));
  for (const a of all.filter((x) => !prodIds.has(x.ghsa))) {
    console.log(
      `  info (dev only, not gating): ${a.severity} ${a.ghsa} ${a.module}`,
    );
  }

  const blocking = blockingAdvisories(prod, exceptions as AuditException[]);
  if (blocking.length > 0) {
    console.error(
      "dependency-audit failed: HIGH/CRITICAL advisories in production dependencies:",
    );
    for (const a of blocking)
      console.error(
        `  ${a.severity} ${a.ghsa} ${a.module} via ${a.paths[0] ?? "unknown path"}`,
      );
    process.exitCode = 1;
    return;
  }
  console.log(
    `dependency-audit passed (${prod.length} production advisory(ies), none HIGH/CRITICAL without a valid exception).`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  main().catch((error: unknown) => {
    console.error(`dependency-audit: ${(error as Error).message}`);
    process.exitCode = 1;
  });
}

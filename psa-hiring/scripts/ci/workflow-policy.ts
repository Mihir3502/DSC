import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { parse } from "yaml";

// Workflow-policy guard for .github/workflows (M0.6 §6, §14.1). Pure checks
// over the workflow text so they can be unit-tested with fixtures; the CLI
// runs them against the committed workflows.

export const MAX_ARTIFACT_RETENTION_DAYS = 14;
export const MAX_JOB_TIMEOUT_MINUTES = 60;
const ALLOWED_TRIGGERS = new Set(["pull_request", "push", "workflow_dispatch"]);
const ALLOWED_ARTIFACT_ROOTS = [
  "psa-hiring/coverage/",
  "psa-hiring/playwright-report/",
  "psa-hiring/test-results/",
];
const GATE_JOB = "ci-gate";

type Step = Record<string, unknown> & {
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
};
type Job = Record<string, unknown> & { steps?: Step[] };

export function checkWorkflowPolicy(
  text: string,
  defaultBranch = "main",
): string[] {
  const problems: string[] = [];
  const fail = (message: string) => problems.push(message);
  let doc: Record<string, unknown>;
  try {
    doc = parse(text) as Record<string, unknown>;
  } catch {
    return ["workflow is not valid YAML"];
  }
  if (!doc || typeof doc !== "object") return ["workflow is empty"];

  // Triggers.
  const on = doc.on as Record<string, unknown> | undefined;
  if (!on || typeof on !== "object" || Array.isArray(on)) {
    fail("`on` must be a mapping of approved triggers");
  } else {
    for (const trigger of Object.keys(on)) {
      if (!ALLOWED_TRIGGERS.has(trigger)) fail(`forbidden trigger: ${trigger}`);
    }
    for (const trigger of ["pull_request", "push"]) {
      const branches = (on[trigger] as { branches?: unknown } | undefined)
        ?.branches;
      if (
        !Array.isArray(branches) ||
        branches.length !== 1 ||
        branches[0] !== defaultBranch
      ) {
        fail(
          `${trigger} must target only the default branch (${defaultBranch})`,
        );
      }
    }
    const dispatch = on.workflow_dispatch as
      { inputs?: unknown } | null | undefined;
    if (dispatch && typeof dispatch === "object" && dispatch.inputs) {
      fail("workflow_dispatch must not define free-text inputs");
    }
  }

  // Permissions: exactly contents: read at the top; jobs may only narrow.
  const top = doc.permissions as Record<string, unknown> | undefined;
  if (!top || JSON.stringify(top) !== JSON.stringify({ contents: "read" })) {
    fail("top-level permissions must be exactly { contents: read }");
  }

  // Concurrency cancellation.
  const concurrency = doc.concurrency as
    { group?: unknown; "cancel-in-progress"?: unknown } | undefined;
  if (!concurrency?.group || concurrency["cancel-in-progress"] !== true) {
    fail("concurrency group with cancel-in-progress: true is required");
  }

  if (/\$\{\{\s*secrets\./.test(text)) fail("secrets.* must not be referenced");
  if (/\bcontinue-on-error\s*:\s*true/.test(text))
    fail("continue-on-error: true is forbidden");
  if (/\bpull_request_target\b|\bworkflow_run\b/.test(text))
    fail("pull_request_target/workflow_run are forbidden");

  // Every external action pinned to a full SHA with a release-tag comment.
  for (const line of text.split("\n")) {
    const match = line.match(/^\s*-?\s*uses:\s*([^\s#]+)\s*(#\s*(\S+))?/);
    if (!match) continue;
    const [, ref, , tag] = match;
    if (ref.startsWith("./")) continue;
    if (ref.startsWith("docker://")) {
      if (!/@sha256:[0-9a-f]{64}$/.test(ref))
        fail(`docker action not pinned by digest: ${ref}`);
      continue;
    }
    if (!/^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/.test(ref))
      fail(`action not pinned to a full commit SHA: ${ref}`);
    if (!tag || !/^v\d/.test(tag))
      fail(`action pin missing a reviewed release-tag comment: ${ref}`);
  }

  // Production/staging configuration (env/with values and env assignments in
  // run commands; step names may describe the production *build*).
  const configValues: string[] = [];
  const collectConfig = (map: unknown) => {
    if (map && typeof map === "object") {
      for (const [key, value] of Object.entries(map))
        configValues.push(`${key}=${String(value)}`);
    }
  };
  collectConfig(doc.env);
  for (const job of Object.values((doc.jobs ?? {}) as Record<string, Job>)) {
    collectConfig(job.env);
    for (const step of job.steps ?? []) {
      collectConfig(step.env);
      collectConfig(step.with);
      if (typeof step.run === "string") {
        configValues.push(
          ...(step.run.match(/\b(APP_ENV|NODE_ENV|PROVIDER_MODE)=\S+/g) ?? []),
        );
      }
    }
  }
  if (
    configValues.some((v) => /\b(production|staging|prod|stage)\b/i.test(v))
  ) {
    fail("workflow must not reference production or staging configuration");
  }
  for (const url of text
    .replace(/#.*$/gm, "")
    .match(/https?:\/\/[^\s"'`)]+/g) ?? []) {
    if (!/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/.test(url)) {
      fail(`non-loopback URL in workflow: ${new URL(url).host}`);
    }
  }
  if (
    /\b(DATABASE(_MIGRATION|_ADMIN)?_URL|AWS_[A-Z_]+|[A-Z_]*(TOKEN|API_KEY|PASSWORD|SECRET))\s*:/.test(
      text,
    )
  ) {
    fail(
      "workflow env must not define database URLs or credential-shaped variables",
    );
  }

  // Jobs.
  const jobs = (doc.jobs ?? {}) as Record<string, Job>;
  const names = Object.keys(jobs);
  if (names.length === 0) fail("workflow defines no jobs");
  for (const [name, job] of Object.entries(jobs)) {
    const runsOn = String(job["runs-on"] ?? "");
    if (!/^ubuntu-[\w.]+$/.test(runsOn))
      fail(`${name}: must run on a GitHub-hosted ubuntu runner`);
    const timeout = job["timeout-minutes"];
    if (
      typeof timeout !== "number" ||
      timeout <= 0 ||
      timeout > MAX_JOB_TIMEOUT_MINUTES
    ) {
      fail(`${name}: timeout-minutes must be 1–${MAX_JOB_TIMEOUT_MINUTES}`);
    }
    if (job.environment !== undefined)
      fail(`${name}: deployment environments are forbidden`);
    if (job.if === false || job.if === "false")
      fail(`${name}: job is disabled`);
    const perms = job.permissions;
    if (perms !== undefined) {
      const values =
        perms && typeof perms === "object" ? Object.values(perms) : [perms];
      if (values.some((v) => v !== "read" && v !== "none"))
        fail(`${name}: job permissions must be read or none`);
    }
    const steps = job.steps ?? [];
    for (const step of steps) {
      if (step.uses?.startsWith("actions/checkout@")) {
        if (
          step.with?.ref !== undefined ||
          step.with?.repository !== undefined
        ) {
          fail(`${name}: checkout must not select another ref or repository`);
        }
        if (step.with?.["persist-credentials"] !== false) {
          fail(`${name}: checkout must set persist-credentials: false`);
        }
      }
      if (
        typeof step.run === "string" &&
        /\$\{\{\s*(github\.event\.|github\.head_ref|inputs\.)/.test(step.run)
      ) {
        fail(`${name}: run step interpolates untrusted event text`);
      }
      if (step.uses?.startsWith("actions/upload-artifact@")) {
        const days = Number(step.with?.["retention-days"]);
        if (
          !Number.isInteger(days) ||
          days < 1 ||
          days > MAX_ARTIFACT_RETENTION_DAYS
        ) {
          fail(
            `${name}: artifact retention-days must be 1–${MAX_ARTIFACT_RETENTION_DAYS}`,
          );
        }
        const artifactName = String(step.with?.name ?? "");
        if (
          /\$\{\{\s*(github\.event\.|github\.head_ref|github\.ref_name|inputs\.)/.test(
            artifactName,
          )
        ) {
          fail(`${name}: artifact name must not contain untrusted text`);
        }
        const paths = String(step.with?.path ?? "")
          .split("\n")
          .map((p) => p.trim())
          .filter(Boolean);
        for (const p of paths) {
          if (
            !ALLOWED_ARTIFACT_ROOTS.some((root) => p.startsWith(root)) ||
            p.includes("..") ||
            /\.env|auth|\.map$/i.test(p)
          ) {
            fail(`${name}: artifact path not allowed: ${p}`);
          }
        }
        if (step.with?.["include-hidden-files"] === true)
          fail(`${name}: hidden files must not be uploaded`);
      }
    }
    const usesPnpm = steps.some(
      (s) => typeof s.run === "string" && /\bpnpm\b/.test(s.run),
    );
    if (
      usesPnpm &&
      !steps.some(
        (s) =>
          typeof s.run === "string" &&
          s.run.includes("pnpm install --frozen-lockfile"),
      )
    ) {
      fail(`${name}: must install with pnpm install --frozen-lockfile`);
    }
  }

  // Aggregate gate.
  const gate = jobs[GATE_JOB];
  if (!gate) {
    fail(`aggregate job "${GATE_JOB}" is required`);
  } else {
    if (typeof gate.if !== "string" || !gate.if.includes("always()"))
      fail(`${GATE_JOB} must run with if: always()`);
    const needs = Array.isArray(gate.needs) ? gate.needs : [gate.needs];
    for (const name of names.filter((n) => n !== GATE_JOB)) {
      if (!needs.includes(name)) fail(`${GATE_JOB} must depend on ${name}`);
    }
  }
  return problems;
}

function main() {
  const repoRoot = path.resolve(import.meta.dirname, "../../..");
  const dir = path.join(repoRoot, ".github", "workflows");
  let files: string[] = [];
  try {
    files = readdirSync(dir).filter((f) => /\.ya?ml$/.test(f));
  } catch {
    // reported below
  }
  if (files.length === 0) {
    console.error(
      "workflow-policy: no workflow files found in .github/workflows",
    );
    process.exitCode = 1;
    return;
  }
  let failed = 0;
  for (const file of files) {
    const problems = checkWorkflowPolicy(
      readFileSync(path.join(dir, file), "utf8"),
    );
    for (const problem of problems) console.error(`  ${file}: ${problem}`);
    failed += problems.length;
  }
  if (failed > 0) {
    console.error(`workflow-policy failed with ${failed} violation(s).`);
    process.exitCode = 1;
    return;
  }
  console.log(`workflow-policy passed (${files.length} workflow file(s)).`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  main();
}

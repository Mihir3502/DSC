import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { checkWorkflowPolicy } from "./workflow-policy";

// Each case mutates the committed workflow text in memory and expects the
// guard to report the specific violation. Nothing is written to disk.

const workflow = readFileSync(
  path.resolve(import.meta.dirname, "../../../.github/workflows/ci.yml"),
  "utf8",
);

function mutate(find: string | RegExp, replace: string): string {
  const next = workflow.replace(find, replace);
  if (next === workflow)
    throw new Error(`mutation did not apply: ${String(find)}`);
  return next;
}

describe("workflow policy", () => {
  it("accepts the committed workflow", () => {
    expect(checkWorkflowPolicy(workflow)).toEqual([]);
  });

  it.each([
    [
      "pull_request_target trigger",
      mutate("  pull_request:\n", "  pull_request_target:\n"),
      /forbidden trigger: pull_request_target/,
    ],
    [
      "scheduled trigger",
      mutate(
        "  workflow_dispatch:\n",
        "  workflow_dispatch:\n  schedule:\n    - cron: '0 3 * * *'\n",
      ),
      /forbidden trigger: schedule/,
    ],
    [
      "non-default branch",
      mutate(
        "  push:\n    branches: [main]",
        "  push:\n    branches: [main, develop]",
      ),
      /push must target only the default branch/,
    ],
    [
      "dispatch inputs",
      mutate(
        "  workflow_dispatch:\n",
        "  workflow_dispatch:\n    inputs:\n      note:\n        type: string\n",
      ),
      /must not define free-text inputs/,
    ],
    [
      "write permission",
      mutate(
        "permissions:\n  contents: read",
        "permissions:\n  contents: write",
      ),
      /top-level permissions must be exactly/,
    ],
    [
      "job write permission",
      mutate(
        "    runs-on: ubuntu-24.04\n    timeout-minutes: 20\n",
        "    runs-on: ubuntu-24.04\n    timeout-minutes: 20\n    permissions:\n      pull-requests: write\n",
      ),
      /job permissions must be read or none/,
    ],
    [
      "floating action tag",
      mutate(
        /actions\/checkout@[0-9a-f]{40} # v7\.0\.1/,
        "actions/checkout@v7 # v7.0.1",
      ),
      /not pinned to a full commit SHA: actions\/checkout@v7/,
    ],
    [
      "branch-pinned action",
      mutate(/pnpm\/action-setup@[0-9a-f]{40}/, "pnpm/action-setup@main"),
      /not pinned to a full commit SHA/,
    ],
    [
      "pin without release comment",
      mutate(/(actions\/setup-node@[0-9a-f]{40}) # v7\.0\.0/, "$1"),
      /missing a reviewed release-tag comment/,
    ],
    [
      "missing timeout",
      mutate("    timeout-minutes: 15\n", ""),
      /timeout-minutes must be 1–60/,
    ],
    [
      "excessive timeout",
      mutate("timeout-minutes: 25", "timeout-minutes: 600"),
      /timeout-minutes must be 1–60/,
    ],
    [
      "no cancellation",
      mutate("cancel-in-progress: true", "cancel-in-progress: false"),
      /cancel-in-progress: true is required/,
    ],
    [
      "self-hosted runner",
      mutate(
        "    name: build\n    runs-on: ubuntu-24.04",
        "    name: build\n    runs-on: self-hosted",
      ),
      /GitHub-hosted ubuntu runner/,
    ],
    [
      "secret reference",
      mutate(
        'NEXT_TELEMETRY_DISABLED: "1"',
        'NEXT_TELEMETRY_DISABLED: "1"\n  DEPLOY_KEY: ${{ secrets.DEPLOY_KEY }}',
      ),
      /secrets\.\* must not be referenced/,
    ],
    [
      "continue-on-error",
      mutate(
        "        run: pnpm test:integration",
        "        run: pnpm test:integration\n        continue-on-error: true",
      ),
      /continue-on-error: true is forbidden/,
    ],
    [
      "deployment environment",
      mutate(
        "    name: build\n",
        "    name: build\n    environment: production\n",
      ),
      /deployment environments are forbidden/,
    ],
    [
      "production configuration",
      mutate(
        'NEXT_TELEMETRY_DISABLED: "1"',
        'NEXT_TELEMETRY_DISABLED: "1"\n  APP_ENV: production',
      ),
      /production or staging configuration/,
    ],
    [
      "external URL",
      mutate(
        'NEXT_TELEMETRY_DISABLED: "1"',
        'NEXT_TELEMETRY_DISABLED: "1"\n  API_BASE: https://api.psa-agency.example.com',
      ),
      /non-loopback URL in workflow: api\.psa-agency\.example\.com/,
    ],
    [
      "database URL env",
      mutate(
        'NEXT_TELEMETRY_DISABLED: "1"',
        'NEXT_TELEMETRY_DISABLED: "1"\n  DATABASE_URL: postgresql://127.0.0.1/db',
      ),
      /database URLs or credential-shaped variables/,
    ],
    [
      "retention above bound",
      mutate(
        "retention-days: 7\n          if-no-files-found: error",
        "retention-days: 30\n          if-no-files-found: error",
      ),
      /retention-days must be 1–14/,
    ],
    [
      "missing retention",
      mutate(
        "          retention-days: 7\n          if-no-files-found: ignore",
        "          if-no-files-found: ignore",
      ),
      /retention-days must be 1–14/,
    ],
    [
      "prohibited artifact path",
      mutate(
        "          path: psa-hiring/coverage/",
        "          path: psa-hiring/.env.local",
      ),
      /artifact path not allowed/,
    ],
    [
      "untrusted artifact name",
      mutate(
        "name: coverage-${{ github.run_id }}",
        "name: coverage-${{ github.head_ref }}",
      ),
      /artifact name must not contain untrusted text/,
    ],
    [
      "untrusted run interpolation",
      mutate(
        "        run: pnpm build",
        '        run: echo "${{ github.event.pull_request.title }}" && pnpm build',
      ),
      /interpolates untrusted event text/,
    ],
    [
      "checkout of another ref",
      mutate(
        "        with:\n          persist-credentials: false\n      - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0\n        with:\n          node-version-file: psa-hiring/.nvmrc\n      - uses: pnpm/action-setup@ea17c68df8912ef543352723c149a84f56e3d413 # v6.1.0\n        with:\n          package_json_file: psa-hiring/package.json\n          cache: true\n          cache_dependency_path: psa-hiring/pnpm-lock.yaml\n      - name: Install (frozen lockfile)\n        run: pnpm install --frozen-lockfile\n      - name: Unit",
        "        with:\n          persist-credentials: false\n          ref: main\n      - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0\n        with:\n          node-version-file: psa-hiring/.nvmrc\n      - uses: pnpm/action-setup@ea17c68df8912ef543352723c149a84f56e3d413 # v6.1.0\n        with:\n          package_json_file: psa-hiring/package.json\n          cache: true\n          cache_dependency_path: psa-hiring/pnpm-lock.yaml\n      - name: Install (frozen lockfile)\n        run: pnpm install --frozen-lockfile\n      - name: Unit",
      ),
      /checkout must not select another ref/,
    ],
    [
      "non-frozen install",
      mutate(
        "    name: build\n    runs-on: ubuntu-24.04\n    timeout-minutes: 15\n    steps:\n      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1\n        with:\n          persist-credentials: false\n      - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0\n        with:\n          node-version-file: psa-hiring/.nvmrc\n      - uses: pnpm/action-setup@ea17c68df8912ef543352723c149a84f56e3d413 # v6.1.0\n        with:\n          package_json_file: psa-hiring/package.json\n          cache: true\n          cache_dependency_path: psa-hiring/pnpm-lock.yaml\n      - name: Install (frozen lockfile)\n        run: pnpm install --frozen-lockfile",
        "    name: build\n    runs-on: ubuntu-24.04\n    timeout-minutes: 15\n    steps:\n      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1\n        with:\n          persist-credentials: false\n      - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0\n        with:\n          node-version-file: psa-hiring/.nvmrc\n      - uses: pnpm/action-setup@ea17c68df8912ef543352723c149a84f56e3d413 # v6.1.0\n        with:\n          package_json_file: psa-hiring/package.json\n          cache: true\n          cache_dependency_path: psa-hiring/pnpm-lock.yaml\n      - name: Install\n        run: pnpm install",
      ),
      /build: must install with pnpm install --frozen-lockfile/,
    ],
    [
      "disabled required job",
      mutate("    name: build\n", "    name: build\n    if: false\n"),
      /build: job is disabled/,
    ],
    [
      "gate missing a dependency",
      mutate("      - critical-e2e\n    runs-on", "    runs-on"),
      /ci-gate must depend on critical-e2e/,
    ],
    [
      "gate not always()",
      mutate("    if: always()\n", ""),
      /ci-gate must run with if: always\(\)/,
    ],
  ])("rejects %s", (_label, text, expected) => {
    const problems = checkWorkflowPolicy(text);
    expect(
      problems.some((p) => expected.test(p)),
      problems.join("\n"),
    ).toBe(true);
  });

  it("rejects invalid YAML", () => {
    expect(checkWorkflowPolicy("on: [unclosed")).toEqual([
      "workflow is not valid YAML",
    ]);
  });
});

# Continuous Integration

Workflow: [`.github/workflows/ci.yml`](../.github/workflows/ci.yml). Repository: `Mihir3502/DSC` on GitHub, default branch `main`. All commands run in `psa-hiring/`.

## Triggers and jobs

- **Triggers:** pull requests targeting `main`, pushes to `main`, and manual `workflow_dispatch` (no inputs). No schedule and no path filters.
- **Security model:** `permissions: contents: read`; `pull_request` only (never `pull_request_target`); no repository secrets or environments; GitHub-hosted `ubuntu-24.04` runners; checkout with `persist-credentials: false`. Fork pull requests run the same way.
- **Concurrency:** `ci-<workflow>-<PR number or ref>`. A newer commit cancels the older run for the same PR or ref.

| Job (check name) | Runs | Timeout |
|---|---|---|
| `static-and-security` | `test:secrets`, `test:data-guard`, `test:critical-guard`, `test:workflow-policy`, `format:check`, `lint`, `typecheck`, `auth:schema:check`, `db:check-drift`, `test:deps` | 15 min |
| `unit-component-coverage` | `test:coverage` (unit + component projects with V8 coverage), artifact guard, coverage upload | 15 min |
| `database-integration` | `test:integration` (migrations from empty, seed, UTC, least privilege) | 20 min |
| `build` | `build`, `test:routes` (built routes and Server Actions vs. the authorization manifest, plus a client-bundle scan for source maps and server-only authorization markers, M1.5) | 15 min |
| `critical-e2e` | `playwright install --with-deps chromium`, `test:e2e:critical`, `test:a11y` (each starts its own disposable PostgreSQL through Testcontainers) | 25 min |
| `ci-gate` | `if: always()`; fails unless all five jobs report `success` | 5 min |

There are no retries (Vitest and Playwright both use `retries: 0`) and no `continue-on-error`.

## Run the same checks locally

Prerequisites: Node 24.11.0, pnpm 12.9.1, a running Docker engine (for Testcontainers and the secret scan), and Chromium for Playwright (`pnpm exec playwright install chromium`).

```bash
pnpm install --frozen-lockfile
pnpm ci:local
```

`pnpm ci:local` runs, in order:

```text
test:security        = test:secrets && test:deps && test:workflow-policy
test:data-guard
test:critical-guard
format:check
lint
typecheck
auth:schema:check    (Better Auth schema vs. committed Drizzle schema)
db:check-drift       (schema vs. committed migrations)
test:coverage        (unit + component)
test:integration
build
test:routes          (built routes/actions vs. the authorization manifest)
test:e2e:critical
test:a11y
```

No `.env` file, Compose database, or volume is needed. Tests use only generated synthetic values.

| Packet name | Repository script |
|---|---|
| `guard:sensitive` | `test:data-guard` (plus `test:critical-guard` and `test:artifact-guard`) |
| `test:unit` + `test:component` + `test:coverage` | `test:coverage` in CI (`test:unit` and `test:component` exist for local use) |
| `test:security` | `test:security` |
| `db:test:migrations` | `test:integration` (migration-from-empty in a disposable database, including the M1.1–M1.3 auth tests and the M1.4 authorization tests) |
| route-manifest drift / architecture checks (M1.5) | `test:coverage` runs `tests/guards/authorization-boundaries.test.ts` (source tree vs. `src/app/_security/route-manifest.ts`, boundary scans with self-checks, production-config harness refusal); `test:routes` compares the production build |
| M1.6 audit suites (`test:audit`) | `test:coverage` runs `src/modules/audit/**` (catalog strictness, canonicalization golden vector, key ring, projection, no-mutation API); `test:integration` runs `tests/integration/audit/` (privilege attacks, immutability, atomic forced failures, idempotency, deterministic chain races, corruption detection through `audit:verify`, key rotation, synthetic `pg_dump`/`pg_restore` verification, migration from the M1.5 schema, and authorized query projection). `pnpm test:audit` runs both subsets locally |
| M1.7 gate (`test:m1:gate`) | `pnpm test:m1:gate` (`scripts/ci/m1-gate.ts`) runs, fail-fast from a clean state: frozen install, security/data/critical guards, format, lint, typecheck, Better Auth schema check, migration drift, unit+component with coverage, integration, build, route manifest, critical E2E, accessibility, and the artifact guards. Vitest/Playwright JSON reporters make it fail on any skipped, todo, flaky, missing, or failed critical test; evidence (counts, durations, versions, identifiers, never output) goes to the ignored `.local/m1-gate/<run>.json` and feeds `docs/reports/M1_EXIT_GATE.md` |
| `test:traceability` (M1.7) | `tests/guards/traceability.test.ts` plus `tests/authorization/m1-matrix-coverage.test.ts` (catalog/route/event/field/self-service drift against `tests/authorization/approved-grants.json`, missing or renamed test references, no-skip scan) |
| `test:m1:matrix` (M1.7) | The policy-level matrix (`tests/authorization/*.matrix.test.ts`, `tests/security/`) plus the PostgreSQL account-state, revocation, and event-coverage suites |
| catalog idempotence/drift | `test:integration` (`tests/integration/authorization/catalog.test.ts` runs the real `db:catalog:apply`/`db:catalog:check`) plus the unit catalog digest and `tests/guards/authorization-matrix.test.ts` matrix traceability |

### Test environment variables

CI defines only `NEXT_TELEMETRY_DISABLED=1`. `tests/e2e/support/run-with-database.ts` gives Playwright's production server the same disposable database settings, a fresh random `TEST-` auth secret, and `AUTH_EMAIL_TRANSPORT=capture-file` writing to a private temp directory (never under `test-results/` or `playwright-report/`). Traces are off for the candidate-auth specs; traces, screenshots, and videos are off for the staff-auth specs (setup keys and backup codes are on screen). M1.3 adds test-only `AUTH_STAFF_MFA_LOCKOUT_SECONDS=5` and `AUTH_STAFF_RECENT_AUTH_SECONDS=20` (rejected outside `APP_ENV=test`). The integration harness generates `APP_ENV=test`, `NODE_ENV=test`, and runtime, migration, and admin URLs pointing to its own container (for example `postgresql://psa_app:<generated>@127.0.0.1:<random-port>/psa_test_<run>_<label>`). Playwright's server receives `APP_ENV=test`. No developer `DATABASE_*` value is ever read.

## Disposable database isolation

`test:integration` starts its own `postgres:18.6-trixie` container through Testcontainers, labeled `psa-hiring.test-harness-run=<run>`. The container listens on `127.0.0.1` on a random port with random credentials. Each test file creates a `psa_test_<run>_*` database, runs the real `db:bootstrap:local` → `db:migrate` → `db:bootstrap:local` (and `db:catalog:apply` or `db:seed` where tested) against it, and drops only databases it created. The container is removed at the end, with Ryuk as a backup. See `psa-hiring/tests/integration/support/`.

## Artifacts

| Artifact | Contents | Uploaded | Retention |
|---|---|---|---|
| `coverage-<run_id>-<attempt>` | `psa-hiring/coverage/` (text summary, JSON summary, LCOV HTML of synthetic source) | After tests and the artifact guard pass | 7 days |
| `playwright-<run_id>-<attempt>` | `playwright-report/`, `test-results/` (traces, screenshots, videos of failed tests only) | Only when the E2E job fails **and** the artifact guard passes | 7 days |

`pnpm test:artifact-guard <dirs>` blocks the upload if it finds `.env*`, auth or storage state, cookies, database dumps, keys, source maps, `.local`, `node_modules`, `.next`, synthetic canaries, or real-data or secret patterns. Hidden files are never uploaded. Names use only the run ID and attempt number.

## Investigating a failure safely

- Read the failing step's output. Scripts print rule names, file paths, and counts, never secret or canary values.
- Download artifacts only from a failed run you're reviewing. Treat them as sensitive test evidence even though they're synthetic.
- Reproduce locally with the same script (`pnpm test:integration`, `pnpm test:e2e:critical`, and so on). Never add `env` dumps, `set -x`, or debug logging of request data to the workflow.

## Exception procedures

### Secret-scan findings

Gitleaks v8.30.1 runs from its official image pinned by digest, scanning the full history reachable from the tested commit with `--redact` and no network. The scan must report every reachable commit that has a text change. A commit that changes only binary files has no text patch, so Gitleaks does not count it; the expected count excludes it too (M2.1 baseline correction, approved 2026-10-07). Treat every finding as a real credential until proven otherwise: rotate it, remove it from reachable history following the incident process, then rerun. A false positive may be allowlisted only through a committed `.gitleaks.toml` entry that names the exact file, rule, and fingerprint, plus owner, reason, approver, and review date. Never disable rules or exclude whole directories. `pnpm test:secrets` enforces this before scanning: each `[[allowlists]]` entry must use `condition = "AND"` with exactly one rule, one full commit SHA, and one anchored file path, must carry `fingerprint`, `owner`, `approver`, `reason`, and `review-by` comments, and fails once its review date passes. Global allowlists, `regexes`, `stopwords`, `disabledRules`, and custom rules are refused.

Current entries (repository root [`.gitleaks.toml`](../.gitleaks.toml)):

| Fingerprint | Reason | Approver | Review by |
|---|---|---|---|
| `74632e3c…:psa-hiring/src/modules/identity-access/infrastructure/infrastructure.test.ts:generic-api-key:9` | Synthetic hex test value for the auth-config validator in the M1.1 commit; the literal was replaced by a runtime-built value afterwards | Project owner (2026-10-06) | 2027-01-06 |
| `52d78cdb…:docs/tasks/M1.6_APPEND_ONLY_AUDIT_FOUNDATION.md:generic-api-key:266` | Prose list of prohibited data categories in the M1.6 task packet that matches the generic-api-key heuristic; not a credential | Project owner (2026-10-07) | 2027-01-07 |

### Dependency advisories

Policy (approved 2026-10-06): HIGH or CRITICAL advisories in **production** dependencies fail CI. Advisories in development-only dependencies are printed but don't gate. Registry or scanner errors fail the check. A temporary exception goes in `psa-hiring/security/audit-exceptions.json`:

```json
[
  {
    "advisory": "GHSA-xxxx-xxxx-xxxx",
    "package": "package-name",
    "path": ".>parent>package-name",
    "rationale": "why the vulnerable code path is not reachable",
    "compensatingControl": "what limits the risk",
    "owner": "name",
    "approvedBy": "name",
    "expires": "YYYY-MM-DD"
  }
]
```

Every field is required. Exceptions match only the exact advisory, package, and path, and CI fails once the expiry date passes. The file is currently empty.

**Known dev-only advisories (non-gating):** GHSA-vfj7-8cjw-p6xm (`braces`, no fix yet, via `eslint-config-next` and the `shadcn` CLI) and GHSA-67mh-4wv8-2f99 (`esbuild` 0.18, via `drizzle-kit`). Review them when fixes are released.

## Branch protection (manual, not configured)

Branch protection is **not** configured by this work. Once the check names have stayed stable through a few runs, a repository administrator should protect `main`, require pull requests, and make **`ci-gate`** a required status check. Do not document it as active until an administrator has configured and verified it.

## Known limitations and deferred coverage

- Chromium only. Firefox, WebKit, mobile, nightly, and release-candidate matrices are deferred (`TEST_STRATEGY.md` §31, §37).
- No coverage threshold yet (`TEST_STRATEGY.md` §38).
- No license-policy check, SBOM, provenance, or container scanning (not yet approved).
- The E2E job builds the app itself through Playwright's `webServer`; it doesn't reuse the `build` job's output across jobs.
- Gitleaks scans history reachable from the tested commit, not other branches.

# PSA Workforce Hiring System

Web application for managing hiring and compliance readiness for a Kentucky private-pay Personal Services Agency.

Release 1 covers candidate intake through **Ready for Assignment**. Scheduling, visit tracking, timesheets, payroll, billing, and leave are out of scope. See [`CLAUDE.md`](../CLAUDE.md) for the full scope.

> **Current state: M1.5 route, object, and field authorization** on top of M1.4 roles and scopes and M1.3 staff invitation and multifactor authentication. Candidates can register (email-verified with a single-use code), sign in and out, recover and reset a password, change their password, and manage their own sessions (M1.2). Invitation-only staff activate with a password plus a mandatory authenticator app (TOTP) and one-time backup codes, sign in with password plus a second factor, and manage only their own account security (M1.3). Staff have no roles, permissions, or record access until M1.4–M1.5. Local email goes to Mailpit only. The foundation also provides local PostgreSQL and Mailpit, a Drizzle migration workflow, a layered automated test suite, and structured logging with correlation IDs and safe error handling. Besides the `auth` schema there is one technical table (`app.system_metadata`) and no business data. CI runs on every pull request and push to `main`.

## Prerequisites

- Node.js **24.11.0** (LTS), pinned in [`.nvmrc`](.nvmrc). With nvm: `nvm use`.
- pnpm **12.9.1**, pinned in the `packageManager` field of [`package.json`](package.json). Install that exact version with the pnpm installer (no admin rights needed):

  ```bash
  curl -fsSL https://get.pnpm.io/install.sh | env PNPM_VERSION=12.9.1 sh -
  ```

  Then open a new terminal. Alternatively, `npm install -g pnpm@12.9.1` (prefix with `sudo` if npm's global folder is owned by root).

- Docker Engine or Docker Desktop with the Compose v2 plugin. Check with `docker --version` and `docker compose version`. If Docker Desktop is installed but `docker` is not found, enable the command-line tools in Docker Desktop → Settings → Advanced, then open a new terminal.

The Next.js application (and the future worker) run directly on your machine. Docker runs only PostgreSQL and Mailpit.

## Setup

Run all commands from this `psa-hiring/` directory.

```bash
pnpm install --frozen-lockfile

# Create your local environment file. -n never overwrites an existing file.
cp -n .env.example .env.local
# Then set BETTER_AUTH_SECRET in .env.local to the output of: openssl rand -hex 32

pnpm local:setup        # create the private .local/documents directory
pnpm infra:up           # start PostgreSQL and Mailpit and wait until healthy
pnpm infra:check        # verify both services
pnpm config:check       # validate .env.local
pnpm db:bootstrap:local # create/grant the local database roles (idempotent)
pnpm db:migrate         # apply committed migrations
pnpm db:bootstrap:local # again: grants on tables the migrations just created
pnpm db:catalog:apply   # apply the reviewed role/permission catalog (idempotent)
pnpm db:seed            # insert the technical seed record (idempotent)
pnpm db:check           # verify connection, UTC, schema, least privilege
pnpm dev
```

Open <http://localhost:3000>.

## Commands

| Command                   | Purpose                                                             |
| ------------------------- | ------------------------------------------------------------------- |
| `pnpm dev`                | Start the development server                                        |
| `pnpm build`              | Create a production build                                           |
| `pnpm start`              | Serve the production build                                          |
| `pnpm lint`               | Run ESLint                                                          |
| `pnpm typecheck`          | Generate route types and run strict TypeScript                      |
| `pnpm format`             | Format files with Prettier                                          |
| `pnpm format:check`       | Check formatting without writing                                    |
| `pnpm config:check`       | Validate `.env.local` against the server configuration schema       |
| `pnpm local:setup`        | Create the private local document directory (never deletes)         |
| `pnpm infra:up`           | Start PostgreSQL and Mailpit in the background and wait for health  |
| `pnpm infra:status`       | Show service status and health                                      |
| `pnpm infra:check`        | Verify PostgreSQL readiness/port and Mailpit `/readyz`              |
| `pnpm infra:logs`         | Follow PostgreSQL and Mailpit logs (Ctrl+C to stop)                 |
| `pnpm infra:down`         | Stop the services. **Database data is preserved.**                  |
| `pnpm db:bootstrap:local` | Create/grant local database roles; local/test only, never drops     |
| `pnpm db:generate`        | Generate a migration from TypeScript schema changes                 |
| `pnpm db:migrate`         | Apply committed migrations with the migration role                  |
| `pnpm db:seed`            | Insert/refresh the synthetic technical seed (idempotent)            |
| `pnpm db:check`           | Verify runtime connection, UTC, schema, and least privilege         |
| `pnpm db:verify-empty`    | Rebuild the schema in a temporary database to prove reproducibility |
| `pnpm db:catalog:apply`   | Apply the reviewed authorization catalog with the migration role    |
| `pnpm db:catalog:check`   | Read-only check that the database matches the authorization catalog |

`tsx` is a development dependency used only to run the TypeScript scripts in `scripts/`.

## Testing

All test data is synthetic. Tests never use your `.env.local`, never touch the Compose database, and never call third-party hosts.

| Command                    | What it runs                                                                                                |
| -------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `pnpm test`                | Unit and component tests once (no watch)                                                                    |
| `pnpm test:watch`          | Unit and component tests in watch mode                                                                      |
| `pnpm test:unit`           | Unit project only                                                                                           |
| `pnpm test:component`      | Component project only                                                                                      |
| `pnpm test:integration`    | Real PostgreSQL tests in a disposable Docker container (Docker must be running)                             |
| `pnpm test:coverage`       | Unit/component tests with V8 coverage in `coverage/`                                                        |
| `pnpm test:e2e`            | Playwright suite for the enabled browsers (Chromium by default)                                             |
| `pnpm test:e2e:critical`   | Critical Chromium journeys (foundation routes and candidate authentication) against a disposable PostgreSQL |
| `pnpm test:a11y`           | Chromium axe accessibility scans of the three routes                                                        |
| `pnpm test:data-guard`     | Fails if test/fixture files contain real-looking personal data or live secrets                              |
| `pnpm test:critical-guard` | Fails if critical browser tests are focused (`.only`) or skipped without approval                           |
| `pnpm test:foundation`     | All of the above in order: guards, coverage, integration, E2E, accessibility                                |
| `pnpm test:security`       | Secret scan (Gitleaks, Docker), production dependency audit, workflow policy                                |
| `pnpm ci:local`            | The exact CI sequence (see `docs/CI.md`)                                                                    |

First-time browser setup: `pnpm exec playwright install chromium`. To run Firefox and WebKit too (main/nightly), install them with `pnpm exec playwright install firefox webkit` and run `E2E_BROWSERS=chromium,firefox,webkit pnpm test:e2e`.

### Test projects

| Project       | Environment | Files                                                                   |
| ------------- | ----------- | ----------------------------------------------------------------------- |
| `unit`        | Node        | `src/**/*.test.ts`, `scripts/**/*.test.ts`, `tests/guards/**/*.test.ts` |
| `component`   | jsdom       | `src/**/*.test.tsx` (React Testing Library + user-event)                |
| `integration` | Node        | `tests/integration/**/*.test.ts`                                        |
| Playwright    | Chromium    | `tests/e2e/**/*.spec.ts`, `tests/accessibility/**/*.a11y.spec.ts`       |

- Unit and component tests fail on any network request. Focused tests (`.only`) fail every run, and there are no automatic retries locally.
- **Integration tests** start their own `postgres:18.6-trixie` container through Testcontainers on a random port with random test-only credentials. Each test file creates a `psa_test_<run>_*` database, runs the real `db:bootstrap:local`, `db:migrate`, and `db:seed` scripts against it, and drops only that database. The container is removed afterwards. Developer `DATABASE_*` variables are ignored.
- **Browser tests** build the app and serve it on `http://127.0.0.1:3100`. Any request to another host is blocked and fails the test, as do page or console errors. Reports go to `playwright-report/`; traces, screenshots, and videos are kept only for failures in `test-results/`.
- Shared synthetic fixture builders live in `tests/fixtures/`. Use reserved domains (`example.test`), `TEST` labels, and synthetic SSN ranges (area 000/666/9xx) only.
- Coverage covers `src/` and has no threshold yet; thresholds come with real domain code.

## Authentication (M1.1)

Better Auth stores accounts, credentials, sessions, and verification records in the PostgreSQL `auth` schema (see [`docs/adr/ADR-0002-AUTHENTICATION-PERSISTENCE.md`](../docs/adr/ADR-0002-AUTHENTICATION-PERSISTENCE.md)). The account type (candidate/staff/service) and status (invited/active/locked/disabled/closed) are server-owned. Generic sign-up is disabled (candidates register through the M1.2 flow below) and no accounts are seeded. Server code uses `resolveCurrentAccount` and the revoke/restrict primitives from `@/modules/identity-access`. `pnpm auth:schema:check` validates the auth schema with the pinned Better Auth CLI, and `pnpm db:check-drift` fails when the schema and committed migrations differ.

## Candidate registration and recovery (M1.2)

See [`docs/adr/ADR-0003-CANDIDATE-REGISTRATION-AND-RECOVERY.md`](../docs/adr/ADR-0003-CANDIDATE-REGISTRATION-AND-RECOVERY.md).

- **Pages:** `/register`, `/verify-email`, `/sign-in`, `/recover`, `/reset-password`, and `/candidate/security`. All of them run same-origin server actions; the `/api/auth` route forwards only `GET /get-session`.
- **Local email:** set `AUTH_EMAIL_TRANSPORT=smtp-local` (as in `.env.example`) and run `pnpm infra:up`. Verification codes and reset links then appear in Mailpit at <http://127.0.0.1:8025>. `pnpm auth:mailpit:check` sends every template to Mailpit and confirms it arrived.
- **Invitations:** `pnpm auth:intent:local test.someone@example.test` prints a single-use invitation link. It works only locally and only for reserved domains.
- **Browser tests:** `pnpm test:e2e*` and `pnpm test:a11y` start their own disposable PostgreSQL (Docker required). They capture email as files in a private temp directory and delete it afterwards. Traces are off for the candidate-auth specs because they handle one-time codes and links.

## Staff invitation and MFA (M1.3)

See [`docs/adr/ADR-0004-STAFF-INVITATION-MFA.md`](../docs/adr/ADR-0004-STAFF-INVITATION-MFA.md).

- **Pages:** `/staff/activate` (invitation link), `/staff/sign-in`, `/staff/mfa`, `/staff/recover`, `/staff/security`, and `/staff/reauthenticate`. Every staff account must use an authenticator app; there is no email/SMS code, no "trust this device", and no way to turn two-step verification off.
- **No production administration yet:** the application has no page or API to issue invitations or approve/complete a recovery. Those arrive with authorization and audit (M1.4–M1.6). There is no default staff or admin account.
- **Local invitation (local/test only):** `pnpm auth:staff:invite:local --reason=LOCAL_BOOTSTRAP test.someone@example.test` (or omit the email to be prompted). The invitation email goes to Mailpit; nothing is printed. Add `--revoke` to revoke the pending invitation. Run it again to resend (the earlier link stops working).
- **Activation:** open the Mailpit link, create a password, add the account to an authenticator app by QR code or setup key, enter a code, then save the 10 backup codes (shown once).
- **Local recovery harness (local/test only):** after `/staff/recover`, drive the case with `pnpm auth:staff:recovery:local --target=<staff email> --actor=<another staff email> --step=START_VERIFICATION|CONFIRM_IDENTITY|APPROVE|COMPLETE|REJECT|CANCEL`. The verifier and approver must be different people, and neither can be the target. Completion signs the staff member out everywhere, removes their authenticator and backup codes, and emails a reenrollment link.
- **Browser tests** use `--reason=TEST_HARNESS`, file-captured email, and test-only 5-second lockout and 20-second recent-authentication windows. Traces, screenshots, and videos are off for staff specs because pages show setup keys and backup codes.

## Roles, permissions, and scopes (M1.4)

Application authorization is separate from Better Auth (see [`docs/adr/ADR-0005-AUTHORIZATION-POLICY-SCOPE-EVALUATION.md`](../docs/adr/ADR-0005-AUTHORIZATION-POLICY-SCOPE-EVALUATION.md)).

- **Catalog:** the nine controlled roles, the narrow `<resource>.<action>` permissions, and their grants live in one reviewed TypeScript manifest (`src/modules/identity-access/policy/`). `pnpm db:catalog:apply` writes it with the migration role as a deliberate deployment step after `db:migrate`; the application never seeds it at startup, and the runtime role can only read it. Re-running changes nothing. `pnpm db:catalog:check` fails on drift or tampering. Changing the catalog means bumping its version and digest (a unit test prints the new digest) and updating ADR-0005.
- **Decisions:** server code calls `authorize` (or `authorizeInTransaction` inside a protected command) from `@/modules/identity-access`. It returns an explicit `ALLOW`/`DENY` with a closed reason code, reading current account, session, assignment, catalog, scope, workflow, separation, and recent-authentication facts every time.
- **Fail closed until M2:** no organization, branch, team, assignment-set, audit-assignment, or candidacy records exist yet, so the default scope and ownership resolvers answer "unavailable". No assignment can be created and no business decision can allow in the running application. Candidates have no business access until M2 ownership exists.
- **No administration surface:** there is no page, API, or CLI to manage roles. Assignment commands exist for tests and later work items only; the bootstrap harness and synthetic resolvers refuse to run unless `APP_ENV=test`. There is no default user, administrator, or assignment.

## Route, object, and field authorization (M1.5)

See [`docs/adr/ADR-0011-ROUTE-OBJECT-FIELD-AUTHORIZATION.md`](../docs/adr/ADR-0011-ROUTE-OBJECT-FIELD-AUTHORIZATION.md).

- **Every server entry point is classified** in `src/app/_security/route-manifest.ts`: pages, layouts, Server Actions, Route Handler methods, the proxy, instrumentation, and local harnesses. `pnpm test` (the boundary guard) fails on unclassified or inconsistent entries; `pnpm build && pnpm test:routes` compares the production build with the manifest. Add a manifest entry with every new route or action.
- **Guards are conveniences:** the `(account)` route-group layouts send anonymous browsers to sign-in and show other audiences the same 404 as an unknown page. Each page and action calls its application query/command, which evaluates its self-service policy (`CANDIDATE_*`/`STAFF_*`) again from current account and session state.
- **Responses are exact projections** (`src/modules/identity-access/presentation/`): explicit field mapping, include/mask/status-only/omit/deny rules, a never-return key list, and strict schemas. Never spread a database, auth-library, or provider object into a response.
- **Inputs are exact:** each Server Action parses `formSchemas.<name>`; any unknown, repeated, file, or over-long field rejects the whole submission.
- **Redirects** go only through `safeRedirect()` to registered destinations (`src/shared/security/safe-redirect.ts`). **Caching:** protected paths are `private, no-store`.
- **No `/api/auth/*` endpoint is reachable** (every path is a 404); session state is server-side only.
- Reusable contracts for later milestones (scoped lists, documents, jobs, provider callbacks) exist with synthetic tests only; there is no business endpoint.

## Logging and errors

Server logs are JSON lines on stdout with an allowlisted set of fields. Every request gets an `x-correlation-id` response header, and error pages show that ID as the request reference. Route handlers should be wrapped with `withRouteHandler` so failures return `application/problem+json` without internal details. See [`docs/OPERATIONS.md`](../docs/OPERATIONS.md) for the field allowlist, forbidden data, and error codes.

## Local services

| Service    | Address                                           | Notes                                                   |
| ---------- | ------------------------------------------------- | ------------------------------------------------------- |
| PostgreSQL | `127.0.0.1:5432`, database `psa_hiring`           | User and password are in `.env.example` (local only)    |
| Mailpit    | SMTP `127.0.0.1:1025`, UI <http://127.0.0.1:8025> | Captures all mail locally; nothing is delivered outside |

- All ports bind to `127.0.0.1` only, so the services are not reachable from other machines.
- The database credentials are **local development defaults**. Never reuse them for staging, production, or any other system.
- `pnpm infra:down` stops the containers but keeps the `psa-hiring_postgres-data` volume, so your local data survives restarts. Mailpit messages are not kept.
- Uploaded documents in development go to `.local/documents`, which is ignored by Git and never served by the web app.

## Configuration

`.env.local` must define every variable in [`.env.example`](.env.example). `pnpm config:check` validates it with the same schema the application uses (`src/config/env-schema.ts`) and reports only variable names, never values.

| Variable                         | Rule                                                                  |
| -------------------------------- | --------------------------------------------------------------------- |
| `APP_ENV`                        | `local`, `test`, `staging`, or `production` (required, no default)    |
| `DATABASE_URL`                   | Runtime role URL (`psa_app` locally); required by the app             |
| `DATABASE_MIGRATION_URL`         | Migration role URL (`psa_migrator`); migration tools only             |
| `DATABASE_ADMIN_URL`             | Local admin URL (`psa_local`); bootstrap and verification only        |
| `DATABASE_POOL_MAX`              | Runtime pool size 1–20 (default 5)                                    |
| `DATABASE_CONNECTION_TIMEOUT_MS` | 500–30000 (default 5000)                                              |
| `DATABASE_IDLE_TIMEOUT_MS`       | 1000–300000 (default 10000)                                           |
| `SMTP_HOST`                      | Nonempty host                                                         |
| `SMTP_PORT`                      | Integer 1–65535                                                       |
| `SMTP_FROM`                      | Valid email; outside production it must use a reserved test domain    |
| `DOCUMENT_STORAGE_ROOT`          | Nonempty path; `pnpm local:setup` only accepts paths inside `.local/` |
| `PROVIDER_MODE`                  | `fake` or `production` (required, no default)                         |

With `APP_ENV=production`, validation fails if `PROVIDER_MODE=fake`, if the database or SMTP host is a loopback address, or if the document path is relative or under `.local`. The runtime check also fails if `DATABASE_URL` reuses the migration or admin role.

## Database

### Identities

| Identity       | Variable                 | Used by                                      | Can do                                                                 |
| -------------- | ------------------------ | -------------------------------------------- | ---------------------------------------------------------------------- |
| `psa_app`      | `DATABASE_URL`           | Web app and future worker                    | Read/write rows in `app` tables only. No DDL, no roles, no temp tables |
| `psa_migrator` | `DATABASE_MIGRATION_URL` | `pnpm db:migrate`, `db:verify-empty`         | Owns the `app` and `drizzle` schemas; creates and alters tables        |
| `psa_local`    | `DATABASE_ADMIN_URL`     | `pnpm db:bootstrap:local`, `db:verify-empty` | Local superuser from `compose.yaml`; creates roles and grants          |

The application only ever reads `DATABASE_URL`. Migration tools only read `DATABASE_MIGRATION_URL` and never fall back to `DATABASE_URL`. The bootstrap refuses to run unless `APP_ENV` is `local` or `test` and every URL points at a loopback host. New tables created by migrations automatically grant `psa_app` read/write access through default privileges.

### Migrations

- The TypeScript schema in `src/shared/database/schema/` plus the committed SQL and snapshots in `drizzle/` are the source of truth.
- Migrations **never run automatically**. `pnpm dev` and `pnpm start` do not touch the schema; run `pnpm db:migrate` deliberately.
- **`drizzle-kit push` is prohibited.** It changes a live database directly from the TypeScript schema without a reviewed, committed migration, so other environments could not reproduce the change.
- Never edit a migration that has been applied or accepted; add a new forward migration instead.

To change the schema:

1. Edit the TypeScript schema in `src/shared/database/schema/`.
2. Run `pnpm db:generate --name=<short_description>`.
3. Review the new SQL in `drizzle/` (no `DROP`, no data loss, no roles or secrets, only `app` objects) and commit it with the updated `drizzle/meta/` files.
4. Run `pnpm db:migrate`, then `pnpm db:verify-empty`.

### Empty-database verification

`pnpm db:verify-empty` creates a new database named `psa_verify_<random>` on the local server, applies the local grants and every committed migration, checks the schemas, table, columns, primary key, and privileges, applies a throwaway forward migration to prove default privileges, then drops **only the database it created**. It refuses any other target (including `psa_hiring`) and refuses non-local environments. Your normal database is never modified.

### Current schema

M0.3 contains technical metadata only: `app.system_metadata` (`key`, `value` JSONB, `created_at`, `updated_at`) holding a single `foundation.seed` record. M1.1–M1.3 add the identity tables in the `auth` schema. M1.4 adds `auth.role`, `auth.permission`, `auth.role_permission` (read-only to the runtime role), `auth.user_role_assignment` (insert plus lifecycle-column updates only, never deleted), and `auth.authorization_subject`. There are no organization, person, candidacy, audit, or other business tables.

## Troubleshooting

- **Port already in use.** Find the process with `lsof -nP -iTCP:5432 -sTCP:LISTEN` (or `1025`, `8025`) and stop it, or export `POSTGRES_HOST_PORT`, `MAILPIT_SMTP_HOST_PORT`, or `MAILPIT_UI_HOST_PORT` before `pnpm infra:up` and update `DATABASE_URL` / `SMTP_PORT` in `.env.local` to match.
- **Docker unavailable.** `Cannot connect to the Docker daemon` or `docker: command not found` means Docker Desktop is not running or its command-line tools are not on your PATH. Start Docker Desktop and wait until it reports that it is running.
- **Service unhealthy.** Run `pnpm infra:status` and `pnpm infra:logs` to see which service failed and why, then `pnpm infra:down` and `pnpm infra:up`.
- **`password authentication failed for user "psa_app"` (or `psa_migrator`).** The roles have not been created or their passwords differ from `.env.local`. Run `pnpm db:bootstrap:local`; it is safe to repeat and resets only those two roles' passwords to the values in `.env.local`.
- **`app.system_metadata is missing`.** Run `pnpm db:migrate`.
- **`permission denied` for the app role.** Expected for DDL. For data access, rerun `pnpm db:bootstrap:local` to reapply grants.
- **Bootstrap reports a schema owned by another role.** Follow the printed manual step. Do not delete the volume to fix role or permission problems; `pnpm infra:down` and normal database commands always keep your data.
- **Stale volume after an approved PostgreSQL major-version change.** A data volume created by an older major version will not start with a newer one. Only after the upgrade is approved, and only for disposable local data, remove the volume manually. **This permanently deletes your local database:**

  ```bash
  pnpm infra:down
  docker volume rm psa-hiring_postgres-data
  pnpm infra:up
  ```

## Routes

| Route                                                                   | Page                                              |
| ----------------------------------------------------------------------- | ------------------------------------------------- |
| `/`                                                                     | Public landing page                               |
| `/candidate`                                                            | Candidate Portal placeholder                      |
| `/staff`                                                                | Staff Portal placeholder                          |
| `/register`, `/verify-email`, `/sign-in`, `/recover`, `/reset-password` | Candidate authentication                          |
| `/candidate/security`                                                   | Candidate account security (signed-in candidates) |
| `/staff/activate`, `/staff/sign-in`, `/staff/mfa`, `/staff/recover`     | Staff activation and sign-in (M1.3)               |
| `/staff/security`, `/staff/reauthenticate`                              | Staff account security (MFA-complete staff only)  |

## Data rule

Use synthetic data only. Never put real personal, employment, medical, screening, identity, tax, or banking information in code, fixtures, screenshots, logs, or AI prompts.

## Telemetry

Next.js collects anonymous framework telemetry by default. To opt out on your machine, run `pnpm exec next telemetry disable` or set `NEXT_TELEMETRY_DISABLED=1`.

## Project documents

- [`CLAUDE.md`](../CLAUDE.md) — product scope and rules
- [`AGENTS.md`](../AGENTS.md) — agent workspace rules
- [`docs/IMPLEMENTATION_PLAN.md`](../docs/IMPLEMENTATION_PLAN.md) — milestones and work items
- [`docs/OPERATIONS.md`](../docs/OPERATIONS.md) — logging fields, correlation IDs, and the public error contract
- [`docs/CI.md`](../docs/CI.md) — CI workflow, local parity (`pnpm ci:local`), artifacts, and exception procedures
- [`docs/adr/ADR-0001-MODULAR-MONOLITH-FOUNDATION.md`](../docs/adr/ADR-0001-MODULAR-MONOLITH-FOUNDATION.md) — accepted foundation architecture

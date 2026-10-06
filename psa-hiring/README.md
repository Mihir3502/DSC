# PSA Workforce Hiring System

Web application for managing hiring and compliance readiness for a Kentucky private-pay Personal Services Agency.

Release 1 covers candidate intake through **Ready for Assignment**. Scheduling, visit tracking, timesheets, payroll, billing, and leave are out of scope. See [`CLAUDE.md`](../CLAUDE.md) for the full scope.

> **Current state: M0.2 local infrastructure.** Placeholder pages plus local PostgreSQL and Mailpit. No database tables exist yet and the application does not send email. The database schema, authentication, tests, logging, and CI arrive in later M0 work items.

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

pnpm config:check   # validate .env.local
pnpm local:setup    # create the private .local/documents directory
pnpm infra:up       # start PostgreSQL and Mailpit and wait until healthy
pnpm infra:check    # verify both services
pnpm dev
```

Open <http://localhost:3000>.

## Commands

| Command                 | Purpose                                                             |
| ----------------------- | ------------------------------------------------------------------- |
| `pnpm dev`              | Start the development server                                        |
| `pnpm build`            | Create a production build                                           |
| `pnpm start`            | Serve the production build                                          |
| `pnpm lint`             | Run ESLint                                                          |
| `pnpm typecheck`        | Generate route types and run strict TypeScript                      |
| `pnpm format`           | Format files with Prettier                                          |
| `pnpm format:check`     | Check formatting without writing                                    |
| `pnpm config:check`     | Validate `.env.local` against the server configuration schema       |
| `pnpm config:selfcheck` | Run the configuration and path-safety assertions (synthetic values) |
| `pnpm local:setup`      | Create the private local document directory (never deletes)         |
| `pnpm infra:up`         | Start PostgreSQL and Mailpit in the background and wait for health  |
| `pnpm infra:status`     | Show service status and health                                      |
| `pnpm infra:check`      | Verify PostgreSQL readiness/port and Mailpit `/readyz`              |
| `pnpm infra:logs`       | Follow PostgreSQL and Mailpit logs (Ctrl+C to stop)                 |
| `pnpm infra:down`       | Stop the services. **Database data is preserved.**                  |

`tsx` is a development dependency used only to run the TypeScript scripts in `scripts/`.

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

| Variable                | Rule                                                                  |
| ----------------------- | --------------------------------------------------------------------- |
| `APP_ENV`               | `local`, `test`, `staging`, or `production` (required, no default)    |
| `DATABASE_URL`          | `postgres://` or `postgresql://` URL                                  |
| `SMTP_HOST`             | Nonempty host                                                         |
| `SMTP_PORT`             | Integer 1–65535                                                       |
| `SMTP_FROM`             | Valid email; outside production it must use a reserved test domain    |
| `DOCUMENT_STORAGE_ROOT` | Nonempty path; `pnpm local:setup` only accepts paths inside `.local/` |
| `PROVIDER_MODE`         | `fake` or `production` (required, no default)                         |

With `APP_ENV=production`, validation fails if `PROVIDER_MODE=fake`, if the database or SMTP host is a loopback address, or if the document path is relative or under `.local`.

## Troubleshooting

- **Port already in use.** Find the process with `lsof -nP -iTCP:5432 -sTCP:LISTEN` (or `1025`, `8025`) and stop it, or export `POSTGRES_HOST_PORT`, `MAILPIT_SMTP_HOST_PORT`, or `MAILPIT_UI_HOST_PORT` before `pnpm infra:up` and update `DATABASE_URL` / `SMTP_PORT` in `.env.local` to match.
- **Docker unavailable.** `Cannot connect to the Docker daemon` or `docker: command not found` means Docker Desktop is not running or its command-line tools are not on your PATH. Start Docker Desktop and wait until it reports that it is running.
- **Service unhealthy.** Run `pnpm infra:status` and `pnpm infra:logs` to see which service failed and why, then `pnpm infra:down` and `pnpm infra:up`.
- **Stale volume after an approved PostgreSQL major-version change.** A data volume created by an older major version will not start with a newer one. Only after the upgrade is approved, and only for disposable local data, remove the volume manually. **This permanently deletes your local database:**

  ```bash
  pnpm infra:down
  docker volume rm psa-hiring_postgres-data
  pnpm infra:up
  ```

## Routes

| Route        | Page                         |
| ------------ | ---------------------------- |
| `/`          | Public landing page          |
| `/candidate` | Candidate Portal placeholder |
| `/staff`     | Staff Portal placeholder     |

## Data rule

Use synthetic data only. Never put real personal, employment, medical, screening, identity, tax, or banking information in code, fixtures, screenshots, logs, or AI prompts.

## Telemetry

Next.js collects anonymous framework telemetry by default. To opt out on your machine, run `pnpm exec next telemetry disable` or set `NEXT_TELEMETRY_DISABLED=1`.

## Project documents

- [`CLAUDE.md`](../CLAUDE.md) — product scope and rules
- [`AGENTS.md`](../AGENTS.md) — agent workspace rules
- [`docs/IMPLEMENTATION_PLAN.md`](../docs/IMPLEMENTATION_PLAN.md) — milestones and work items

# PSA Workforce Hiring System

Web application for managing hiring and compliance readiness for a Kentucky private-pay Personal Services Agency.

Release 1 covers candidate intake through **Ready for Assignment**. Scheduling, visit tracking, timesheets, payroll, billing, and leave are out of scope. See [`CLAUDE.md`](../CLAUDE.md) for the full scope.

> **Current state: M0.1 foundation.** Only placeholder pages exist. Database, authentication, local infrastructure (Docker, PostgreSQL, Mailpit), tests, logging, and CI arrive in later M0 work items.

## Prerequisites

- Node.js **24.11.0** (LTS), pinned in [`.nvmrc`](.nvmrc). With nvm: `nvm use`.
- pnpm **12.9.1**, pinned in the `packageManager` field of [`package.json`](package.json). Install that exact version with `npm install -g pnpm@12.9.1` or the [pnpm installer](https://pnpm.io/installation).

## Setup

Run all commands from this `psa-hiring/` directory.

```bash
pnpm install --frozen-lockfile
pnpm dev
```

Open <http://localhost:3000>.

## Commands

| Command             | Purpose                                        |
| ------------------- | ---------------------------------------------- |
| `pnpm dev`          | Start the development server                   |
| `pnpm build`        | Create a production build                      |
| `pnpm start`        | Serve the production build                     |
| `pnpm lint`         | Run ESLint                                     |
| `pnpm typecheck`    | Generate route types and run strict TypeScript |
| `pnpm format`       | Format files with Prettier                     |
| `pnpm format:check` | Check formatting without writing               |

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

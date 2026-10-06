# ADR-0001 — Modular-Monolith Foundation

- **Status:** Accepted, pending recorded project approval (see Approvals)
- **Date:** 2026-10-06
- **Decision owners:** _Project owner — to be recorded_; _Technical lead — to be recorded_
- **Supersedes:** none

## Context

Release 1 of the PSA Workforce Hiring System covers one closely related domain, from candidate intake through **Ready for Assignment**, for a Kentucky private-pay Personal Services Agency. It handles restricted identity, financial, screening, and medical information. It needs transactional workflow, audit, and readiness gates, and it must run locally before any hosting provider is selected (`docs/ARCHITECTURE.md` §1–2, §14). Release 1 excludes scheduling, EVV, payroll, billing, and leave (`CLAUDE.md`).

Milestone M0 (work items M0.1–M0.6) built and verified the engineering foundation. This ADR records the architecture that foundation implements and the components selected for later milestones.

## Decision

Build a **modular monolith** in one strict-TypeScript repository.

| Concern | Decision | Status |
|---|---|---|
| Application | One Next.js 16 App Router app (`psa-hiring/`), React 19, strict TypeScript, Tailwind CSS + shadcn/ui | **Implemented** (M0.1) |
| Package/runtime | pnpm 12.9.1 (`packageManager`), Node.js 24.11.0 LTS (`.nvmrc`), frozen lockfile | **Implemented** |
| Configuration | Zod-validated runtime, migration, and local-bootstrap schemas; fail-closed production rules | **Implemented** (M0.2–M0.3) |
| Database | PostgreSQL 18, schemas `app` and `drizzle`; least-privilege roles `psa_app` (runtime) and `psa_migrator` (DDL); local admin `psa_local` | **Implemented** (M0.3) |
| Migrations | Drizzle ORM 0.45 + Drizzle Kit 0.31; code-first, reviewed SQL committed under `drizzle/`; `drizzle-kit push` prohibited; no auto-migration at startup | **Implemented** (M0.3) |
| Local services | Docker Compose: PostgreSQL and Mailpit on loopback only, named volume, health checks | **Implemented** (M0.2) |
| Testing | Vitest (unit, component with RTL/jsdom, integration with Testcontainers PostgreSQL), Playwright Chromium + axe, data/critical-skip guards, V8 coverage | **Implemented** (M0.4) |
| Logging/errors | Pino behind an app-owned allowlisted logger, pre-serialization redaction, UUID correlation IDs via the Node-runtime proxy, closed RFC 9457 public errors, accessible error UI | **Implemented** (M0.5) |
| CI | GitHub Actions on the confirmed GitHub repository: read-only token, pinned actions, secret scan (Gitleaks), dependency audit, all M0 suites, aggregate gate | **Implemented** (M0.6); hosted run pending |
| Authentication | Better Auth with the Drizzle adapter; the application owns authorization | **Selected, planned for M1, not implemented** |
| Background jobs | `pg-boss` in a separate worker process on the same PostgreSQL, transactional outbox | **Selected, planned for later milestones, not implemented** |
| Forms | React Hook Form + Zod, with server-side revalidation | **Selected, not yet used** |
| Production hosting, cloud key management, providers | Undecided; provider-neutral ports required | **Deferred** |

### Module and layer boundaries

- Business modules live under `src/modules/<module>/` with `domain`, `application`, `infrastructure`, and `ui` layers. They communicate only through each module's `index.ts` public API (`ARCHITECTURE.md` §5–6, §12). None exist yet.
- `domain` imports no framework, ORM, auth, HTTP, or vendor code. `ui` never queries business tables.
- Shared technical primitives live in `src/shared/` (`database`, `logging`, `errors`, `http`). `src/shared/errors` stays framework-neutral.
- Enforced today by ESLint `no-restricted-imports`: UI code cannot import the database, the server logger, HTTP adapters, or server configuration, and shared errors cannot import framework, ORM, or app modules. `no-console` applies to `src/`. Per-module boundary rules will be added with the first business module.

### Topology

| Environment | Topology |
|---|---|
| Local | Next.js app on the host; PostgreSQL and Mailpit in Docker Compose on `127.0.0.1`; private `.local/documents` |
| Test | Vitest unit/component in-process (network blocked); integration against a Testcontainers PostgreSQL 18.6 container bound to `127.0.0.1` on a random port with random credentials, deleted after the run; Playwright against a production build on `127.0.0.1:3100` with third-party requests blocked |
| CI | GitHub-hosted `ubuntu-24.04` runners running the same scripts, with no repository secrets and no persistent services |
| Staging/production | Not provisioned (`ARCHITECTURE.md` §14) |

## Security and privacy consequences

- Separate database identities enforce least privilege; the runtime role cannot run DDL or manage roles.
- Synthetic data only, guarded by the data-canary and artifact guards. Logs carry only allowlisted fields.
- CI treats pull-request code as untrusted: `pull_request` only, `contents: read`, no secrets, artifacts kept 7 days.
- Restricted-data controls (field encryption, document storage, audit trail, authorization) are designed but **not yet implemented**. They arrive with the business milestones.

## Alternatives considered

Rejected or deferred in `ARCHITECTURE.md` §2:

- Microservices (rejected): distributed transactions and operational overhead before there is a need.
- Separate SPA plus API repository (rejected): duplicated types and pipelines.
- NoSQL primary store (rejected): workflow and audit data are relational.
- Redis queue (deferred): `pg-boss` on PostgreSQL is sufficient initially.
- Direct vendor SDK calls from business code (rejected): providers stay behind ports.

## Consequences

**Positive:** one language and deployment unit; transactional workflow, audit, and outbox; fast local setup; layered tests from day one; clear seams for extracting a service later.

**Negative:** module boundaries depend on lint rules and review rather than process isolation. One database means shared capacity and a careful migration discipline. Every route is now dynamically rendered (the M0.5 request reference), which costs some static-rendering performance.

## Revisit when

- A module needs independent scaling or deployment, or a separate team owns it.
- PostgreSQL-backed jobs cannot meet throughput or latency targets.
- The production hosting decision imposes constraints (runtime, regions, data location) that this topology cannot meet.
- Better Auth or Drizzle can no longer meet security, migration, or support requirements.

## References

`CLAUDE.md`, `AGENTS.md`, `docs/ARCHITECTURE.md`, `docs/SECURITY_AND_PRIVACY.md`, `docs/TEST_STRATEGY.md`, `docs/IMPLEMENTATION_PLAN.md`, `docs/OPERATIONS.md`, `docs/CI.md`, `docs/tasks/M0.1`–`M0.6`.

## Approvals

| Role | Name | Date |
|---|---|---|
| Project owner | _pending_ | |
| Technical lead | _pending_ | |

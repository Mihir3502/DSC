# ADR-0013 — Public Position Caching and Configuration Command Idempotency

- **Status:** Accepted, pending recorded project approval (see Approvals)
- **Date:** 2026-10-07
- **Work item:** M2.1 (`docs/tasks/M2.1_ORGANIZATION_BRANCH_POSITION_HIRING_CYCLE.md`)
- **Depends on:** ADR-0001, ADR-0002, ADR-0003, ADR-0005, ADR-0011, ADR-0012
- **Numbering:** ADR-0006–ADR-0010 are reserved (`docs/IMPLEMENTATION_PLAN.md` §22) and ADR-0011/0012 are taken. This decision takes the next free number.

## Context

M2.1 adds the first public business pages: `/positions` and `/positions/[positionId]`. It also adds the first business configuration commands. Two choices were not covered by an existing decision:

1. **Public caching.** ADR-0011 makes every protected page `private, no-store` and `force-dynamic`. No document defined a policy for public business data. The M2.1 packet allows short-lived public caching only for the exact public projection, with invalidation after publish/open/close/cancel/archive, and requires that application acceptance never depend on a cache or a background job.
2. **Command idempotency.** ADR-0012 already prevents duplicate audit rows for one `(target, new version)`. The M2.1 packet also requires a retried publish/open/close/cancel/archive (the same command key) to produce one effect and one event.

## Decisions

### 1. Public position projection cache

- **What is cached.** Only the public projection queries for the open-cycle list and for one cycle's public detail. They live in `src/modules/organization/infrastructure/public-position-cache.ts`. The cache uses the framework data cache (`unstable_cache`) with tags:
  - `public-positions`, the list;
  - `public-position:<publicReference>`, one detail.
- **Lifetime.** A 60-second backstop.
- **What is never cached.** Staff projections; anything derived from a session, cookie, or principal; drafts.
- **Pages.** The public pages remain `force-dynamic` and read no cookie or session. Their response carries `Cache-Control: public, max-age=0, must-revalidate`, so browsers and shared caches revalidate every request. The static-rendering guard on `src/app` (`force-static`, `revalidate =`, `"use cache"`) is unchanged.
- **Invalidation.** It happens only after the configuration transaction commits, through a `PublicPositionInvalidator` port. The Next.js adapter calls `updateTag` inside Server Actions and `revalidateTag(tag, { expire: 0 })` elsewhere.
  - **What triggers it:** publish, open, close, cancel, or archive of a cycle, and any status change of an organization, branch, team, or position.
  - **Rollback:** a rolled-back command invalidates nothing.
  - **If invalidation fails:** the failure is logged with a safe code only, and the 60-second lifetime bounds staleness.
- **Acceptance is never cached.** Whether a cycle is accepting applications is recomputed from the stored status, the window, and the trusted server clock on every request. At exactly `closes_at` the cycle stops accepting, even if the stored status is still `OPEN`. The start-application handoff and every staff command read the database directly, never the cache.

### 2. Configuration command keys

- Every staff configuration form carries a server-generated `commandKey` (a UUID).
- In the command's transaction, a receipt `(actor_account_id, command_key)` is inserted into `app.organization_command_receipt`. That table is append-only for the runtime role and refuses update and delete by trigger.
- A retried key for the same command and target returns the original result and appends no audit event.
- If the same key is used for a different command or target, the command is refused as a conflict.
- Competing commands with different keys still serialize through row locks and `expectedVersion`; the loser receives a stale-version result.

## Consequences

- Public pages can be served from the data cache without risking acceptance after the close boundary.
- Cache keys and tags contain only public references.
- Command receipts are configuration history. Their retention class follows M9.6.
- Moving to the Next.js `cacheComponents` model later requires a new decision.

## Alternatives considered

- **No public cache, rendering every request.** Simpler, but the packet asked for invalidated public caching. This remains an acceptable fallback: removing the cache wrapper is behavior-preserving.
- **CDN `s-maxage` on the page response.** Rejected. The CDN cannot be invalidated after commit from the application, and a cached page could keep showing an accepting call to action after close.
- **Idempotency by `expectedVersion` alone.** Rejected. A retried publish would be refused as stale instead of returning its original result, and the operator would not know whether it had applied.

## Approvals

| Role | Name | Date | Decision |
| --- | --- | --- | --- |
| Project owner | | 2026-10-07 | Approved the tagged public cache in the M2.1 planning session |
| Reviewer | | | |

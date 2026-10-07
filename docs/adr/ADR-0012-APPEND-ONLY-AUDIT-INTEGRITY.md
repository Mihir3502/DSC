# ADR-0012 — Append-Only Audit Integrity

- **Status:** Accepted, pending recorded project approval (see Approvals)
- **Date:** 2026-10-07
- **Work item:** M1.6 (`docs/tasks/M1.6_APPEND_ONLY_AUDIT_FOUNDATION.md`)
- **Depends on:** ADR-0001, ADR-0002, ADR-0003, ADR-0004, ADR-0005, ADR-0011
- **Numbering:** the M1.6 packet asks for "ADR-0004", but M1.3 already used that number. ADR-0006–ADR-0010 are reserved for later topics (`docs/IMPLEMENTATION_PLAN.md` §22). Following the ADR-0011 precedent and with project-owner approval (2026-10-07), this decision takes the next free number, ADR-0012.
- **Approved deviation:** the project owner approved the split atomicity model in §5 (2026-10-07). It applies because Better Auth commits some changes outside any application transaction.

## Context

Through M1.5, identity and authorization events went through a temporary `SecurityEventPort` that only wrote allowlisted log lines, after commit. That is not audit evidence. PRD-AUTH-007 and PRD-AUD-001/002, `ROLE_PERMISSION_MATRIX.md` §17, and `SECURITY_AND_PRIVACY.md` require:

- immutable, minimally disclosed, tamper-evident history;
- authorization-scoped history;
- for compliance-significant changes, history written atomically with the change.

This is a pre-production foundation, so there is no existing audit history to reconcile or backfill.

## Decisions

### 1. Three separate concerns

| Concern | Where | Behavior |
|---|---|---|
| Operational log | stdout JSON (M0.5) | Diagnostic and bounded. Never the audit trail, and never a fallback for it. |
| Security event | `audit.security_event` | Append-only and chained. Bounded authentication/abuse evidence: failed sign-in or MFA, rate limits, refusals. Never shown as business history. |
| Audit event | `audit.audit_event` | Append-only, chained, and authorization-scoped. Compliance-significant identity, access-control, configuration, restricted-access, and audit-access history. |

The catalog decides deterministically which stream each event belongs to. A small set of approved routine signals stays **telemetry**, as log lines only:

- registration requested;
- verification or recovery email sent;
- first-factor and MFA-challenge success (superseded by the durable sign-in event);
- policy unavailable.

`ROLE_PERMISSION_MATRIX.md` §17 allows summarized telemetry for routine events like these.

### 2. Envelope and versioned catalog

**Envelope.** One reviewed registry, `src/modules/audit/application/event-catalog.ts`, keys each event by `(name, version)`. Each definition declares:
- stream, category, and outcome;
- actor rule (subject, distinct actor, actor-or-system, or system);
- target type and the fact that supplies the target;
- required and allowed facts;
- idempotency and atomicity;
- projectable metadata keys.

**Registered names.** These are the existing stable M1 codes, unchanged, plus:
- `account.restricted` and `account.sessions_revoked_by_system`, which the M1.1 restriction primitives previously did not emit at all;
- `audit.query_executed`, `audit.query_denied`, and `audit.integrity_verification_failed`.

`staff.activation_started` was moved from telemetry to in-transaction audit, because it accompanies creating or re-crediting a staff account.

**Facts in, envelope out.** Emitters pass narrow, typed facts only: opaque UUID references, closed codes, integers, and the M1.4 `AllowDecision` effective authority. `prepareEvent()` rejects any of the following before a write:
- an unknown name or version;
- a fact the definition does not allow;
- a missing required fact;
- a malformed UUID, code, scope, or version pair;
- oversized metadata.

The server alone sets:
- actor type, outcome, category, action, target type, source, and retention class;
- the event ID and request ID;
- the time, which is trusted database `clock_timestamp()`, truncated to milliseconds;
- the partition and the integrity fields.

There is no generic `append(name, payload)`. A malformed correlation ID falls back to the server request ID rather than dropping required evidence.

**Metadata.** Metadata is built only from validated facts. Possible keys:

- `policy_version`;
- `affected_count`;
- `method_category` (PASSWORD/TOTP/BACKUP_CODE);
- `assigned_role_code` and `assigned_scope_type`;
- `filter_codes`;
- for security events, `permission_code` and `record_ref`.

There is no free text, email, name, IP, user agent, device fingerprint, token, cookie, header, body, URL, raw error, provider payload, or before/after snapshot. Change summaries use record versions: `previous_record_version` and `new_record_version`.

**References.** Organization and candidacy references are opaque UUIDs, with no foreign key until M2 creates those tables. Actor and account references use `ON DELETE RESTRICT` against `auth.user`, so account lifecycle can never cascade into history.

### 3. Append-only storage and privileges

**Ownership and schema privileges.**
- A dedicated `audit` schema is owned by the migration role.
- It has **no default privileges**: the `app` and `auth` defaults would otherwise give the runtime role UPDATE/DELETE on new tables.
- `REVOKE ALL … FROM PUBLIC` applies to the schema, its tables, and its functions.

**What the runtime role (`psa_app`) receives** (`scripts/db/lib/local-roles.ts`):
- `USAGE` on the schema.
- `EXECUTE` on exactly three reviewed `SECURITY DEFINER` functions: `claim_chain_head`, `append_audit_event`, and `append_security_event`. Each has a fixed `search_path = pg_catalog, pg_temp`, schema-qualified references, typed input (`jsonb_populate_record` into the table row type), and no dynamic SQL.
- Column-level `SELECT` on the projection columns of `audit_event` only.

**What it never receives:** INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, or TRIGGER on any audit table; any access to `security_event`, `chain_head`, integrity columns, or request IDs; or ownership.

**Triggers.**
- `BEFORE UPDATE OR DELETE` (row) and `BEFORE TRUNCATE` (statement) triggers reject changes to both event tables **for every role, including the owner**. This covers updates that change nothing.
- A guard trigger on `chain_head` allows only genesis inserts and +1 advances, and rejects deletion and truncation.

**Checks.** `pnpm db:check` and the production-like startup check (`assertAuditReadiness`, called from `instrumentation.ts`) fail on:
- runtime ownership;
- excess runtime privilege;
- missing or disabled triggers;
- a missing or invalid key ring.

**Application layer.** The runtime repository exposes only lock-head and append functions. There is no update, delete, repair, rehash, or export operation anywhere; an architecture test enforces this.

### 4. Tamper-evident integrity chain

**Partitions** are always derived on the server, never by a client:
- `ORG:<organizationId>` for organization-bound events (M2+);
- otherwise `IDENTITY:00–0f` or `SECURITY:00–0f`, chosen by the SHA-256 of the subject reference modulo 16.

This bounds the chain-head hot lock without inventing organizations.

**Head lock.** `claim_chain_head` creates the head at genesis on first use and locks it `FOR UPDATE` until the caller's transaction ends. The append function checks again that `sequence = head + 1` and `previous_hash = head.hash` (otherwise SQLSTATE `AU001`). It then inserts the row and advances the head in the same transaction. Only that partition's critical section is serialized; independent partitions append concurrently.

**Canonicalization v1.** `JSON.stringify` of a fixed-order array: a domain tag, the version, stream, partition, sequence, previous hash, key version, and every envelope field in a reviewed order. Null stays explicit, timestamps are millisecond ISO-8601 UTC, and metadata is key-sorted `[key, value]` pairs of primitives. This relies only on the deterministic output ECMA-262 specifies for these types; no custom canonical-JSON algorithm is used. A golden-vector test pins it.

**MAC.** HMAC-SHA256 (`node:crypto`) under a versioned key, compared with `timingSafeEqual`. Each row stores the key version, never the key. Hashes live only in their dedicated `bytea` columns and are never printed.

**Keys.**
- Configured as `AUDIT_INTEGRITY_KEYS=v1:<base64>,…` plus `AUDIT_INTEGRITY_ACTIVE_KEY_VERSION`.
- Local and test runs without configuration use one public, deterministic synthetic version, `t1`.
- Staging and production reject: a missing ring; `t*` versions or the synthetic key; keys shorter than 32 bytes or low-entropy; duplicate versions; a key reused across versions; a key equal to `BETTER_AUTH_SECRET`; and an unknown active version.
- Rotation adds a version and switches the active version. Old versions are retained for verification for the audit retention period.
- Keys are never stored in the database, repository, fixtures, logs, or artifacts.

**Verifier** (`pnpm audit:verify`).
- Connects with the migration identity, because the runtime cannot read integrity columns, in a `REPEATABLE READ, READ ONLY` transaction.
- Streams each partition in 500-row keyset batches.
- Detects modification, deletion, insertion, reordering, duplicate sequences or forks, gaps, unknown key versions, orphan partitions, and chain-head mismatches.
- Prints only counts and the first failing partition, sequence, and reason code.
- On failure it exits nonzero, logs a high-severity alert, and appends one `audit.integrity_verification_failed` security event through the normal runtime append path.
- It never repairs, rewrites, or rehashes anything.

### 5. Transaction boundary and the Better Auth atomicity limitation

`withAuditedTransaction(deps, async (tx, audit) => …)` is the single boundary for compliance-significant mutations:
- Every repository and `audit.append` share one `tx`.
- If the mutation, audit validation, HMAC, append, or commit fails, both the change and the audit event roll back, and the error propagates as `AuditWriteError`, which maps to the safe `DEPENDENCY.UNAVAILABLE`.
- A result is returned only after commit.
- Serialization failures and deadlocks (40001, 40P01) are retried at most twice, around the whole transaction, so authorization and version checks rerun.

M1 uses it for:
- registration;
- candidate and staff session revocation;
- invitation issue, supersede, revoke, and expiry;
- staff activation start and completion;
- recovery case transitions, completion, and MFA reset;
- reauthentication evidence;
- role-assignment propose, approve, reject, revoke, and supersede, including the subject's authorization-version bump and session revocation;
- the M1.1 restriction primitives.

The authorization catalog apply script appends `authz.catalog_applied` on its own migration-role transaction before COMMIT.

**Limitation (approved deviation).** Better Auth 1.7.7 commits its own writes without any application transaction:
- its drizzle adapter defaults to `transaction: false`;
- `databaseHooks.*.after` run post-commit;
- the two-factor plugin writes through the base adapter, which ignores transaction propagation.

These flows therefore cannot share a transaction with an audit insert. Their events are cataloged `PROVIDER_COMMITTED`, are appended in a bounded standalone transaction immediately after the provider call through `requireRecorded()`, and are **never described as atomic**. If the append fails, success is withheld and a high-severity alert is raised:

| Flow | Provider-committed change | Behavior when the event cannot be recorded |
|---|---|---|
| Candidate and staff sign-in (`auth.sign_in_succeeded`, `staff.backup_code_used`) | Session creation; backup-code consumption | Compensate by deleting the just-issued session by token; generic failure |
| Email verification (`auth.verification_completed`) | `emailVerified` and activation | Generic failure. The verified state remains, which ADR-0003 already accepts. |
| Password reset and change (`auth.recovery_completed`, `auth.password_changed`, `staff.password_changed`) | Password replaced; sessions revoked | Generic failure. **The change cannot be undone; this is a documented gap.** The staff session wipe still runs unconditionally. |
| MFA enrollment (`staff.mfa_enrolled`) | Factor enabled; backup codes stored | Backup codes withheld. The account stays INVITED until the atomic activation-completion transaction. |
| Backup-code regeneration (`staff.backup_codes_regenerated`) | Codes replaced | New codes withheld; the staff member regenerates again |
| Reauthentication (`staff.reauth_succeeded`) | TOTP verification | The application's own evidence update and the event share one transaction |

Sign-out events are recorded only when a real session ended. Sign-out itself is never withheld.

**Follow-up (not M1.6):** move these mutations into application-owned transactions, as registration, revocation, and MFA reset already are, or adopt a supported Better Auth transaction integration if one becomes available.

### 6. Denials, failures, and idempotency

**Required denials and failures** use `record()`, a bounded standalone transaction (`lock_timeout 2s`, `statement_timeout 5s`):
- It never throws.
- It never changes a denial into an allow.
- It never reveals account existence or the audit failure to the requester.
- It returns `false` and raises a safe `audit.write_failed` alert (closed codes only; an unregistered name is never echoed).

Denials raised inside `withAuditedTransaction`, such as an in-transaction authorization recheck, are deferred until that transaction settles. A rollback therefore cannot lose them, and they never wait on a chain head the same command holds.

**One event per occurrence.**
- A denied high-risk role-assignment command records one `authz.high_risk_denied`. `authz.assignment_refused` is used only for non-authorization refusals.
- Per-row list rechecks are suppressed and summarized in one log line.
- Route guards never emit.

**Idempotency.**
- Versioned transitions carry `idempotency_key = <target>:<new version>`, with a unique `(event_name, idempotency_key)` index.
- The append function returns the existing event for a replay instead of inserting.
- Optimistic version checks refuse a retried command before it can mutate twice.
- Distinct authentication attempts carry no key and remain distinct rows.

### 7. Authorized query projection

`queryAuditEvents(principal, input, deps)` is an internal application service. No route, page, Server Action, export, or generic API calls it.

**Input.** Strictly allowlisted:
- exactly one category;
- a date range of at most 366 days;
- optional catalog event name, outcome, and target-type filters;
- page size of 100 or less;
- an opaque keyset cursor.

There are no JSON-path or metadata searches, actor enumeration, counts, or facets.

**Authorization.** The identity adapter (`auditQueryAuthorizer`) calls the central M1.4 `authorizeQueryScope`. Category maps to permission:
- IDENTITY, ACCESS_CONTROL, and CONFIGURATION use `audit.read.assigned` with CONFIDENTIAL_PERSONNEL sensitivity.
- RESTRICTED_ACCESS, SECURITY, and AUDIT_ACCESS use `audit.restricted.read.assigned` with SECURITY_AUDIT_RESTRICTED sensitivity and recent authentication.

Only `AUDIT_ASSIGNMENT` scopes count. Candidates, `SYSTEM_ADMINISTRATOR` (technical support only), wrong-scope, expired, and insufficient-assurance callers are denied. `audit.business.read` timelines are M2+.

**SQL predicates**, applied before ordering and materialization:
- organization;
- the assignment record window intersected with the requested range;
- candidacies resolved from the assignment's record groups through a fail-closed `AuditRecordGroupResolver` port, which returns nothing until M2.

M1 identity events have no organization, so they are never visible to auditors yet. That is the intended fail-closed outcome.

**Projection.** An exact view model: ID, time, codes, actor type and reference, an effective role/scope-type summary, target, reason code, correlation ID, and catalog-projectable metadata only. It never includes hashes, key versions, partitions, sequences, request IDs, idempotency keys, internal assignment or scope reference IDs, or raw metadata.

**Recursion rule.** After the page is read, one `audit.query_executed` (or `audit.query_denied`) event is appended in a separate standalone transaction, carrying filter codes and the result count only. It lands outside the page the query just read. No event is ever produced by reading a query event. If the query's own event cannot be written, the query returns nothing (fail closed).

### 8. Retention, backup, restore, and keys

- Retention classes are `AUDIT_STANDARD_UNSET` and `SECURITY_STANDARD_UNSET`. They are classes, not durations. Nothing in M1.6 deletes audit or security rows. Final durations, legal hold, and disposition are M9.6. A legally required disposition that conflicts with chain continuity needs a separately approved cryptographic checkpoint or tombstone design.
- A backup must include the `audit` schema, including `chain_head`. A restore runs `pg_restore --disable-triggers` as a superuser for the load only, because the chain-head guard correctly rejects non-genesis inserts. It then re-applies environment grants, runs `pnpm db:check`, and runs `pnpm audit:verify`. A synthetic dump and restore is tested.
- Key custody, rotation, and retention of old versions are environment secret-management responsibilities (ADR-0010 for production).

## Threat model and limitations

- **Tamper evidence, not tamper prevention.** A party who holds both database ownership (or superuser) **and** the integrity key can disable triggers and rewrite an entire chain consistently. Defenses outside M1.6 remain necessary: independent backups, external checkpoints or anchoring, operational database monitoring, and separation of key custody from database administration.
- A database owner can disable triggers (`session_replication_role`, `ALTER TABLE … DISABLE TRIGGER`). That is an operational, audited act outside the application; the runtime role cannot do it. Startup and `db:check` detect disabled triggers.
- The runtime role holds the active key so that it can sign. A compromised runtime can append well-formed false events. It cannot alter, delete, or reorder existing ones without detection.
- Truncating the tail together with a consistent head rewind requires owner privilege plus trigger bypass. The verifier then sees a valid but shorter chain, so external checkpoints of head positions are a recommended later control.
- The provider-committed flows in §5 are not atomic.
- No external timestamp authority, SIEM, object-lock replication, or audit vendor is used.

## Rejected alternatives

- **Ordinary logs as audit:** mutable, unscoped, and lossy. Logs remain diagnostic only.
- **Mutable history tables or soft delete:** contradict append-only evidence.
- **Post-commit, best-effort, or outbox-delayed audit for app-owned mutations:** the change could commit without its evidence.
- **Unrestricted JSON before/after snapshots:** leak restricted data. Record versions and closed codes are used instead.
- **An unkeyed row checksum presented as tamper-proof:** anyone with write access could recompute it.
- **A single global chain head:** a hot lock. Bounded server-derived partitions are used instead.
- **One user-visible audit API or page:** out of scope. An internal service only.
- **Cascading foreign keys:** account lifecycle could erase history. RESTRICT is used instead.
- **Client-supplied event name, actor, time, outcome, authority, or partition:** forgeable. Everything is server-owned.
- **An external audit vendor or blockchain:** unapproved dependency, out of scope.
- **Claiming atomicity through Better Auth after-hooks:** false. They run after commit (§5).
- **Granting runtime INSERT on the tables with trigger-computed hashes:** the key would have to live in the database, and the runtime could forge chain positions directly.

## Consequences

**Positive:**
- Every current M1 identity and access occurrence leaves exactly one classified, chained, minimally disclosed record.
- M2+ modules adopt `withAuditedTransaction` and add catalog entries; organization-bound events chain per organization automatically.
- Restricted reads, high-risk denials, and audit queries are evidenced.

**Negative / risks:**
- Better Auth flows are provider-committed (§5), and password changes cannot be rolled back if the event cannot be recorded.
- Every audited write takes a partition lock.
- Standalone denial appends add one short transaction to each denial.
- `audit:verify` requires the migration identity.

## Approvals

| Role | Name | Date |
|---|---|---|
| Project owner | _approved ADR number and split atomicity model in session; formal record pending_ | 2026-10-07 |
| Technical lead | _pending_ | |
| Security reviewer | _pending_ | |

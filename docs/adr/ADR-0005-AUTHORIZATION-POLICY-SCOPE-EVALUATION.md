# ADR-0005 — Authorization Policy and Scope Evaluation

- **Status:** Accepted, pending recorded project approval (see Approvals)
- **Date:** 2026-10-06
- **Work item:** M1.4 (`docs/tasks/M1.4_ROLES_PERMISSIONS_SCOPES.md`)
- **Depends on:** ADR-0001, ADR-0002, ADR-0003, ADR-0004
- **Numbering:** the M1.4 packet and the original IMPLEMENTATION_PLAN register named this "ADR-0003". That number was already used by M1.2 and ADR-0004 by M1.3. With project-owner approval, this decision is ADR-0005 and the register in `docs/IMPLEMENTATION_PLAN.md` §22 was renumbered.

## Context

M1.1–M1.3 authenticate candidates and invited, MFA-enrolled staff, and they provide server-owned assurance and recent authentication (ADR-0004). Nobody is authorized to do anything yet.

The project rule (`ROLE_PERMISSION_MATRIX.md` §2, `SECURITY_AND_PRIVACY.md` §9) requires every decision to combine:
- an authenticated principal and an active account;
- a current role assignment or candidate self relationship;
- an explicit permission grant;
- record scope, data sensitivity, and workflow state;
- separation of duties;
- recent authentication where required.

Removing a role must take effect immediately.

The organization, branch, team, person, candidacy, and audit-assignment records that scopes refer to belong to M2 and later. They do not exist yet.

## Decisions

### Application authorization stays separate from Better Auth

Better Auth establishes the account and session only. Roles, permissions, assignments, and decisions are application-owned tables and code in the `identity-access` module.

We do not use the Better Auth `admin`, `organization`, or `access` plugins, an external policy service, or an executable policy language. Authorization never reads roles or scopes from a session, cookie, JWT, or the request.

### Role catalog and the candidate relationship

`auth.role` holds the nine controlled roles:
`CANDIDATE`, `RECRUITER`, `HR_SPECIALIST`, `CLASSIFICATION_REVIEWER`, `COMPLIANCE_REVIEWER`, `TRAINER_EVALUATOR`, `PSA_MANAGER`, `SYSTEM_ADMINISTRATOR`, `AUDITOR_READ_ONLY`.

- **Columns:** stable code, name, description, principal type (`CANDIDATE`/`STAFF`), `ACTIVE`/`RETIRED` status, system flag, catalog version.
- **No bypass:** there is no admin, wildcard, superuser, or bypass column.
- **Candidate entitlement is a relationship, not an assignment.** The `CANDIDATE` role's grants carry a `CANDIDATE_OWNERSHIP` condition, which a `CandidateOwnershipResolver` port evaluates. M2 provides that adapter. Until then the default adapter answers `UNAVAILABLE`, so every candidate business decision denies.
- **Database guarantee:** assignments carry `principal_type = 'STAFF'` and a composite foreign key to `role(id, principal_type)`. A staff assignment of the `CANDIDATE` role is impossible at the database level.

### Permission naming and the no-wildcard rule

Permissions are narrow `<resource>.<action>` codes, 2–4 lowercase segments. Examples: `candidate.read.assigned`, `screening.result.read_restricted`, `readiness.final_approval`, `role_assignment.approve`.

- **Distinct capabilities:** view, edit, review, approve, download, export, configure, and administer are separate permissions.
- **No catch-alls:** no `*`, `all`, `admin`, prefix match, or inheritance. A database CHECK enforces the code shape.
- **Stored metadata** (all of it is a maximum capability, never a grant):
  - maximum sensitivity;
  - operation;
  - domain: `BUSINESS`, `TECHNICAL`, or `CANDIDATE_SELF`;
  - flags/policy references: scope, workflow policy, named recent-auth policy and purpose, separation policy, dual-control hook, reason, restricted data, export, and high risk.
- **Retire, never reuse:** codes are retired, never deleted or reused.

The catalog (v1) has 167 permissions and 355 grants. It is derived from every row of matrix §7 (data domains), §8 (commands), and §14 (configuration), plus §12/§15 technical and step-up items.

**Restrictive interpretations (open decisions, matrix §20):**
- **R1:** "If designated / if configured" grants a `DESIGNATION` condition. It denies until a designation source exists. Affected: manager classification and readiness approval, final review, prescreen, and configuration publishing; HR offer approval; HR and compliance full I-9/tax access; restricted-audit reads.
- **R2:** "If interviewer / evaluator / assigned" grants a `PARTICIPANT` condition, resolved through the scope resolver.
- **R3:** "Status only" maps to a separate `*.status.read` permission (`INTERNAL`), never content.
- **R4:** "V limited", "evidence only", and "C limited" grant no content.
- **R5:** Administrator "support / template / catalog / technical" cells grant no business permission. The administrator holds only `TECHNICAL` permissions: access proposal and revocation (never approval), staff account and recovery administration, authentication/provider/technical configuration, system health, technical logs, and security events.
- **R6:** Auditor "assigned" cells grant read/export only. Auditor assignments must use `AUDIT_ASSIGNMENT` scope, and only auditors may use it.
- **R7:** "Documented assist", "intake only", "request", "oversight", "review if applicable", and "technical … after approval" cells define the permission with **no grant**. The same applies to `compliance.waiver.approve`, `break_glass.start`, and `impersonation.start`.
- **R8:** Limited exports use `record.export.standard`, which requires a recorded approval by someone else. Restricted export (`record.export.restricted`) is compliance-only, with dual control and strong recent authentication. The manager's "X" is standard export only.

The complete cell list is in `pendingMatrixDecisions` (`role-permission-catalog.ts`). A guard test fails if any matrix §7/§8/§14 row is untraced or renamed.

### Grant conditions are closed data

`auth.role_permission.condition` is null or one of four closed v1 documents: `CANDIDATE_OWNERSHIP`, `DESIGNATION{designation}`, `PARTICIPANT{relationship}`, or `HOLD_CATEGORY{categories}`. Unknown kinds, keys, or versions are rejected by a database CHECK and by the parser.

At decision time, a stored condition that differs from the reviewed manifest makes the grant unusable (`POLICY_UNAVAILABLE`, plus an event).

### Assignment lifecycle and effective time

`auth.user_role_assignment` holds:
- subject, role, scope type, and a **required** scope reference;
- `effective_from` (inclusive) and `effective_to` (exclusive, nullable);
- status `PROPOSED → ACTIVE → REVOKED | SUPERSEDED`, or `PROPOSED → REJECTED`;
- coded reason plus an optional opaque reference (no free text);
- creator, approver and approval time, revoker, time, and reason;
- replaces/superseded-by links;
- optimistic `version`.

Rules:
- **Database checks** enforce the date order, approval evidence for approved states, and approver ≠ subject ≠ creator. Revoker ≠ subject. Revocation evidence matches the status exactly.
- **Domain checks** require a STAFF subject, an ACTIVE staff role, and a scope type allowed for the role:
  - the administrator may use `ORGANIZATION` only;
  - the auditor may use `AUDIT_ASSIGNMENT` only;
  - the other staff roles may use assigned-records, team, branch, or organization scope.
- **No overlap:** equivalent pending or active assignments may not overlap in time.
- **Material history is immutable.** The runtime role has `INSERT` plus column-level `UPDATE` on lifecycle columns only, and no `DELETE`. Changing role, scope, or dates means proposing a successor (`replaces_assignment_id`). Approving the successor supersedes the predecessor in the same transaction. Revoked rows never return to active; restoration is a new assignment.
- **Expiry is evaluated, not processed:** the same half-open interval is applied in SQL and in the domain against the injected server clock.

### Assignment commands and separation

The commands are propose/replace, approve, reject, revoke, and list. They are application commands only, with no route, action, page, or CLI. A guard test proves no delivery code imports them.

Each command authorizes its actor through the central service:
- `role_assignment.propose`: administrator or manager.
- `role_assignment.approve`: manager only. The administrator implements changes and never approves them (matrix §14).
- `role_assignment.revoke`: administrator or manager.
- `role_assignment.read`: administrator, manager, or auditor.

Propose and approve require strong recent authentication for purpose `PRIVILEGED_ACCESS_CHANGE`. Revoke requires recent MFA for the same purpose.

The target scope is the authorization resource, so an actor cannot grant beyond their own administrative scope.

The subject never proposes, approves, or revokes their own access, and the requester never approves their own request. Both rules are enforced in code and in the database.

**Bootstrap:** a `BOOTSTRAP/TEST_HARNESS` actor exists only for deterministic tests. `NonproductionAssignmentHarness` refuses to construct unless `APP_ENV=test`. Even under the harness, distinct real creator and approver accounts, reasons, scope resolution, and every constraint still apply. There is no default user or administrator, and no local bootstrap CLI.

### Scope types, containment, and deferred referential integrity

The scope types are `ASSIGNED_RECORDS`, `TEAM`, `BRANCH`, `ORGANIZATION`, and `AUDIT_ASSIGNMENT`.

A `ScopeResourceResolver` port resolves:
- **Scope references** into typed descriptors. Outcomes are ACTIVE, INACTIVE, MISSING, TYPE_MISMATCH, or UNAVAILABLE.
- **Records** into placements: organization, branch, team, assignment sets, record groups, business date, and subject accounts.
- **Participant relationships and designations.**

**Containment** compares typed IDs, never strings:
- The organization must match.
- A branch contains its records; a team contains its records, checked through the branch.
- Assigned-records scope requires explicit set membership.
- Audit scope requires the named auditor, an allowed data category, an intersecting record group, and a record date within `[recordsFrom, recordsTo)`.
- An administrative target that is itself a scope is placed by its own ancestry, so a branch-scoped manager cannot approve an organization-level grant.

**Deferred integrity:** `scope_reference_id` is an opaque UUID without a foreign key, because the referenced tables do not exist yet. We do not accept dangling IDs. A proposal or approval is refused unless the reference resolves ACTIVE through an approved adapter at that moment.

The runtime default `UnavailableScopeResolver` resolves nothing. Production can therefore persist no assignment and allow no scoped decision until M2 supplies real adapters. `SyntheticScopeResolver` and `SyntheticCandidateOwnership` are deterministic in-memory test adapters; they reject cross-organization parentage and refuse to construct outside `APP_ENV=test`.

**When M2 creates the scope entities:**
- add real adapters;
- backfill and validate existing references;
- consider foreign keys or a consistency job per scope type.

### Central decision contract

`authorize(request, deps)` and `authorizeInTransaction(tx, request, deps)` are the single entry point. The request is a typed `AuthorizationRequest`:
- principal (from the server resolver), permission code, and operation;
- resource: either `RECORD{id, sensitivity}` or `SCOPE{scopeType, id, sensitivity}`;
- optional closed workflow facts, separation facts, hold category, elevation, reason code, and correlation ID.

**Any other key denies `INVALID_CONTEXT`**, including `roles`, `scopes`, `isAdmin`, `assurance`, and `decision`. Client claims are therefore never even read.

The result is always explicit:
- `ALLOW` carries the effective role, assignment ID, scope type and reference, policy version (`authz-p1-c1`), and `ALLOWED`.
- `DENY` carries one closed reason: `UNAUTHENTICATED`, `ACCOUNT_INACTIVE`, `INVALID_CONTEXT`, `PERMISSION_UNKNOWN`, `PERMISSION_MISSING`, `ASSIGNMENT_INACTIVE`, `OWNERSHIP_UNAVAILABLE`, `SCOPE_MISMATCH`, `SCOPE_UNAVAILABLE`, `CONDITION_UNMET`, `SENSITIVITY_DENIED`, `WORKFLOW_STATE_DENIED`, `SEPARATION_CONFLICT`, `SEPARATION_FACTS_MISSING`, `RECENT_AUTH_REQUIRED` (with a step-up hint), or `POLICY_UNAVAILABLE`.

Unexpected failures deny `POLICY_UNAVAILABLE`; they never throw raw errors. M1.5 adapters decide whether a denial becomes 401, 403, 404, a redaction, or a step-up.

**Evaluation order:**
1. Request shape.
2. Principal, then the current account (status and type re-read).
3. Session validity (M1.3 `NORMAL_STAFF_SESSION`, which also rejects stale account versions).
4. The stored permission row must equal the manifest.
5. Effective grants.
6. Resource placement.
7. Per-assignment scope and conditions.
8. Sensitivity and workflow.
9. Per-assignment separation and recent authentication.

Candidates take the ownership path instead of steps 5–7.

**Selecting among assignments:** candidates are ordered least-privilege first (narrowest scope, then role code, then ID). The first assignment sufficient for every check is the effective context.

**Sensitivity** is an upper bound: `PUBLIC < INTERNAL < CONFIDENTIAL_PERSONNEL`. Each restricted category matches only itself.

**Workflow policies** are closed named evaluators registered by owning domains. The production registry is empty, so workflow-gated permissions deny until M2+ registers them.

### Separation of duties and recent-authentication composition

`MandatorySeparationOfDutiesPolicy` compares immutable account IDs:
- **Generic rules, applied to every staff decision:**
  - break-glass may not perform ordinary workflow actions;
  - an administrator may make no business decision;
  - no staff member may act on their own candidacy or worker file (subjects come from the resolver).
- **Named rules (matrix §9.1):**
  - classification self-approval;
  - candidate self-verification;
  - restricted-result entrant under dual review;
  - signed evaluations are immutable;
  - offer/compensation self-approval;
  - readiness not approved by a candidate or a recruiter role;
  - audit self-modification;
  - export approval by someone else.
- **Dual-control hooks:** classification, high-risk screening disposition, offer compensation threshold, manual waiver, final readiness, restricted export, and retention/legal hold. All are **required by default** (the restrictive choice, matrix §20). Prior approvers must be stated explicitly.

Missing required facts deny `SEPARATION_FACTS_MISSING`.

**Recent authentication** reuses M1.3's `readSessionAssurance` and `evaluateAssurance`. M1.3 logic is not duplicated. A permission names a policy and a purpose:
- `RECENT_STRONG_AUTH` (password + TOTP; backup codes never qualify) covers classification, screening disposition, final adverse action, readiness, restricted export, retention publication, privileged access changes, and break-glass.
- `RECENT_STAFF_AUTH` covers restricted reads and downloads, revocation, and restriction.

Five inline-only purposes were added to the M1.3 registry: `PRIVILEGED_ACCESS_CHANGE`, `RESTRICTED_DATA_ACCESS`, `HIGH_RISK_APPROVAL`, `RESTRICTED_EXPORT`, and `BREAK_GLASS`. The reauthentication page cannot request them.

The evidence must also postdate the effective assignment's `effective_from` and the subject's last authorization-version change. Expanded privilege therefore never reuses an older step-up.

### Current-state loading, authorization version, and sessions

There is no cache. Every decision reads the account, session evidence, effective assignments joined to ACTIVE roles, grants, and permissions, and the stored catalog row.

`auth.authorization_subject` holds a monotonic per-account `authorization_version` and `version_changed_at`. In the same transaction as an approval, revocation, or supersession, the command:
1. writes the assignment change;
2. increments the authorization version;
3. increments `auth.user.version` and deletes the subject's sessions (the accepted M1.1/M1.3 mechanism; M1.3's resolver rejects stale account versions);
4. queues the safe event.

The result:
- Revocation and supersession stop access on the very next decision, even for a browser that still holds a cookie.
- Privilege expansion requires a fresh MFA sign-in, which is stricter than session rotation.
- Expiry at `effective_to` needs no transaction; it simply stops matching.
- Account restriction (M1.1) is seen on the next decision.

### Transactions and concurrency

PostgreSQL READ COMMITTED with explicit row locks:
- **Assignment commands** lock the assignment row and the subject's `auth.user` row `FOR UPDATE`, re-read state, and use version-checked conditional updates.
- **Overlap checks** run under the subject lock.
- **Concurrent approvals:** exactly one activates; the loser gets `STALE_VERSION` or `INVALID_STATE`.
- **Protected commands** call `authorizeInTransaction`, which reads the subject's `auth.user` row `FOR SHARE`. A concurrent revocation or restriction either committed first (the command then denies) or waits until the command commits. A command never commits on authority revoked before its transaction boundary.

**Pattern for later modules:** begin the transaction, call `authorizeInTransaction` first, then load the aggregate with its version, mutate, append audit/outbox (M1.6), and commit.

Deadlocks and serialization failures map to refusals, never raw errors. Deterministic barrier tests prove both orderings.

### Catalog versioning and deployment

The TypeScript manifest (`policy/`) is the single source. It carries `AUTHORIZATION_CATALOG_VERSION` and a SHA-256 digest of its canonical form. A unit test fails on any unreviewed edit and prints the new digest.

`pnpm db:catalog:apply` runs as a reviewed deployment step after `db:migrate`, under the migration role. It:
- runs in one transaction under a table lock;
- inserts missing rows and updates only differing controlled columns, stamped with the catalog version;
- never deletes;
- refuses unknown (tampered) rows, code repurposing, or rows newer than the manifest;
- creates no user, assignment, organization, or session;
- reports counts only and emits `authz.catalog_applied`.

Re-running changes nothing. `pnpm db:catalog:check` is a read-only drift check through the runtime role.

The application never seeds at startup, and the runtime role cannot write the catalog tables. Retiring a grant sets `role_permission.status = 'RETIRED'`.

### Events and logging

M1.4 adds typed, future-audit-ready events to the existing security event port:
- assignment proposed, approved, rejected, revoked, superseded, and refused;
- subject version changed;
- catalog applied;
- high-risk denial;
- policy unavailable.

They carry only opaque account and assignment references plus catalog codes: permission, role, scope type, reason code, and policy version. Never scope or resource IDs, emails, reason references, policy facts, sessions, or raw errors.

Every denial writes one bounded log line (`authz.denied`: permission, reason, policy version). The log allowlist gained the validated fields `roleCode`, `scopeType`, `reasonCode`, and `policyVersion`. No audit table was created.

### Boundaries

- **M1.5:** route, object, and field guards; serializers and redaction; files, search, and exports; adapters from denial reasons to HTTP or UI.
- **M1.6:** append-only audit persistence, atomic with the transaction. *Delivered by ADR-0012: assignment events, the subject-version change, and the catalog apply append inside their transactions; a denied high-risk command records exactly one `authz.high_risk_denied`.*
- **M1.7 (defect D1, regression-tested):** the decision engine now also refuses any stored assignment whose scope type is outside the role's approved set (`allowedScopeTypesByRole`: auditor only `AUDIT_ASSIGNMENT`, administrator only `ORGANIZATION`). Before, only proposal validation enforced it, so a row written around that validation was honored. Such a row is now treated as tampering (`POLICY_UNAVAILABLE`), exactly like an unknown role; no grant or scope semantics changed.
- **M2+:** scope entities and real resolvers, ownership, designations, and workflow policies.

## Rejected alternatives

- **Session/JWT role claims:** they cannot be revoked immediately and are not current state.
- **`isAdmin` / superuser / wildcard grants:** they violate least privilege, and the matrix forbids "admin = allow all".
- **Generic ACL or executable policy JSON:** not reviewable, so injection and drift risk. Closed typed conditions are used instead.
- **Client or middleware guards as authority:** they are convenience only (M1.5).
- **Better Auth admin/organization/access plugins:** they couple authorization to the auth library, use session-held roles, and include an impersonation surface.
- **Placeholder organization/branch/team/audit tables:** premature M2 schema with fake rows. A port with a fail-closed default is used instead.
- **Catalog rows embedded in SQL migrations:** they freeze data separately from the manifest. One manifest plus a reviewed apply/check step is used instead.
- **A decision cache:** no proven transactional invalidation, so direct current-state reads are used.

## Consequences

**Positive:**
- One server-side, deny-by-default decision point with explicit, reproducible results.
- Revocation is immediate and race-safe.
- Catalog drift and tampering are detectable.
- No business access or administration surface exists until its enforcement and audit work items.

**Negative / risks:**
- Every decision costs several queries; caching can be added later only with transactional invalidation.
- Assignment approval signs the subject out everywhere.
- Scope references have no foreign key until M2.
- Lock-ordering deadlocks between commands acting on each other's accounts are possible; they fail closed as refusals.
- The restrictive interpretations (R1–R8) deny some matrix cells until decisions are approved.
- Dual control is on for every hook.
- The `CANDIDATE` grants are inert until M2 ownership exists.

## Open decisions

From matrix §20, still open:
- whether the PSA Manager may act as classification reviewer;
- one- or two-person readiness approval;
- which HR users may see full I-9/tax documents;
- exact branch, team, and assigned-record rules;
- restricted-export approval and expiry;
- the reauthentication interval (currently the M1.3 setting);
- access after candidacy closure;
- the designation source;
- support-access and break-glass design;
- the R7 assist/intake/request cells;
- whether managers may perform restricted export.

## Approvals

| Role | Name | Date |
|---|---|---|
| Project owner | _pending_ | |
| Technical lead | _pending_ | |
| Security reviewer | _pending_ | |

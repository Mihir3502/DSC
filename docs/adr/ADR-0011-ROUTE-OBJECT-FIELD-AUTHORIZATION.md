# ADR-0011 — Route, Object, and Field Authorization

- **Status:** Accepted, pending recorded project approval (see Approvals)
- **Date:** 2026-10-07
- **Work item:** M1.5 (`docs/tasks/M1.5_ROUTE_FIELD_AUTHORIZATION.md`)
- **Depends on:** ADR-0001, ADR-0002, ADR-0003, ADR-0004, ADR-0005
- **Numbering:** M1.5's packet asks for no specific ADR number. ADR-0006–ADR-0010 are already reserved for later topics in `docs/IMPLEMENTATION_PLAN.md` §22, so this decision takes the next free number instead of renumbering them.

## Context

ADR-0005 (M1.4) gives the application one deny-by-default authorization service. M1.5 connects it to every server entry point: pages, layouts, Server Actions, the Better Auth route, and the framework hooks. It also adds reusable contracts for the boundaries that later milestones will build: lists, search, files, jobs, and provider callbacks.

When M1.5 started, every protected surface was the principal's **own** account security:
- masked account summary;
- own sessions;
- own password;
- own backup codes;
- own reauthentication.

None of these is in the M1.4 permission catalog:
- candidate grants deny until M2 provides the ownership relationship;
- a staff member may hold no role at all and must still manage their own MFA and sessions.

## Decisions

### 1. Account self-service is a closed policy registry, not catalog permissions

`domain/self-service-policy.ts` defines 12 stable policies:
- `CANDIDATE_SECURITY_READ`, `CANDIDATE_SESSION_REVOKE`, `CANDIDATE_SESSIONS_REVOKE_OTHERS`, `CANDIDATE_SESSIONS_END_ALL`, `CANDIDATE_PASSWORD_CHANGE`;
- `STAFF_SECURITY_READ`, `STAFF_SESSION_REVOKE`, `STAFF_SESSIONS_REVOKE_OTHERS`, `STAFF_SESSIONS_END_ALL`, `STAFF_PASSWORD_CHANGE`, `STAFF_BACKUP_CODES_REGENERATE`, `STAFF_REAUTHENTICATE`.

Each policy names:
- one audience;
- an operation;
- whether a verified email is required;
- an optional recent-authentication requirement, satisfied by the reauthentication page or by an inline step-up.

The subject is always the server-resolved principal's own account. A policy never names another account, a role, a scope, or a field selection, so it cannot widen catalog authority.

`application/authorize-self-service.ts` evaluates a policy on every call from current facts:
- the account row re-read (type, status, verification, TOTP enrollment);
- the session's assurance evidence, which rejects stale account versions;
- the M1.3 recent-authentication rules.

An in-transaction variant locks the account row `FOR UPDATE`, so a concurrent restriction either commits first and denies, or waits.

The packet (§7.1, §11) and the M1.4 packet (§7.3) both provide this "narrow self-service policy" path. No catalog, grant, or migration changed.

### 2. Guards are navigation hints; every query and command authorizes again

The account pages sit in nested route groups (`(candidate)/candidate/(account)`, `(staff)/staff/(account)`). The `/candidate` and `/staff` landing pages stay public.

The group layouts call `guardNavigation()`, which:
- resolves the principal **silently** (no log, no event);
- returns only a hint: `PROCEED`, `SIGN_IN`, or `HIDDEN`.

A principal of the other audience, or a service account, gets the same 404 not-found page as an unknown route. Nothing the guard computes is passed down.

Each page and each Server Action calls its application query or command, which calls the self-service authorizer again. `src/proxy.ts` resolves no session and makes no decision.

### 3. Exact, audience-specific projections with a typed field policy

`presentation/field-policy.ts` defines the outcomes `INCLUDE`, `MASK`, `STATUS_ONLY`, `OMIT`, and `DENY_RESOURCE`. A field's outcome comes only from:
- the audience;
- the purpose;
- the permissions the M1.4 service allowed for this resource now.

Each representation is classified separately: the full value, the mask, and the status (status defaults to `INTERNAL`, matrix R3). Malformed or unknown rules deny the resource. Restricted data can never be included without a permission.

`presentation/authorized-projector.ts` maps each output field explicitly. A source property the contract does not name never reaches the output, and there is no spreading. The projector then:
- refuses any never-return key at any depth (secrets, tokens, raw session/account/assignment IDs, user agents, IPs, policy conditions, SQL, stacks);
- validates the result against an exact `z.strictObject` schema;
- fails closed on any mismatch.

The current M1 contracts are `candidate.account_security.v1` and `staff.account_security.v1`. They keep the accepted keys. `application/authorize-fields.ts` turns field permissions into M1.4 decisions for later business views.

### 4. Exact input; reject, never strip

`shared/validation/form-input.ts` gives every Server Action a reviewed schema (`src/app/_auth/form-schemas.ts`). The whole submission is rejected before the command runs if it contains:
- an unknown field (server-owned field, selector, projection, or redirect);
- a repeated field;
- a file;
- an over-long value;
- a prototype-pollution key.

Only React/Next.js `$ACTION_*` bookkeeping fields are ignored. Parsed values distinguish a missing field from an empty one.

### 5. One denial mapper, safe redirects, protected caching

`delivery/authorization-error-mapper.ts` maps M1.4 and self-service denials, and application result kinds, to closed outcomes:
- Unauthenticated or ineligible: sign in, or HTTP 401.
- Hidden or unknown: not-found, or 404.
- Forbidden, only when the caller already knows the resource exists: 403.
- Reauthentication required: the allowlisted page, or a 403 with `REAUTHENTICATION_REQUIRED`.
- Validation: 400. Conflict: 409. Rate limited: 429. System error: 5xx with a correlation ID.

Two public codes were added: `FORBIDDEN` and `REAUTHENTICATION_REQUIRED`.

Redirects use only `safeRedirect()`. It accepts exact members of `shared/security/safe-redirect.ts` and otherwise falls back to `/`. ESLint and the boundary test forbid raw `redirect()`.

Protected and capability paths get `Cache-Control: private, no-store, max-age=0`, plus `Pragma` and `Expires`. Every protected page is `force-dynamic`.

**Finding:** Next.js 16 owns `Vary` on App Router page responses. It replaces a proxy-set or `next.config` `Vary`. `Vary: Cookie` is therefore present on protected Route Handler responses only. `private, no-store` is the control everywhere.

### 6. The Better Auth HTTP surface is fully closed

`GET /api/auth/get-session` was the last forwarded path. It had four problems:
- it serialized Better Auth's own user and session objects;
- it bypassed the application's status, MFA, and stale-version checks;
- it could extend the session expiry on a GET;
- nothing used it.

It is now closed in the route allowlist and in Better Auth's `disabledPaths`. Server code still uses `auth.api.getSession`. Every `/api/auth/*` request is a side-effect-free 404 problem with protected headers.

### 7. Reusable contracts, with no production business endpoints

These contracts are unit-tested and integration-tested against synthetic resources:
- **Object authorization** (`application/ports/resource-authorization-envelope.ts`): validate the opaque ID, load a minimal envelope, authorize, and only then project. Invalid, unknown, wrong-type, hidden, wrong-scope, and foreign IDs all produce the same external NOT_FOUND.
- **Scoped lists** (`authorizeQueryScope` in `application/authorize.ts`, `application/authorize-query.ts`, `infrastructure/scope-predicates.ts`):
  - current assignments become typed scope constraints, or a candidate's own-account binding;
  - they are applied as SQL `WHERE` before ORDER BY and LIMIT;
  - a scope selector can only narrow;
  - each row is rechecked;
  - no counts or totals are returned;
  - list input is bounded and allowlisted;
  - grants that need a participant or hold condition never widen a list;
  - the actor's own file is excluded;
  - the administrator has no business list;
  - auditors are bounded by their assignment's record groups, dates, and categories.
- **Documents** (`application/ports/authorized-document-access.ts`): each action (metadata, preview, download, print, export) is authorized separately through a reviewed category registry. The production registry is empty. Additional rules:
  - content actions need a CLEAN scan;
  - grants are short-lived and never carry a storage key or URL;
  - `protectedDownloadHeaders()` sets attachment disposition, a sanitized filename, nosniff, no-store, no-referrer, and a sandbox CSP.
- **Noninteractive callers** (`application/ports/noninteractive-authorization.ts`):
  - the service-grant registry is empty in production;
  - each grant is purpose-bound and rechecks revocation;
  - job payloads are exact reference allowlists that reject authority-carrying keys;
  - a provider callback authenticates the provider first, then authorizes the affected operation.

To share logic with list decisions, the M1.4 pipeline was refactored into `preflight`, `effectiveCandidates`, and `assuranceDenial`. Record decisions are unchanged, and the M1.4 suites pass unchanged.

### 8. Drift and architecture enforcement

`src/app/_security/route-manifest.ts` classifies all 53 current server entry points:
- 15 pages;
- 3 layouts (the root layout and the two account guards);
- 3 special files (not-found, error, global-error);
- 24 Server Actions;
- 2 Route Handler methods;
- the proxy and the instrumentation hook;
- 4 local harnesses.

For each entry it records:
- audience, authentication, and account requirement;
- authorization and service;
- resource binding;
- output contract and input schema;
- CSRF, rate limits, and cache;
- denial, recent authentication, and future audit.

`tests/guards/authorization-boundaries.test.ts` fails CI when:
- an entry point is unclassified or stale;
- a protected entry skips the authorizer, or the service does not evaluate the declared policy;
- an action lacks or ignores its schema;
- a route is cacheable;
- a delivery file imports persistence or the auth library;
- a client module imports server code;
- UI code checks roles;
- a redirect is raw;
- a test adapter is imported;
- a record is spread into a response;
- a secret-retrieval path appears;
- a harness runs with `APP_ENV=production`.

The test also self-checks that every pattern detects a synthetic violation. The only suppression is a same-line `authz-boundary-allow: <reason>`, and none are used.

`pnpm test:routes` (CI build job) compares the built route table and Server Action manifest with the manifest. It also fails if the client bundle (`.next/static`) contains a source map or a server-only authorization marker (permission or self-service policy codes, server module names, secret variable names).

### 9. Events

Every allowed security change carries:
- the self-service action token;
- the policy version (`self-p1`);
- the correlation ID.

A refused high-risk self-service command emits exactly one `authz.self_service_denied`; guards emit none. An allowed restricted document access emits `authz.restricted_access_allowed`. A restricted denial is reported once, by M1.4's `authz.high_risk_denied`.

No audit table was created (M1.6). *Superseded for events by ADR-0012: these events are now durable; `authz.restricted_access_allowed` records the document as its opaque audit target and is required before a grant is issued.*

## Rejected alternatives

- **New catalog permissions plus grants to every staff role, or a new engine path, for own-account security:** these widen the catalog, need a version bump, and still fail for staff with no role.
- **Middleware/proxy or layout as the authority:** layouts are not re-run on client navigation, and the proxy cannot see the decision context.
- **Response redaction after serialization, or broad nullable DTOs:** they leak through omissions and new keys. Exact contracts are used instead.
- **Stripping unknown form fields:** this silently accepts tampering. Rejecting is used instead.
- **Keeping get-session with token stripping:** it still exposes auth-library objects and skips application checks.
- **Renumbering ADR-0006–0010:** that needs owner approval. The next free number is used instead.

## Consequences

**Positive:**
- Every current entry point is classified and enforced on the server. Changes that drift fail CI.
- Later milestones get typed, tested patterns for lists, files, and jobs.

**Negative / risks:**
- Two policy vocabularies exist: catalog permissions and self-service policies. The manifest test requires the declared policy, so each entry uses exactly one.
- Each page view now costs a few more account and session reads (guard, page, query).
- `Vary: Cookie` cannot be set on App Router pages.
- The scoped-list proof uses a synthetic table in the disposable test database. Real list sources arrive in M2+.

## Approvals

| Role | Name | Date |
|---|---|---|
| Project owner | _pending_ | |
| Technical lead | _pending_ | |
| Security reviewer | _pending_ | |

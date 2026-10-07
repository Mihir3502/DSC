# M1 Exit-Gate Report

| | |
|---|---|
| **Status** | **PASS** |
| Work item | M1.7 Authentication and Authorization Test Matrix ([packet](../tasks/M1.7_AUTHENTICATION_AUTHORIZATION_TEST_MATRIX.md)) |
| Gate command | `pnpm test:m1:gate` (from `psa-hiring/`) |
| Gate date | 2026-10-07 (UTC) |
| Reviewer sign-off | _Pending — see [Sign-off](#13-sign-off)_ |

The automated M1 gate passed twice in a row from a clean, controlled state on the same tested tree. Neither run had a failed, skipped, todo, focused, flaky, or quarantined test. All four M1 exit conditions in [IMPLEMENTATION_PLAN.md](../IMPLEMENTATION_PLAN.md#m1-exit-gate) and all 16 M1.7 acceptance criteria have executable evidence, listed below. Four defects were found and fixed during M1.7: three in production code and one in the test harness. No Critical or High defect remains open. The status above is the automated result. The M1 exit gate is approved only after the reviewer sign-off in §13 (packet §36).

## 1. Tested build identifiers

| Identifier | Value |
|---|---|
| Base commit | `52d78cdb8c7fbfdb13d61f4834906e1d5a668a8d` (M1.6), plus the uncommitted M1.7 working tree |
| Tested tree (`psa-hiring/`) | `9b0efefbdc9d72f3b77bb5a1ace9e41224299364`. This is the git tree id of everything tested, tracked plus untracked, excluding ignored files. It equals `git rev-parse <M1.7 commit>:psa-hiring` for the commit that carries this report. |
| Lockfile | `pnpm-lock.yaml` SHA-256 `68a99778a5735078eee0bcd64985c38904a3c4bc4265e22a8defbbabd99492de` (unchanged by M1.7) |
| Latest migration | `0004_audit_foundation`. M1.7 adds no migration. |
| Authorization catalog | Version 1, policy `authz-p1-c1`, digest `371ccf74…d5776c5d`. Contents: 9 roles, 167 permissions (all ACTIVE), 355 grants. Unchanged by M1.7; the reviewed snapshot is `tests/authorization/approved-grants.json`. |
| Route manifest | 53 entries (unchanged by M1.7) |
| Event catalog | 69 events: 45 AUDIT, 17 SECURITY, 7 TELEMETRY. M1.7 widens the telemetry context allow-list only (D2). |
| Self-service policies | 12 |
| Environment | `APP_ENV=test`. Synthetic keys and adapters, disposable Testcontainers PostgreSQL, capture-file email. No real data and no external network calls in tests. |

The `.gitleaks.toml` file and the docs outside `psa-hiring/` are not part of the tested tree. The secret-scan stage scans them in full history.

## 2. Versions

| Tool | Version |
|---|---|
| Node.js | 24.11.0 |
| pnpm | 12.9.1 |
| PostgreSQL (Testcontainers) | `postgres:18.6-trixie` |
| Next.js / React | 16.3.8 / 19.2.8 |
| Better Auth | 1.7.7 |
| Drizzle ORM / Drizzle Kit | 0.45.3 / 0.31.11 |
| Vitest / coverage-v8 | 5.0.3 / 5.0.3 |
| Playwright / axe-core | 1.63.0 (Chromium) / 4.13.0 |
| TypeScript | 5.9.3 |
| Gitleaks | 8.30.1 (pinned image) |

## 3. Gate commands and consecutive runs

`scripts/ci/m1-gate.ts` first removes `.next`, `coverage`, `test-results` and `playwright-report`. It then runs each stage in order and stops at the first failure.

A test stage fails if any of these happen:
- a test fails;
- a test is skipped, todo, or flaky;
- the stage runs fewer tests than its minimum (a missing suite).

Every integration file starts its own PostgreSQL container. Run evidence is in the ignored `.local/m1-gate/<runId>.json` files, which contain only counts, durations, and identifiers.

| # | Stage | Command | Run 1 | Run 2 |
|---|---|---|---|---|
| 1 | install | `pnpm install --frozen-lockfile` | pass 0.1 s | pass 0.1 s |
| 2 | security | `pnpm test:security` (secrets, dependency audit, workflow policy) | pass 3.2 s | pass 3.0 s |
| 3 | data-guard | `pnpm test:data-guard` | pass 0.2 s | pass 0.3 s |
| 4 | critical-guard | `pnpm test:critical-guard` | pass 0.2 s | pass 0.2 s |
| 5 | format | `pnpm format:check` | pass 2.3 s | pass 2.4 s |
| 6 | lint | `pnpm lint` | pass 4.9 s | pass 5.6 s |
| 7 | typecheck | `pnpm typecheck` | pass 2.5 s | pass 2.1 s |
| 8 | auth-schema | `pnpm auth:schema:check` | pass 1.0 s | pass 0.9 s |
| 9 | migration-drift | `pnpm db:check-drift` | pass 0.9 s | pass 0.8 s |
| 10 | unit-component-coverage | `vitest run --project unit --project component --coverage` | pass 8.1 s | pass 7.8 s |
| 11 | integration | `vitest run --project integration` | pass 148.7 s | pass 145.9 s |
| 12 | build | `pnpm build` | pass 15.4 s | pass 14.4 s |
| 13 | routes | `pnpm test:routes` (manifest, client-bundle markers and canaries) | pass 0.4 s | pass 0.2 s |
| 14 | e2e-critical | `pnpm test:e2e:critical` | pass 53.9 s | pass 51.7 s |
| 15 | accessibility | `pnpm test:a11y` | pass 24.0 s | pass 22.3 s |
| 16 | artifact-guard-coverage | `pnpm test:artifact-guard coverage` | pass 0.4 s | pass 0.4 s |
| 17 | artifact-guard-playwright | `pnpm test:artifact-guard playwright-report test-results` | pass 0.2 s | pass 0.2 s |
| 18 | whitespace | `git diff --check` | pass 0.0 s | pass 0.0 s |

| Run | Evidence file | Started (UTC) | Finished (UTC) | Result |
|---|---|---|---|---|
| 1 | `.local/m1-gate/2026-10-07T22-25-30-393Z.json` | 22:25:30 | 22:29:57 | **PASS** |
| 2 | `.local/m1-gate/2026-10-07T22-29-57-753Z.json` | 22:29:57 | 22:34:16 | **PASS** |

### Test counts (identical in both runs)

| Suite | Files | Tests | Passed | Failed | Skipped | Todo/quarantined | Flaky |
|---|---|---|---|---|---|---|---|
| Unit + component (incl. matrix, guards, traceability) | 53 | 2,948 | 2,948 | 0 | 0 | 0 | — |
| Integration (real PostgreSQL) | 16 | 254 | 254 | 0 | 0 | 0 | — |
| Critical Playwright (Chromium) | 5 specs | 37 | 37 | 0 | 0 | 0 | 0 |
| Accessibility (Chromium + axe) | 4 specs | 18 | 18 | 0 | 0 | 0 | 0 |
| **Total** | | **3,257** | **3,257** | **0** | **0** | **0** | **0** |

### Earlier gate attempts (not counted toward the two-run proof)

1. **Two runs on 2026-10-07 at 21:19 UTC: BLOCKED at the security stage.** Gitleaks flagged prose on line 266 of the M1.6 task packet (commit `52d78cd`) as `generic-api-key`. The line is a list of prohibited data categories, not a credential. The project owner approved a narrowly scoped allowlist entry (rule, commit, and anchored path), recorded in `.gitleaks.toml` and the [CI.md exception table](../CI.md#secret-scan-findings), with review-by date 2027-01-07.
2. **Two runs at 22:11 and 22:15 UTC: both PASS, but superseded.** Afterwards, the §22 branch-coverage review found deny branches of the central engine that no measured test reached. I added focused tests (§6), which changed the tested tree. Per §24 and §26, the two-run proof was restarted, and the runs above are the restarted proof.

## 4. M1 exit conditions

| M1 exit condition ([IMPLEMENTATION_PLAN.md](../IMPLEMENTATION_PLAN.md)) | Result | Evidence |
|---|---|---|
| Candidate and staff can authenticate locally | **Met** | `candidate-registration` (50), `authentication` (27), `staff-authentication` (30), `account-state.matrix` (23) integration suites; `candidate-auth.spec.ts`, `staff-auth.spec.ts` critical E2E |
| Privileged staff MFA path works in test mode | **Met** | Invitation, then password, then TOTP enrollment, then backup codes, MFA sign-in, reauthentication, recovery, and MFA reset in `staff-authentication` and `revocation.matrix`; staff E2E and accessibility journeys |
| Authorization matrix tests pass | **Met** | 2,166 policy-level matrix tests (§5), plus integration, route, and E2E enforcement |
| Account, role, sensitive-access, and denial audit events are correct | **Met** | `event-coverage` asserts each of the 69 catalog events exactly once in its stream, with safe context; M1.6 audit persistence, integrity, and query suites |

## 5. Matrix and traceability

### Machine-readable matrix and drift control (§7)

`tests/authorization/matrix-manifest.ts` derives typed rows from the live catalogs. `m1-matrix-coverage.test.ts` fails CI in these cases:
- a catalog role, permission, grant, scope type, route-manifest entry, field outcome, self-service policy, or event lacks covering rows;
- a referenced test is missing or renamed;
- the grant catalog differs from the reviewed `approved-grants.json` snapshot (version and digest included);
- a critical file contains `.skip`, `.only`, `.todo`, or `fixme`.

A self-test proves that perturbing the grant snapshot, or renaming a referenced test, is detected.

### Policy-level matrix results (all passing)

| Matrix | Suite | Tests | Coverage |
|---|---|---|---|
| Role × permission | `role-permission.matrix.test.ts` | 1,523 | All 9 × 167 pairs. Each granted pair: ALLOW under satisfying facts, DENY `PERMISSION_MISSING` once the grant is removed. Each ungranted pair: DENY. Also: unknown, retired, wildcard, and prefix codes; no inheritance; no crossover between the candidate role and staff roles. |
| Scope | `scope.matrix.test.ts` | 45 | 5 scope types × {inside, outside, missing, inactive, expired, malformed, wrong-type, cross-organization}; audit-window boundaries; list narrowing never widens access |
| Field / projection | `field.matrix.test.ts` | 19 | 6 classifications × INCLUDE/MASK/STATUS_ONLY/OMIT/DENY_RESOURCE; never-return keys; unknown metadata fails closed; exact schemas; client selection cannot widen output |
| State, separation, recent auth | `state-separation-recent-auth.matrix.test.ts` | 31 | Workflow allowed/disallowed/terminal/unknown states; all 12 separation rules (same actor, missing facts, swapped IDs, multi-role); recent-auth freshness boundaries, method strength, and purpose/session/account/epoch binding |
| Administrator / auditor | `admin-auditor.matrix.test.ts` | 285 | Administrator: every BUSINESS and restricted permission denies, plus no self-grant. Auditor: every non-READ/EXPORT denies; assignment, date, category, and field bounds; a stored role/scope-type pair that is not allowed is refused (D1) |
| Candidate cross-record | `candidate-cross-record.matrix.test.ts` | 19 | Candidate A vs. B: ID swap, invalid, nonexistent, wrong-type, and hidden IDs give one indistinguishable external outcome; staff queries and commands stay unavailable to candidates |
| Self-service | `self-service.matrix.test.ts` | 206 | 12 policies × 17 variants: owner, wrong audience, service, inactive states, mismatch, unverified, foreign/missing session, MFA not enabled, password-only, stale version, temporary session, expired recent auth |
| Decision branches (§22) | `decision-branches*.test.ts` | 30 | Every reachable deny branch of `evaluateAuthorization` / `evaluateQueryScope` (§6) |
| Drift and coverage | `m1-matrix-coverage.test.ts` | 8 | See above |

### Traceability

`tests/traceability/requirements.json` maps 97 acceptance criteria to tests: M1.2 (17), and M1.3, M1.4, M1.5, M1.6, M1.7 (16 each). The traceability guard verifies that every referenced test exists. M1.1 is foundation work and is covered by the guards and database foundation suites.

| PRD requirement | Status | Note |
|---|---|---|
| PRD-AUTH-001 Staff and candidate accounts | covered | M1.2, M1.3 |
| PRD-AUTH-002 Candidates access only their own information | **partial** | Proven over synthetic ownership envelopes; real candidacy ownership arrives with M2 |
| PRD-AUTH-003 Staff permissions are role based | **partial** | Every pair proven against the accepted catalog; real M2 scope resolvers are still synthetic |
| PRD-AUTH-004 Recent authentication for sensitive actions | **partial** | Every configured policy and purpose proven at exact boundaries; business commands that use them arrive in M2+ |
| PRD-AUTH-005 Recovery does not expose account existence | covered | |
| PRD-AUTH-006 Disabled accounts lose access immediately | covered | |
| PRD-AUTH-007 Authentication events are auditable | covered | M1.6, with the documented PROVIDER_COMMITTED limitation |
| PRD-AUD-001 / PRD-AUD-002 Audit events | **partial** | The foundation is complete; M2+ business actions adopt it |

The partial statuses are deliberate M1 scope boundaries. They are not gate failures.

### M1.7 acceptance criteria

| AC | Result | Primary evidence |
|---|---|---|
| 01 Executable traceable matrix | Pass | `matrix-manifest.ts`, `m1-matrix-coverage.test.ts`, traceability guard |
| 02 Authentication state coverage | Pass | `account-state.matrix`, the staff and candidate auth integration suites, critical E2E |
| 03 Complete role-permission proof | Pass | `role-permission.matrix` (1,523) |
| 04 Scope boundaries | Pass | `scope.matrix`, `decision-branches`, scoped-list integration (SQL filtering before `LIMIT`) |
| 05 Cross-record denial | Pass, with stated limits | `candidate-cross-record.matrix`, `route-object-field`. Synthetic ownership only; timing (§12) |
| 06 Field and mass-assignment safety | Pass | `field.matrix`, `route-object-field`, exact-schema tests |
| 07 State and separation controls | Pass | `state-separation-recent-auth.matrix` |
| 08 Recent-authentication controls | Pass | Same suite; the D4 regression in `revocation.matrix` |
| 09 Administrator/auditor limits | Pass | `admin-auditor.matrix` |
| 10 Immediate revocation and races | Pass | `revocation.matrix`, `concurrency`, `role-assignments` |
| 11 Correct durable audit evidence | Pass | `event-coverage` and the M1.6 audit suites |
| 12 Delivery-boundary consistency | Pass | Policy, integration, route (`proxy.test.ts`, `test:routes`) and Playwright layers |
| 13 Leakage and production safety | Pass | §9 |
| 14 Accessible stable M1 journeys | Pass, Chromium only | 18 axe journeys; no flakes across 4 consecutive full runs |
| 15 Repeatable CI gate | Pass | §3 |
| 16 Exit decision and scope containment | Pass | This report; §11 |

## 6. Authentication and authorization results

**Candidate authentication:**
- registration, email verification, sign-in, recovery, and sign-out;
- session listing and revocation.

Unverified candidates resolve a principal but are refused protected security queries. Enumeration-equivalent responses are covered for registration and recovery.

**Staff authentication:**
- invitation-only activation;
- mandatory TOTP MFA, single-use backup codes (concurrent and replayed use refused), and purpose-bound reauthentication;
- password change, which ends every other session and any pending MFA challenge (D4);
- controlled recovery and MFA reset.

Password-only, incomplete-MFA, activation, and challenge sessions never reach protected staff routes (integration and E2E).

**Account states:** `account-state.matrix` crosses principal type, account status, verification, MFA state, and session state. Only eligible combinations resolve a principal. Candidate, staff, and service surfaces stay isolated.

**Authorization:** deny-by-default holds across role, permission, scope, object, field, state, separation, recent auth, and route/action. No wildcard, no inheritance, no administrator bypass, and no client-asserted authority. Routes:
- unsupported methods are classified by audience;
- cross-origin submission is refused for every built Server Action;
- protected paths are `private, no-store`.

**§22 decision-branch strength.** Unit-measured branch coverage of the policy code, run 2:

| File | Lines | Branches |
|---|---|---|
| `application/authorize.ts` | 98.4% | 98.6% |
| `domain/separation-of-duties-policy.ts` | 100% | 96.2% |
| `domain/self-service-policy.ts` | 100% | 97.8% |
| `domain/authentication-assurance.ts` | 95.6% | 97.9% |
| `domain/scope-policy.ts` | 97.0% | 97.2% |
| `presentation/field-policy.ts` | 98.1% | 94.9% |
| `audit/application/event-catalog.ts` | 100% | 92.3% |

The remaining unmeasured lines in `authorize.ts` fall into two groups:
- **PostgreSQL wrappers** (`authorize`, `authorizeInTransaction`, `authorizeQueryScope`): exercised by the integration suites, which are not instrumented for coverage.
- **Fail-closed fallbacks unreachable through the pipeline:**
  - the final `POLICY_UNAVAILABLE` fallback;
  - the staff `CANDIDATE_OWNERSHIP` condition, which the manifest never assigns to a staff grant;
  - the non-challenge recent-auth denial: preflight already refuses that evidence as `UNAUTHENTICATED`, and a test proves it.

`authorize-query.ts` and `authorize-fields.ts` are mostly PostgreSQL-backed and are covered in `route-object-field` (integration). The new integration case proves that a defective repository's out-of-scope row is dropped and counted. No mutation-testing tool is approved for this project, so none was added (§22).

## 7. Revocation and concurrency

Concurrency tests use deterministic lock-wait barriers (`waitForLockWait`, `deferred`). They contain no sleeps or retries.

| §18 row | Result |
|---|---|
| Account disabled during a waiting protected command | Command denied at its boundary; no partial state |
| Session revoked between requests | Next request unauthenticated |
| Scope assignment superseded during a query | New scope applies; old authority gone |
| Role assignment revoked, approved, or superseded concurrently | One winner; losers commit nothing (`concurrency`, `role-assignments`) |
| Concurrent and replayed backup code | Exactly one success |
| Concurrent and replayed invitation acceptance | Exactly one account and activation under parallel attempts; reuse refused after acceptance; concurrent issuance leaves one live invitation (`staff-authentication`) |
| Password change with other sessions or a pending MFA challenge | All other sessions and the challenge end (D4) |
| Reauthentication followed by a privilege or resource change | Decision reruns; earlier step-up is not reused across privilege expansion |
| MFA reset or recovery | Sessions and challenges invalidated |

All 11 rows are mapped to executing tests in `revocationRows` and checked by the drift test.

## 8. Audit results

- **Event coverage:** `event-coverage.test.ts` drives every one of the 69 catalog events. Each one is asserted exactly once, in its stream (AUDIT, SECURITY, or TELEMETRY), with safe minimal context. The drift test fails if any catalog event has no integration assertion.
- **Atomicity:** app-owned changes append in the same transaction. When audit append fails, a required mutation rolls back and a required denial still denies.
- **PROVIDER_COMMITTED (M1.6):** Better Auth-committed changes are recorded immediately after the provider commit, and success is withheld if recording fails. This limitation is documented in ADR-0012 §5.
- **Append-only:** database privileges refuse UPDATE, DELETE, TRUNCATE, and cascade on audit tables.
- **Integrity:** HMAC chains are verified. Disposable corruption is detected and reported safely (`audit.integrity_verification_failed`).
- **Query authorization:** candidate, administrator, and wrong or expired auditor are denied; an assigned auditor is bounded (`query.test.ts`).
- **Migrations:** apply from empty, and upgrade 0004 over the accepted M1.5 schema with synthetic data, with no backfill and no audit rows created.

## 9. Leakage, production configuration, accessibility, browsers

**Canary and secret scans (all clean)** — failures report only a category, never a value:
- **Integration:** service results, logs, captured email, and audit and security rows, in the candidate and staff leakage tests.
- **E2E:** Playwright output, captured email, and audit rows, scanned by `run-with-database.ts` before cleanup.
- **Build output:** client bundles, checked for server-only markers, `TESTCANARY`, synthetic secret prefixes, and `otpauth://` (`test:routes`).
- **Artifacts:** coverage, `playwright-report`, and `test-results` (artifact guards).
- **Repository history:** Gitleaks.

**Production configuration** (`production-configuration.test.ts`, 9 tests). Staging and production settings refuse:
- fake email and auth providers, loopback hosts, and test secrets;
- insecure cookie and auth settings, and test audit keys;
- synthetic scope resolvers and test harnesses.

**Accessibility:** 18 axe-checked journeys across the candidate auth, staff auth, security-state, and foundation flows. They cover keyboard use, focus, error states, TOTP manual setup, and security states.

**Browsers:** Chromium only. Firefox and WebKit are not installed and are not part of the accepted CI ([CI.md](../CI.md), known limitations). Packet §21 limits browser coverage to what the accepted CI supports.

## 10. Defects and corrections

| ID | Severity | Matrix row / requirement | Root cause | Fix | Regression test | Status |
|---|---|---|---|---|---|---|
| D1 | Medium | §10/§19 role × scope type; AC-M1.7-09 | The engine honored a stored assignment whose role/scope-type pair the reviewed manifest does not allow, for example an auditor role on an organization scope. | `effectiveCandidates` treats a disallowed pair as tampering and fails closed with `POLICY_UNAVAILABLE` (ADR-0005 note). | `admin-auditor.matrix`: "never honors a stored %s assignment on a %s scope" | Fixed |
| D2 | Low | §17 events; AC-M1.7-11 | Telemetry for `policy_unavailable` denials was rejected by the context allow-list, raising a spurious alert. | Telemetry context allows `accountRef`, `recordRef`, `category`, `permissionCode`, `reasonCode` (ADR-0012 correction). | `event-coverage` | Fixed |
| D3 | Medium (test only) | §23 flake hygiene | The integration harness reused TOTP time offsets, which could make a code replay intermittently. | Tracks used absolute TOTP steps and waits when they are exhausted. | `revocation.matrix`, `event-coverage`, auth suites stable across 4 full runs | Fixed |
| D4 | **High** | §18 password reset vs. pending challenge; AC-M1.7-10 | A pending staff MFA challenge survived a password change and could still complete into a session. | `changeStaffPassword` removes pending staff challenges in the same transaction as session deletion (`removePendingStaffChallenges`). | `revocation.matrix`: password change ends sessions and the pending challenge | Fixed |

The project also hardened two pre-existing flaky tests: the TOTP window test now uses `awayFromStepBoundary`, and the email-token word match was corrected. Neither fix changed behavior.

The §22 decision-branch review found no production defect. It added 30 policy tests and 1 integration test.

**Open Critical or High defects: 0.**

## 11. Scope statement

- **M2 business authorization is synthetic.** Organization, branch, team, assignment-set, audit-assignment, and record placement are served by the accepted M1.4 `SyntheticScopeResolver` and synthetic ownership (`APP_ENV=test` only). Real M2 resolvers, candidacy ownership, and business commands do not exist yet. Their own work items must re-prove the matrix against real data paths.
- **Not added in M1.7:** no M2 entity, table, workflow, UI, business endpoint, external provider, or migration. No change to roles, grants, scope semantics, or assurance policy. The `foundation` integration test still asserts that no business-domain tables exist.
- **Production code changes:** limited to defect fixes D1, D2, and D4.

## 12. Residual risks and approved decisions

- **Approved:** the M1.6 split atomicity model (PROVIDER_COMMITTED), recorded in ADR-0012.
- **Approved 2026-10-07:** the Gitleaks allowlist entry for M1.6 packet prose (review by 2027-01-07).
- **Timing equivalence** for enumeration-sensitive paths is mitigated by design: dummy password hashing, and email delivery queued off the request path. It is not asserted statistically, since single-sample timing tests are unreliable.
- **Browser coverage:** Chromium only (§9).
- **Partial PRD statuses** are M2+ scope (§5).
- **Packet §32 manual verification is the reviewer's to perform.** This report contains automated evidence only.

## 13. Sign-off

| Role | Name | Date | Decision |
|---|---|---|---|
| Reviewer (packet §36) | | | ☐ Approve M1 exit ☐ Reject |
| Project owner | | | ☐ Approve M1 exit ☐ Reject |

Once approved, the next work item is preparing `docs/tasks/M2.1_ORGANIZATION_BRANCH_POSITION_HIRING_CYCLE.md` (packet §37). It is not part of this task.

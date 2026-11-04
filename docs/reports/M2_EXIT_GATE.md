# M2 Exit-Gate Report

| | |
|---|---|
| **Status** | **PASS (automated)**, with the limits in §6 |
| Work item | M2 exit gate ([IMPLEMENTATION_PLAN.md](../IMPLEMENTATION_PLAN.md#m2-exit-gate)) |
| Gate commands | `pnpm test:m1:gate` and the phone journey in §3 (from `psa-hiring/`) |
| Gate date | 2026-11-04 |
| Reviewer sign-off | _Pending; see [Sign-off](#8-sign-off)_ |

All four M2 exit conditions have automated evidence, on the same tested tree, in two consecutive runs with no failed, skipped, or flaky test. M2 is approved only after the sign-off in §8.

Preparing this gate exposed a gap in earlier reports: until now, the E2E leakage scan never saw the server's standard output, which is where application logs go. See §5.

## 1. Tested build

| Identifier | Value |
|---|---|
| Base commit | `c13046cb287eba8f1bcebbb8dab51a8afbb9dc8c`, plus the uncommitted test and harness changes in §5 |
| Tested tree (`psa-hiring/`) | `e5ef0f0dcca34f4b00291a06822ce70cf1165933`. It should equal `git rev-parse <commit>:psa-hiring` for the commit carrying this report. |
| Lockfile | `pnpm-lock.yaml` SHA-256 `b74e8481e35df096a911ce20f7b65a5bc5f14a34ecf5e2049f2fc334d06f9ce3` |
| Latest migration | `0011_application_return` |
| Environment | `APP_ENV=test`, synthetic data, disposable PostgreSQL, capture-file email, test malware scanner |

No production code changed for this gate. The changes are limited to one E2E spec, the Playwright config, the artifact guard, and its test.

## 2. Versions

| Tool | Version |
|---|---|
| Node.js / pnpm | 24.11.0 / 12.9.1 |
| PostgreSQL (Testcontainers) | `postgres:18.6-trixie` |
| Next.js / React | 16.4.4 / 19.2.8 |
| Better Auth | 1.7.7 |
| Drizzle ORM / Drizzle Kit | 0.45.3 / 0.31.11 |
| Zod | 4.6.7 |
| Vitest | 5.0.3 |
| Playwright / axe-core | 1.63.0 / 4.13.0 |
| TypeScript | 5.9.3 |

## 3. Gate runs

`pnpm test:m1:gate` removes build and test output, then runs 18 stages in order and stops at the first failure. Every stage passed in both runs.

| Stage | Run 1 (s) | Run 2 (s) |
|---|---|---|
| install | 0.1 | 0.1 |
| security | 5.7 | 6.0 |
| data-guard | 0.3 | 0.3 |
| critical-guard | 0.2 | 0.2 |
| format | 3.5 | 3.8 |
| lint | 6.7 | 6.9 |
| typecheck | 2.6 | 2.6 |
| auth-schema | 0.9 | 0.9 |
| migration-drift | 0.9 | 0.9 |
| unit-component-coverage | 10.1 | 11.4 |
| integration | 228.8 | 216.1 |
| build | 15.7 | 15.8 |
| routes | 0.3 | 0.2 |
| e2e-critical | 97.0 | 99.0 |
| accessibility | 58.4 | 50.9 |
| artifact-guard-coverage | 0.6 | 0.8 |
| artifact-guard-playwright | 0.2 | 0.2 |
| whitespace | 0.1 | 0.0 |

| Run | Evidence file (ignored by git) | Started (UTC) | Finished (UTC) | Result |
|---|---|---|---|---|
| 1 | `.local/m1-gate/2026-11-04T16-23-49-666Z.json` | 16:23:49 | 16:31:02 | **PASS** |
| 2 | `.local/m1-gate/2026-11-04T16-31-02-724Z.json` | 16:31:02 | 16:37:59 | **PASS** |

### Test counts (identical in both runs)

| Suite | Tests | Passed | Failed | Skipped | Flaky |
|---|---|---|---|---|---|
| Unit and component | 3,545 | 3,545 | 0 | 0 | not tracked separately |
| Integration (real PostgreSQL) | 404 | 404 | 0 | 0 | not tracked separately |
| Critical E2E (Chromium) | 51 | 51 | 0 | 0 | 0 |
| Accessibility (Chromium and axe) | 27 | 27 | 0 | 0 | 0 |
| **Total** | **4,027** | **4,027** | **0** | **0** | |

### Phone journey

`E2E_BROWSERS=chromium,webkit pnpm exec tsx tests/e2e/support/run-with-database.ts tests/e2e/m2-exit-gate.spec.ts`

| Run | Result | Leakage scan |
|---|---|---|
| 1 | 2 passed (Chromium, WebKit) | Passed |
| 2 | 2 passed (Chromium, WebKit) | Passed |

### Earlier attempts (not counted)

1. **Two gate runs stopped at data-guard.** The guard flagged a hard-coded test UUID in the new exit spec whose digits pass the card-number check. It wasn't real data. The spec now generates the ID, and the guard was not weakened.
2. **Two full gate runs and two journey runs passed, then were superseded.** They were run before the server-output fix in §5, so they didn't prove the log condition.
3. **One earlier gate run was discarded** because the machine slept under memory pressure.

## 4. Exit conditions

| Condition | Result | Evidence |
|---|---|---|
| Candidate happy path and returned-item E2E pass on a mobile viewport | **Met** | `tests/e2e/m2-exit-gate.spec.ts`, at 390×844 with touch on Chromium and WebKit emulation: start, complete, attach, certify, submit, staff return, correct, resubmit. Each main step also checks for no sideways scrolling. |
| Candidate A cannot view Candidate B through routes, files, or APIs | **Met** | In the same journey, Candidate B gets 404 on six application pages, the attachment download, and an upload attempt. Also `tests/integration/candidates/portal.test.ts`, `tests/integration/documents/attachments.test.ts`, and the application integration suites. |
| Submitted application version is immutable | **Met** | `tests/integration/applications/submission.test.ts`, "makes a submission immutable and refuses a version submitted without one": the runtime database role is refused UPDATE and DELETE on the submission, submission-attachment, and certification-version tables. `tests/integration/applications/correction.test.ts`: resubmitting creates a new frozen version, supersedes the prior one, and preserves both. |
| Restricted data is absent from logs and test artifacts | **Met, with the limits in §6** | §5 |

## 5. Log and artifact evidence

**Gap found.** `playwright.config.ts` set the web server to `stdout: "ignore"`. The application logger (pino) writes to standard output, so the leakage scan had never seen application logs. This affects what earlier reports could claim, including `M1_EXIT_GATE.md` §9 and the M2 completion reports: their scans covered Playwright output, server error output, captured email, and audit and security rows, but not application logs. The artifact guard also didn't look for the application-data marker.

**Fix.**
- The web server's standard output is now piped into the scan.
- The artifact guard now rejects `PSACANARY`, with a new unit test.
- The exit journey tags its answer, file name, signature, and return instructions with that marker.

**Positive control.** A temporary `console.log` of a marker value was added to the candidate home page, and the journey was run on Chromium. The test passed and the runner exited 1 with `e2e leakage scan failed: playwright/server output: application data canary`, which shows the scan reads server output. The line was then reverted before the counted runs. This control exercised server output only. The email and audit-row checks use the same pattern match but had no planted leak.

**Results, with server output included.**
- The marker appears 0 times in either gate log, and the leakage scan and artifact guards passed.
- A separate check of the 1,859 structured log lines from gate run 1 found no synthetic email addresses, test IPs, user agents, session cookies, tokens, test passphrases, TOTP seeds, or SSN shapes.
- Those lines have 20 field names, all operational (such as `eventCode`, `routeTemplate`, `actorRef`, `recordRef`). None holds an email, name, query, body, or cookie.

## 6. Limits of this evidence

- **The marker only proves what it marks.** It covers the values the exit journey tags, not every application field.
- **Scan rules are not all equal.** Email, IP, and user-agent rules apply to audit rows only. The structured-log check for them in §5 was a one-time manual check of one run, not an enforced gate rule.
- **Binary artifacts aren't scanned.** The artifact guard reads text files only, so a `trace.zip` or video isn't inspected. The exit journey turns off trace, screenshot, and video, and the counted runs had no failures to retain.
- **Database contents are outside this check.** Outbox rows and idempotency receipts are not part of the leakage scan.
- **Browser emulation only.** The phone journey ran in Chromium and WebKit emulation, not on a physical device. Firefox doesn't support mobile emulation.
- **Three-browser suite.** The 39 of 39 Chromium, Firefox, and WebKit result came from the tree before the §5 changes. It wasn't repeated, because those changes touch no production code.
- **Unexplained earlier failures.** An intermittent `color-contrast` failure at `candidate-auth.a11y.spec.ts` and one `staff-auth-forms` focus test failure were disclosed earlier and never explained. Neither recurred in the counted runs, but that doesn't show they're gone.
- **Log noise.** Each gate run logs 64 `request.error` lines coded `INTERNAL.UNEXPECTED`, each with an "Invalid Server Actions request" stack trace. They appear to come from the tests that confirm cross-origin Server Action submissions are refused. They contain no restricted data, but expected refusals logged as unexpected errors could hide real errors or trigger false alerts in production.

## 7. Open items before real use

**Needs a decision or review by the owner:**
- Counsel review of the certification wording (still `DRAFT_UNREVIEWED`).
- Business review of application questions, return reasons, Help text, and email wording.
- Set the Help contact values.
- Security review of the workflow policy, proxy body limit, and rate limits.
- Whether a typed signature must match the candidate's name.
- Confirm the accepted M2.2 deferral that the handoff is not single-use.
- Staff can't download attachments, and there are no per-field comments. Decide both in M3.

**Must be done by a person or before production:**
- Manual screen-reader and physical-device checks. These have not been done.
- Production malware scanner, file storage, and email provider. Production mode fails closed until they exist.

**Housekeeping:** `docs/.DS_Store` shouldn't be tracked.

**Open Critical or High defects known to this gate: 0.** The §5 gap was in test evidence and has been fixed. Now that the scan can see them, the logs show no leak.

## 8. Sign-off

| Role | Name | Date | Decision |
|---|---|---|---|
| Reviewer | | | ☐ Approve M2 exit ☐ Reject |
| Project owner | | | ☐ Approve M2 exit ☐ Reject |

Once approved, the next work item is `docs/tasks/M3.1_STAFF_DASHBOARD_AND_UNIFIED_WORK_QUEUE.md`. It is not part of this gate.

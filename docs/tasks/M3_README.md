# M3 — Recruiting and Selection

## Goal

Scoped staff can process submitted applications through prescreen, interview, and an authorized selection decision while candidates see only approved status and actions.

## Execution Order

1. [M3.1 — Staff dashboard and unified work queue](./M3.1_STAFF_DASHBOARD_AND_UNIFIED_WORK_QUEUE.md)
2. [M3.2 — Candidate workspace shell](./M3.2_CANDIDATE_WORKSPACE_SHELL.md)
3. [M3.3 — Application review and prescreen](./M3.3_APPLICATION_REVIEW_AND_PRESCREEN.md)
4. [M3.4 — Interview scheduling](./M3.4_INTERVIEW_SCHEDULING.md)
5. [M3.5 — Interview scorecard](./M3.5_INTERVIEW_SCORECARD.md)
6. [M3.6 — Selection decision](./M3.6_SELECTION_DECISION.md)

Execute one work item at a time:

1. Confirm prerequisites and the prior acceptance report.
2. Use the packet copyable implementation prompt.
3. Review completion evidence and stop conditions.
4. Approve and commit before the next packet.
5. Never mark an exit gate PASS from fabricated or incomplete evidence.

## M3 Exit Gate

- Recruiter journey from queue to selected candidate passes.
- Wrong-scope users and candidates cannot see scorecards/notes.
- Controlled stages cannot be edited directly.
- Terminal and hold paths preserve reason and audit history.

## Global Rules

- Preserve unrelated user changes.
- Use synthetic data only in development, tests, and demos.
- Enforce role, scope, record, field, state, recent-authentication, and separation checks server side.
- Keep business mutation, immutable history, audit, and required outbox effects atomic.
- Never weaken, skip, quarantine, or rewrite tests to hide a defect.
- Stop for an unresolved legal, privacy, security, provider, architecture, or permission decision.
- Do not begin the next milestone until this exit gate is evidenced and accepted.


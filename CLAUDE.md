# PSA Workforce Hiring System

## Purpose

This repository contains a web application for managing the hiring and compliance-readiness process for a Kentucky private-pay Personal Services Agency (PSA).

Release 1 begins when a candidate is created and ends when an approved worker reaches **Ready for Assignment** status. Client scheduling, visit tracking, timesheets, payroll, billing, and leave management are future releases unless a task explicitly expands the approved scope.

## Working Agreement for AI Coding Agents

Before changing code:

1. Read this file and the relevant product, workflow, architecture, data, and security documents.
2. Inspect the existing implementation and tests before proposing changes.
3. State assumptions when a requirement is incomplete.
4. Produce a short implementation plan for any change that affects more than one module.
5. Make the smallest complete change that satisfies the approved requirement.
6. Do not invent regulatory requirements, screening results, or business rules.
7. Do not broaden Release 1 without explicit approval.
8. Add or update tests and documentation with every behavior change.
9. Run the relevant validation commands before declaring work complete.

## Product Scope: Release 1

Release 1 supports:

- W-2 employee candidates.
- Independently reviewed and approved 1099 contractor candidates.
- Private-pay PSA operations only.
- Candidate intake and application tracking.
- Interviewing and selection.
- Conditional offers.
- Background and registry screening tracking.
- Drug-screen tracking.
- TB risk-assessment and clearance tracking.
- Employment or contractor onboarding documents.
- Orientation and required training.
- Task-level competency evaluation.
- Compliance review.
- Final Ready for Assignment approval.
- Notifications, reminders, dashboards, reports, and audit history needed for these processes.

Release 1 does not include:

- Client intake or service agreements.
- Client-care service plans.
- Worker-to-client matching.
- Scheduling or electronic visit verification.
- Timesheets, payroll, or client billing.
- Leave administration.
- Medicaid, waiver, Medicare, managed-care, or insurance claims.
- Native mobile applications.

## Worker Classification Rule

W-2 is the default worker path. A candidate may enter the 1099 path only after a designated authorized reviewer completes and approves a documented worker-classification review.

The system must never:

- Treat selection of “1099” by a recruiter as final classification approval.
- Generate a contractor agreement before classification approval.
- Allow the same active worker engagement to be both W-2 and 1099.
- Allow a candidate with an unresolved classification review to become Ready for Assignment.

Classification records must contain the reviewer, decision, rationale, date, supporting documents, and audit history.

## Canonical Hiring Workflow

The primary workflow is:

1. Prospect
2. Application Incomplete
3. Application Submitted
4. Prescreen Review
5. Interview
6. Selection Decision
7. Conditional Offer
8. Screening and Clearance
9. Onboarding
10. Training
11. Competency Evaluation
12. Final Compliance Review
13. Ready for Assignment

Terminal or exception states include:

- Withdrawn
- Not Selected
- Offer Declined
- Screening Review Required
- Pre-Adverse Action
- Dispute Pending
- Ineligible
- On Hold
- Archived

Workflow transitions must be controlled by explicit rules. Users may not directly edit a status field to bypass required gates.

## Ready for Assignment Gate

A worker may reach Ready for Assignment only when every applicable requirement is satisfied:

- Final worker classification is approved.
- Required offer or agreement is signed.
- Identity and work-authorization steps are complete for a W-2 employee.
- Required tax and payment documents are complete.
- Criminal-record screening is complete and approved.
- Nurse aide and home health aide abuse-registry check is complete and approved.
- Caregiver misconduct-registry check is complete and approved.
- Required drug screening is complete and approved.
- TB requirements are complete and current.
- Required policies and acknowledgments are signed.
- Required orientation and training are complete.
- Each task the worker may perform has a passing competency result.
- Dementia training is current when the worker is marked eligible for dementia assignments.
- A designated compliance reviewer grants final approval.

The gate must return specific unmet requirements rather than only a generic failure message.

## Roles and Separation of Duties

Initial roles are:

- Candidate: manages their own application, forms, uploads, and signatures.
- Recruiter: manages candidate communication, interviews, and offer preparation.
- HR Specialist: manages onboarding records and nonmedical employment documentation.
- Compliance Reviewer: reviews screening, TB, training, competency, and final readiness.
- Trainer/Evaluator: records training and competency results.
- PSA Manager: approves designated business decisions and readiness when required.
- System Administrator: manages configuration and access but cannot silently alter compliance evidence.
- Auditor/Read Only: views authorized records and audit history without editing.

No user may approve their own worker-classification decision, alter their own screening result, or erase audit history.

## Data and Security Invariants

- Use role-based access control and least privilege.
- Separate medical and drug-screen information from the general personnel record.
- Protect Social Security numbers, identity documents, banking data, background reports, medical records, and client-related information as restricted data.
- Encrypt restricted data in transit and at rest.
- Never place real personal information in source code, fixtures, screenshots, logs, prompts, or tests.
- Use synthetic test data only.
- Record create, update, approval, rejection, status-transition, document-access, and export events in an append-only audit history.
- Never hard-delete compliance evidence through normal application workflows.
- Require a reason for manual overrides and high-risk record changes.
- Apply retention rules by record category; do not use one global deletion rule.
- Avoid logging document contents, screening details, identity values, or authentication secrets.

## Engineering Principles

- Keep workflow rules in a domain/service layer, not only in the user interface.
- Enforce critical authorization and readiness gates on the server.
- Model requirements as configurable records when they can vary by worker type, role, or future jurisdiction.
- Use explicit state transitions and idempotent commands for approvals and integrations.
- Store timestamps in UTC and display them in the user’s configured timezone.
- Preserve document version, signer, signature time, and applicable template version.
- Prefer immutable event or audit records for compliance-significant actions.
- Validate all external input at the application boundary.
- Use database transactions for multi-record status transitions.
- Design external screening and signature providers behind interfaces so vendors can be replaced.
- Meet WCAG 2.2 AA expectations for candidate and staff workflows.

## Testing Expectations

Every workflow feature must include tests for:

- The successful path.
- Missing prerequisites.
- Unauthorized access.
- Invalid state transitions.
- Duplicate or repeated submissions.
- Expired compliance items.
- W-2 versus approved 1099 branching.
- Audit-event creation.
- Restricted-data exposure.

Ready for Assignment must have dedicated server-side tests proving that no required gate can be bypassed.

## Definition of Done

A task is complete only when:

- Acceptance criteria are satisfied.
- Relevant tests pass.
- Authorization and validation are enforced server-side.
- Audit behavior is verified.
- Error and empty states are handled.
- No restricted information is exposed in logs or client responses.
- Documentation is updated.
- The implementation remains within the approved release scope.

## Documentation Plan

The project will progressively add the following documents:

- `AGENTS.md` for Antigravity-compatible workspace rules.
- `docs/PRODUCT_REQUIREMENTS.md` for actors, use cases, and acceptance criteria.
- `docs/HIRING_WORKFLOW.md` for states, transitions, gates, and exception paths.
- `docs/ROLE_PERMISSION_MATRIX.md` for access-control decisions.
- `docs/DATA_MODEL.md` for entities, relationships, and sensitive-data classification.
- `docs/ARCHITECTURE.md` after the technology stack is selected.
- `docs/UI_FLOW.md` for screens and navigation.
- `docs/SECURITY_AND_PRIVACY.md` for security controls and retention.
- `docs/TEST_STRATEGY.md` for testing levels and compliance scenarios.
- One or more agent skills only for repeatable multi-step workflows; general rules belong in `CLAUDE.md`, `AGENTS.md`, or scoped rule files rather than `SKILL.md`.

Do not create all documents at once. Build and review them incrementally in the order needed by the current project step.

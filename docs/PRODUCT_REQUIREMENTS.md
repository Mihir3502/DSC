# Product Requirements: PSA Workforce Hiring System

## 1. Document Control

- Product: PSA Workforce Hiring System
- Release: Release 1
- Status: Draft for review
- Primary market: Kentucky private-pay Personal Services Agency
- Workforce models: W-2 employees and separately approved 1099 contractors
- Release boundary: Candidate creation through Ready for Assignment
- Delivery approach: Single TypeScript codebase, local-development first
- User populations: Internal HR staff and external candidates

## 2. Product Summary

The PSA Workforce Hiring System is a web application that guides a home-attendant candidate through recruiting, screening, onboarding, training, competency evaluation, and final compliance approval.

The system replaces disconnected spreadsheets, email threads, paper checklists, and untracked documents with one controlled workflow. It must show what has been completed, what remains outstanding, who approved each decision, and why a worker is or is not eligible to become Ready for Assignment.

Release 1 ends when a worker is approved as Ready for Assignment. It does not assign the worker to a client.

## 3. Problem Statement

The agency needs to prevent the following operational problems:

- A candidate begins work before required screening or clearance is complete.
- Required forms are missing, expired, or stored in different locations.
- W-2 and 1099 candidates follow the wrong onboarding path.
- A contractor classification is selected without documented approval.
- Training completion is recorded without task-level competency evidence.
- Staff cannot determine why a candidate is blocked.
- Candidates repeatedly contact HR because their next action is unclear.
- Sensitive screening, medical, identity, banking, or tax information is visible to unauthorized users.
- Statuses are manually changed without completing prerequisite steps.
- The agency cannot reconstruct who performed or approved an action.

## 4. Release 1 Goals

Release 1 must:

1. Provide one record for every candidate from initial entry through final readiness.
2. Give candidates a secure self-service portal for their own application, assigned forms, uploads, signatures, and training.
3. Give HR staff a prioritized view of candidates requiring action.
4. Enforce different W-2 and approved 1099 requirements.
5. Track screening and compliance requirements without allowing workflow bypasses.
6. Track training and task-level competency.
7. Calculate readiness from completed requirements rather than manual status editing.
8. Maintain a complete, searchable audit history.
9. Support local development using synthetic information and local provider adapters.
10. Keep future client-assignment, scheduling, payroll, billing, and Medicaid capabilities outside Release 1.

## 5. Success Measures

Initial product success will be measured by:

- Percentage of candidates with a clearly identified next action.
- Median time spent in each hiring stage.
- Percentage of Ready for Assignment workers with all required evidence.
- Number of attempted workflow bypasses blocked by the system.
- Number of expired or missing compliance items detected before final review.
- Percentage of candidate forms completed without staff re-entry.
- Time required for an authorized reviewer to audit one worker file.
- Number of duplicate candidate records detected or prevented.

Targets will be established after the agency measures its current manual process.

## 6. Users and Roles

### 6.1 Candidate

A candidate is an external user seeking a home-attendant engagement.

Candidate goals:

- Create and secure an account.
- Complete and submit an application.
- Understand current status and next steps.
- Upload requested documents.
- Complete disclosures and authorizations.
- Review and sign an offer or agreement.
- Complete assigned onboarding forms and training.
- Correct returned items.

Candidate restrictions:

- May access only their own record and candidate-visible information.
- May not view internal interview notes, screening adjudication, compliance notes, classification deliberations, or staff-only audit information.
- May not directly change an approved or rejected item.

### 6.2 Recruiter

Recruiter goals:

- Create or invite candidates.
- Review application completeness.
- Conduct and document prescreening.
- Schedule and score interviews.
- Record selection decisions.
- Prepare a conditional offer.
- Communicate candidate-facing next steps.

### 6.3 HR Specialist

HR Specialist goals:

- Manage onboarding checklists.
- Verify nonmedical employment documents.
- Manage required acknowledgments.
- Prepare W-2 or contractor documentation after classification approval.
- Return incomplete items to candidates.
- Monitor deadlines and stalled records.

### 6.4 Compliance Reviewer

Compliance Reviewer goals:

- Review screening statuses and supporting evidence.
- Review TB and other restricted compliance records.
- Verify training and competency requirements.
- Record clearance decisions.
- Conduct final Ready for Assignment review.
- Place or remove a compliance hold with a documented reason.

### 6.5 Classification Reviewer

Classification Reviewer goals:

- Evaluate a proposed 1099 relationship.
- Record approval or rejection, rationale, date, and supporting documents.
- Route rejected 1099 proposals to the W-2 path or terminate consideration.

This permission may be assigned to an authorized HR leader, PSA manager, or other designated reviewer. It must remain a distinct approval capability.

### 6.6 Trainer/Evaluator

Trainer/Evaluator goals:

- Assign or deliver training.
- Record attendance and completion.
- Evaluate competency by task.
- Sign and date competency outcomes.
- Require remediation and reevaluation.

### 6.7 PSA Manager

PSA Manager goals:

- Monitor the hiring pipeline.
- Approve designated business decisions.
- Review escalations and exceptions.
- View compliance and readiness reports.
- Participate in final approval when configured.

### 6.8 System Administrator

System Administrator goals:

- Manage user accounts, roles, configuration, templates, and local provider settings.
- Maintain system availability and security.

System administrators may not silently alter screening evidence, approvals, competency results, or audit history.

### 6.9 Auditor/Read Only

Auditor goals:

- View authorized worker files, evidence indexes, approvals, and audit history.
- Export approved audit reports.

Auditors may not change operational records.

## 7. Primary User Journeys

### 7.1 Candidate Journey

1. Candidate receives an invitation or begins an application.
2. Candidate creates an account and verifies access.
3. Candidate accepts required notices and completes the application.
4. Candidate submits the application.
5. Staff reviews the application and conducts prescreening.
6. Candidate receives an interview invitation.
7. Staff records the interview and selection decision.
8. Selected candidate receives a conditional offer.
9. Candidate accepts the offer and completes required authorizations.
10. Staff initiates required screening and clearance items.
11. Candidate sees candidate-appropriate outstanding actions without internal adjudication details.
12. Cleared candidate completes the applicable W-2 or approved 1099 onboarding packet.
13. Candidate completes assigned orientation and training.
14. Evaluator records task-level competency.
15. Compliance reviewer performs final review.
16. Candidate becomes Ready for Assignment or receives an actionable hold message.

### 7.2 HR Journey

1. Staff opens a work queue grouped by stage, due date, and risk.
2. Staff reviews the candidate record and required next action.
3. Staff completes, assigns, approves, returns, or escalates the item.
4. The system evaluates transition prerequisites.
5. The system advances the workflow or displays specific unmet requirements.
6. All significant actions are written to the audit history.

### 7.3 Approved 1099 Journey

1. Recruiter proposes the contractor path.
2. The candidate remains unclassified while review is pending.
3. An authorized classification reviewer evaluates and records the decision.
4. If approved, the contractor-specific offer, tax, insurance, and agreement requirements activate.
5. If rejected, staff routes the candidate to the W-2 path or records a terminal decision.
6. The worker cannot become Ready for Assignment until classification is final and all applicable requirements are satisfied.

## 8. Functional Requirements

### 8.1 Authentication and Account Management

- PRD-AUTH-001: The system shall support staff and candidate accounts.
- PRD-AUTH-002: A candidate shall access only their own candidate-facing information.
- PRD-AUTH-003: Staff permissions shall be role based.
- PRD-AUTH-004: Sensitive actions shall require recent authentication when configured.
- PRD-AUTH-005: Account recovery shall not expose whether an unrelated person has an account.
- PRD-AUTH-006: Disabled accounts shall lose access immediately.
- PRD-AUTH-007: Authentication and authorization events shall be auditable.

### 8.2 Candidate Record and Duplicate Prevention

- PRD-CAN-001: Staff may create a candidate or invite a candidate to self-register.
- PRD-CAN-002: The system shall maintain one canonical candidate record with a unique internal identifier.
- PRD-CAN-003: The system shall warn authorized staff about probable duplicates using normalized identifying fields.
- PRD-CAN-004: Duplicate review shall not automatically merge records.
- PRD-CAN-005: An authorized user may merge confirmed duplicates through an audited process.
- PRD-CAN-006: The system shall distinguish a person, candidacy, and eventual worker engagement so a returning person does not require a new identity record.

### 8.3 Application

- PRD-APP-001: The candidate may save a draft application.
- PRD-APP-002: Required questions shall be configurable by worker path and position.
- PRD-APP-003: The system shall validate required fields before submission.
- PRD-APP-004: Submitted answers shall be versioned or historically recoverable.
- PRD-APP-005: Staff may return an application for correction with candidate-visible instructions.
- PRD-APP-006: Internal notes shall never appear in the candidate portal.
- PRD-APP-007: The system shall record candidate certification, submission time, and applicable form version.

### 8.4 Prescreening and Interview

- PRD-INT-001: Staff shall use a consistent prescreen checklist.
- PRD-INT-002: Staff may schedule one or more interviews.
- PRD-INT-003: Interview scorecards shall use versioned templates.
- PRD-INT-004: Interviewers may record ratings, recommendations, and internal notes.
- PRD-INT-005: The system shall record the selection decision, reason category, decision maker, and date.
- PRD-INT-006: Candidate communications shall use approved candidate-facing language rather than exposing internal notes.

### 8.5 Worker Classification

- PRD-CLS-001: W-2 shall be the default proposed path.
- PRD-CLS-002: Only authorized users may initiate or decide a 1099 classification review.
- PRD-CLS-003: A 1099 review shall capture decision, rationale, reviewer, decision date, and supporting documentation.
- PRD-CLS-004: The reviewer may approve, reject, or return the review for more information.
- PRD-CLS-005: A recruiter may not approve their own classification proposal unless separately authorized and allowed by agency policy.
- PRD-CLS-006: Changing an approved classification shall create a new decision record rather than overwrite the prior decision.
- PRD-CLS-007: Onboarding requirements shall be recalculated after a classification change.

### 8.6 Conditional Offer or Agreement

- PRD-OFR-001: Staff shall generate documents from an approved, versioned template.
- PRD-OFR-002: Offer content shall reflect worker path and approved compensation information.
- PRD-OFR-003: A 1099 agreement shall not be generated before contractor classification approval.
- PRD-OFR-004: The candidate may accept, decline, or request assistance.
- PRD-OFR-005: The system shall preserve the exact document version presented and signed.
- PRD-OFR-006: Expired or withdrawn offers shall not be signable.
- PRD-OFR-007: A revised offer shall create a new version and invalidate the prior unsigned version.

### 8.7 Screening and Clearance

- PRD-SCR-001: The system shall create applicable screening requirements from a configurable requirement matrix.
- PRD-SCR-002: Requirements shall support criminal-record, registry, drug-screen, TB, and future configurable categories.
- PRD-SCR-003: Each item shall track requested, scheduled, received, review-required, cleared, failed, expired, waived-if-permitted, and canceled states as applicable.
- PRD-SCR-004: Only authorized reviewers may record a final clearance disposition.
- PRD-SCR-005: Candidate-facing statuses shall not reveal restricted internal details.
- PRD-SCR-006: Adverse-action processing shall use a separate controlled workflow when applicable.
- PRD-SCR-007: The system shall prevent readiness while a required screening item is incomplete, expired, disputed, or not approved.
- PRD-SCR-008: Medical and drug-screen documentation shall use restricted access separate from the general personnel record.
- PRD-SCR-009: Every manual override shall require authority, reason, and audit history.

### 8.8 Onboarding Documents

- PRD-ONB-001: The onboarding checklist shall differ by W-2 and approved 1099 path.
- PRD-ONB-002: Candidates may complete, upload, and sign assigned items.
- PRD-ONB-003: Staff may approve, reject, or return an item with instructions.
- PRD-ONB-004: Each document shall retain category, template version, uploader, timestamps, reviewer, status, and retention class.
- PRD-ONB-005: Replacing a document shall preserve prior versions and review history.
- PRD-ONB-006: Restricted documents shall be encrypted and access controlled.
- PRD-ONB-007: The system shall display applicable missing and expiring items.

### 8.9 Training

- PRD-TRN-001: Staff may assign required courses using a configurable training matrix.
- PRD-TRN-002: Training requirements may vary by worker type, position, capability, and dementia-service eligibility.
- PRD-TRN-003: Training records shall capture course, version, trainer/provider, assignment date, completion date, result, duration when applicable, certificate, and expiration.
- PRD-TRN-004: The system shall support completed, failed, waived-if-permitted, expired, and remediation-required outcomes.
- PRD-TRN-005: Candidates shall see assigned training, due dates, status, and candidate-visible instructions.
- PRD-TRN-006: Expired mandatory training shall block applicable readiness or capability.

### 8.10 Competency Evaluation

- PRD-CMP-001: Competency shall be evaluated by individual personal-service task.
- PRD-CMP-002: Each evaluation shall capture task, method, evaluator, date, result, restrictions, signatures or attestations, and supporting evidence.
- PRD-CMP-003: A failed evaluation shall create a remediation requirement.
- PRD-CMP-004: Reevaluation shall create a new record and preserve the earlier result.
- PRD-CMP-005: A worker shall not be marked eligible for a task without a current passing result.
- PRD-CMP-006: Readiness shall require passing results for every task included in the worker's approved capability profile.

### 8.11 Final Compliance Review and Readiness

- PRD-RDY-001: Ready for Assignment shall be calculated from applicable requirements.
- PRD-RDY-002: Users shall not directly edit readiness status.
- PRD-RDY-003: The readiness evaluator shall return every unmet or expired requirement.
- PRD-RDY-004: A designated compliance reviewer shall complete final approval.
- PRD-RDY-005: Final approval shall capture reviewer, time, checklist version, decision, and comments.
- PRD-RDY-006: Any later expiration or invalidation of a required item shall remove current readiness and create a compliance hold.
- PRD-RDY-007: The system shall distinguish general readiness from task-specific capabilities such as dementia-service eligibility.
- PRD-RDY-008: Candidates shall see an approved general message, while staff shall see detailed blocking reasons.

### 8.12 Work Queues, Search, and Dashboard

- PRD-QUE-001: Staff shall view candidates by stage, owner, age, due date, worker path, and blocker.
- PRD-QUE-002: The dashboard shall identify overdue, expiring, returned, disputed, and review-required items.
- PRD-QUE-003: Authorized staff may search by approved candidate identifiers.
- PRD-QUE-004: Search results shall respect field-level permissions.
- PRD-QUE-005: Staff may assign responsibility and due dates for actions.
- PRD-QUE-006: The system shall highlight records with no activity beyond a configurable threshold.

### 8.13 Notifications and Communications

- PRD-NOT-001: The system shall support in-application notifications.
- PRD-NOT-002: Email delivery shall use a provider interface with a local development adapter.
- PRD-NOT-003: Notifications shall be triggered by defined workflow events rather than arbitrary database changes.
- PRD-NOT-004: Templates shall be versioned and distinguish internal from candidate-facing content.
- PRD-NOT-005: Messages shall not include restricted screening, medical, identity, banking, or tax information.
- PRD-NOT-006: Delivery status and retry attempts shall be recorded.
- PRD-NOT-007: Authorized staff shall be able to resend an eligible notification without duplicating the underlying business action.

### 8.14 Audit and Reporting

- PRD-AUD-001: Compliance-significant actions shall generate append-only audit events.
- PRD-AUD-002: Audit events shall identify actor, action, target, timestamp, source, correlation identifier, and authorized reason when required.
- PRD-AUD-003: Authorized users shall view a chronological candidate history.
- PRD-AUD-004: The system shall report stage aging, missing requirements, upcoming expirations, classification decisions, and readiness outcomes.
- PRD-AUD-005: Exports shall be permission controlled and audited.
- PRD-AUD-006: Reports shall avoid exposing restricted fields unless the requesting role is authorized.

### 8.15 Configuration

- PRD-CFG-001: Authorized administrators may manage requirement matrices, templates, task catalogs, training catalogs, due-date rules, and candidate-facing status messages.
- PRD-CFG-002: Configuration changes shall be versioned and effective dated.
- PRD-CFG-003: A configuration change shall not silently rewrite historical records.
- PRD-CFG-004: High-risk configuration changes shall be audited.

## 9. Canonical Stage Model

The Release 1 pipeline contains these primary stages:

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

Exception or terminal states include:

- Withdrawn
- Not Selected
- Offer Declined
- Screening Review Required
- Pre-Adverse Action
- Dispute Pending
- Ineligible
- On Hold
- Archived

Detailed transitions, prerequisites, rollback behavior, and candidate-facing labels will be specified in `HIRING_WORKFLOW.md`.

## 10. Cross-Cutting Business Rules

1. Workflow stages are advanced by approved commands, not by freely editing a status field.
2. A stage transition must be rejected when its prerequisites are not met.
3. Rejected transitions must return specific blocking requirements.
4. W-2 is the default worker path.
5. A proposed 1099 worker remains unclassified until an authorized decision is recorded.
6. A candidate may have multiple historical candidacies but only one canonical person identity.
7. Historical documents, decisions, evaluations, and audit events may not be overwritten.
8. Candidate-visible information must be explicitly marked or generated for candidate display.
9. Internal notes are never candidate visible.
10. Restricted information requires both role permission and a business need.
11. Readiness is removed when a required item expires, is revoked, or becomes invalid.
12. Every manual override requires a reason and is auditable.
13. External-provider operations must be idempotent so a retry does not create duplicate orders or messages.
14. Release 1 shall use synthetic information for local seeds, demonstrations, and automated tests.
15. The product assists the agency's compliance process; it does not independently provide legal advice or replace authorized human adjudication.

## 11. Nonfunctional Requirements

### 11.1 Security and Privacy

- Enforce server-side authorization for every protected action.
- Apply least privilege and field-level restrictions for sensitive categories.
- Encrypt restricted information in transit and at rest.
- Avoid sensitive information in URLs, logs, analytics, and notification bodies.
- Protect uploads with type, size, and malware-validation controls.
- Use secure session management and protection against common web attacks.
- Make audit history tamper evident and unavailable for normal deletion.

### 11.2 Accessibility and Usability

- Candidate and staff interfaces shall target WCAG 2.2 AA.
- Forms shall support keyboard navigation, clear labels, validation summaries, and recoverable drafts.
- Status pages shall use plain language and identify the next action.
- Color shall not be the only indication of status or error.

### 11.3 Reliability and Data Integrity

- Multi-record transitions shall be transactional.
- Commands that call external providers shall tolerate safe retries.
- Concurrent approvals shall not create contradictory final states.
- Date and time values shall be stored in UTC and displayed in the configured timezone.
- Uploaded document metadata and version history shall remain linked to the relevant requirement.

### 11.4 Maintainability

- Use strict TypeScript.
- Keep core workflow and authorization rules outside presentation components.
- Use replaceable interfaces for email, electronic signature, screening, and file storage.
- Document local startup, test, migration, and seed commands.
- Use automated formatting, linting, type checking, and tests.

### 11.5 Performance

- Common candidate and queue pages should respond quickly for the expected initial agency size.
- Long reports, exports, and external-provider operations should run asynchronously where appropriate.
- Pagination shall be used for unbounded candidate, audit, and report lists.

Specific service-level targets will be established after expected user and record volumes are confirmed.

## 12. Release 1 Acceptance Criteria

Release 1 is acceptable when all of the following are demonstrated:

1. A candidate can create an account, complete an application, save a draft, submit it, and correct returned items.
2. Authorized staff can review the application, conduct an interview, and record a selection decision.
3. Staff can prepare and send an appropriate conditional offer.
4. A W-2 candidate receives the W-2 requirement path.
5. A proposed 1099 candidate cannot enter contractor onboarding until an authorized classification review is approved.
6. Required screening items can be requested, tracked, reviewed, and cleared by authorized users.
7. Restricted screening and medical information is not visible to unauthorized staff or candidates.
8. Candidates can complete assigned onboarding documents and training.
9. Evaluators can record task-level competency and remediation.
10. The system lists every unmet requirement before final readiness.
11. No user can reach Ready for Assignment by directly editing status or bypassing a gate.
12. A designated reviewer can grant final readiness only after all applicable requirements pass.
13. Invalidating or expiring a required item removes readiness and creates a visible hold.
14. HR can view work queues, overdue tasks, blockers, and upcoming expirations.
15. Every significant decision and transition appears in the authorized audit history.
16. Automated tests cover successful, rejected, unauthorized, duplicate, expired, and repeated-submission paths.
17. The entire workflow can be demonstrated locally using synthetic data and without contacting real external providers.

## 13. Out of Scope for Release 1

- Client intake.
- Client service agreements and service plans.
- Worker-to-client matching.
- Shift scheduling.
- Electronic visit verification.
- Timesheets.
- Payroll.
- Client invoicing and payment collection.
- Mileage reimbursement processing.
- Leave administration.
- Employee performance management after readiness.
- Incident and grievance case management after assignment.
- Medicaid, waiver, PACE, Medicare, or insurance billing.
- Native iOS or Android applications.
- Automated legal determination of employee versus contractor classification.

## 14. Future Releases

Potential later releases may include:

- Client onboarding and service-plan management.
- Capability-based worker matching.
- Scheduling and replacement staffing.
- Mobile or web electronic visit verification.
- Time approval, payroll, and billing reconciliation.
- Leave, attendance, incidents, grievances, and performance management.
- Ongoing employee compliance and annual renewal automation.
- Medicaid or waiver-program integrations after separate regulatory analysis.

Future items are informational only and are not authorization to implement them.

## 15. Open Decisions

The following decisions remain for later steps:

- Exact TypeScript web framework.
- Database access library or ORM.
- Authentication and multifactor-authentication approach.
- Local file-storage adapter and future production storage.
- Electronic-signature approach.
- Screening-provider integrations.
- Final production hosting platform.
- Record-retention schedule by record category.
- Expected candidate and staff volumes.
- Exact role assignments within the agency.
- Whether final readiness requires one approval or dual approval.
- Candidate-facing wording for adverse, hold, and ineligible statuses.

## 16. Next Specification

The next document is `docs/HIRING_WORKFLOW.md`. It will define:

- Each workflow state.
- Entry and exit criteria.
- Authorized transitions.
- W-2 and 1099 branches.
- Screening and adverse-action exception paths.
- Returned-item and remediation loops.
- Candidate-visible versus internal statuses.
- Readiness calculation and compliance-hold behavior.

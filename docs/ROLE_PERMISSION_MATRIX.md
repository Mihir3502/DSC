# Role and Permission Matrix

## 1. Purpose

This document defines who may view, create, change, approve, export, or administer information in Release 1 of the PSA Workforce Hiring System.

Authorization must be enforced by the server for every request. Hiding a button in the user interface is not authorization.

## 2. Authorization Model

Use role-based access control combined with record scope and data sensitivity.

An authorization decision must evaluate:

```text
allowed =
  authenticated user
  AND active account
  AND role grants the requested permission
  AND record is within the user's authorized scope
  AND data classification permits access
  AND workflow state permits the action
  AND separation-of-duties rule is satisfied
  AND any required recent authentication is present
```

The authorization service must return an explicit allow or deny result. Critical rules must not be scattered across page components.

## 3. Permission Legend

| Code | Meaning |
| --- | --- |
| `—` | No access |
| `O` | Access limited to the user's own candidate-facing record |
| `V` | View authorized records |
| `C` | Create or initiate |
| `E` | Edit before finalization |
| `R` | Review and return for correction |
| `A` | Approve or make a controlled decision |
| `M` | Manage configuration or workflow |
| `X` | Export authorized information |

Multiple codes may appear together. A table entry is a maximum permission and remains subject to record scope, field restrictions, workflow state, and separation of duties.

## 4. Role Codes

| Code | Role |
| --- | --- |
| `CAN` | Candidate |
| `REC` | Recruiter |
| `HR` | HR Specialist |
| `CLR` | Classification Reviewer |
| `COM` | Compliance Reviewer |
| `TRN` | Trainer/Evaluator |
| `MGR` | PSA Manager |
| `ADM` | System Administrator |
| `AUD` | Auditor/Read Only |

One user may hold more than one staff role, but separation-of-duties checks still apply to the individual actor.

## 5. Record Scope

### 5.1 Candidate Scope

A candidate may access only:

- Their own candidate account.
- Their own application and candidate-provided information.
- Forms, uploads, offers, messages, training, and tasks explicitly released to them.
- Candidate-facing status and next-action information.

A candidate may not access internal notes, reviewer identities where not intended for disclosure, internal scores, screening adjudication, classification analysis, staff audit history, or other people's records.

### 5.2 Staff Scope

Staff scope may be configured as:

- Assigned records only.
- Team or branch records.
- Organization-wide records.
- Restricted specialty scope, such as screening or medical review.

Possession of a role does not automatically provide organization-wide scope.

### 5.3 Auditor Scope

Auditors receive read-only access only to the record groups, date ranges, and data categories identified in an approved audit assignment.

### 5.4 Administrator Scope

System administrators manage technical configuration and access. Administrative role alone does not grant unrestricted business-record access.

## 6. Data Classification

### 6.1 Public

Examples:

- Published position description.
- Public agency contact information.
- General candidate instructions.

### 6.2 Internal

Examples:

- Workflow configuration.
- Non-sensitive operational dashboards.
- Standard internal procedures.

### 6.3 Confidential Personnel

Examples:

- Application information.
- Employment history.
- Interview scorecards.
- Compensation proposal.
- Internal recruiting notes.
- Training and competency records.

### 6.4 Restricted Identity and Financial

Examples:

- Social Security number or tax identifier.
- Form I-9 and identity documents.
- Bank and direct-deposit information.
- Tax-withholding forms.
- Driver's license image.
- Electronic-signature evidence.

### 6.5 Restricted Screening and Medical

Examples:

- Criminal-record reports.
- Registry results.
- Drug-screen results.
- TB records and medical clearance.
- Screening disputes and adjudication notes.
- Pre-adverse and final-adverse documentation.

### 6.6 Security and Audit Restricted

Examples:

- Authentication secrets.
- Recovery information.
- Security events.
- Access logs.
- Audit events involving restricted records.
- Export logs.

## 7. Data-Domain Permission Matrix

| Data domain | CAN | REC | HR | CLR | COM | TRN | MGR | ADM | AUD |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Own candidate profile | O/CE | V | V/E | V | V | V limited | V | Support only | V assigned |
| Other candidate profiles | — | V assigned | V assigned | V assigned | V assigned | V limited | V scoped | Support only | V assigned |
| Application answers | O/CE before submission | V/R | V/R | V | V | V limited | V | Support only | V assigned |
| Internal recruiting notes | — | CEV | V | V limited | V limited | — | V | Support only | V assigned |
| Interview schedule | O/V | CEM | CEM | V | V | V if evaluator | V | Support only | V assigned |
| Interview scorecards | — | CER | V | V limited | V limited | C/E if interviewer | V | Support only | V assigned |
| Selection decision | Candidate message only | C/A scoped | V/A scoped | V | V | — | A/V | Support only | V assigned |
| Compensation proposal | Candidate offer only | CE scoped | CEV | V limited | — | — | A/V | Support only | V assigned |
| Classification proposal | Candidate path label only | C/V | C/V | V | V | — | V | Support only | V assigned |
| Classification analysis | — | Status only | V limited | CEAR | V limited | — | V/A if designated | Support only | V assigned |
| Classification decision | Candidate path label only | V | V | A | V | — | V/A if designated | Support only | V assigned |
| Offer or agreement | O/V/sign | CE | CERA | V | V | — | A/V | Template support | V assigned |
| General onboarding forms | O/CE | Status only | CERA | V limited | V | — | V | Template support | V assigned |
| I-9/identity documents | O/CE own | Status only | Restricted CERA | — | V if designated | — | Status only | Technical support only | V only if assigned |
| Tax and banking documents | O/CE own | — | Restricted CERA | — | — | — | Status only | Technical support only | V only if assigned |
| Screening authorization | O/CE own | Status only | C/R | — | V/R | — | Status only | Template support | V assigned |
| Criminal/registry report | Candidate disclosure only | Status only | Status only | — | Restricted V/A | — | Status/exception only | Technical support only | Restricted V if assigned |
| Drug-screen record | Candidate action/status only | Status only | Status only | — | Restricted V/A | — | Status/exception only | Technical support only | Restricted V if assigned |
| TB/medical record | Candidate upload/status only | Status only | Status only | — | Restricted V/A | — | Status/exception only | Technical support only | Restricted V if assigned |
| Adverse/dispute case | Candidate-approved notices/actions | Status only | Status only | — | Restricted CERA | — | Restricted oversight | Technical support only | Restricted V if assigned |
| Training assignment | O/V/complete | Status only | V/M | — | V | CERA | V | Catalog support | V assigned |
| Competency evaluation | Candidate status only | Status only | V | — | V | CERA | V | Catalog support | V assigned |
| Capability profile | Candidate summary | V | V | — | V/A | C/R | V/A | Configuration support | V assigned |
| Final review | Candidate status only | Status only | V | — | CERA | V evidence only | V/A if designated | Support only | V assigned |
| Readiness record | O/V summary | V | V | V | C/A | V | V/A if designated | Support only | V assigned |
| Holds and deficiencies | O/V approved message | C/V scoped | C/V scoped | C/V classification only | CERA | C/V training only | CERA | Support only | V assigned |
| Candidate communications | O/V | CEM | CEM | C limited | CEM | C limited | V/M | Template support | V assigned |
| Business audit timeline | — | V limited | V limited | V limited | V | V limited | V | Technical support only | VX assigned |
| Restricted access audit | — | — | — | — | V if authorized | — | V if authorized | Security operations | VX assigned |
| User and role configuration | Own account only | — | — | — | — | — | Request changes | M | V assigned |
| Requirement configuration | — | V | V | V classification | V | V training | AM | Technical M | V assigned |

“Support only” means the administrator may perform an approved technical support action without receiving routine permission to view business content. Support access must be time limited, justified, and audited.

## 8. Workflow Command Permission Matrix

| Command | CAN | REC | HR | CLR | COM | TRN | MGR | ADM | AUD |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Start own application | A | C | C | — | — | — | — | — | — |
| Save own application | E | — | Assist only | — | — | — | — | — | — |
| Submit application | A | Documented assist | Documented assist | — | — | — | — | — | — |
| Return application | — | R | R | — | — | — | V | — | — |
| Begin prescreen | — | A | A scoped | — | — | — | V | — | — |
| Complete prescreen | — | A | A scoped | — | — | — | V/A if designated | — | — |
| Schedule interview | Candidate self-schedule if invited | M | M | — | — | M if assigned | V | — | — |
| Submit interview scorecard | — | A if interviewer | A if interviewer | — | — | A if interviewer | A if interviewer | — | — |
| Select/not select | — | A scoped | A scoped | — | — | — | A | — | — |
| Propose W-2 or 1099 path | — | C | C | — | — | — | C | — | — |
| Start classification review | — | — | C | C | — | — | C | — | — |
| Decide contractor classification | — | — | — | A | — | — | A if designated | — | — |
| Create offer draft | — | C scoped | C | — | — | — | C | — | — |
| Approve offer | — | — | A if designated | — | — | — | A | — | — |
| Issue/withdraw offer | — | C/M scoped | C/M | — | — | — | M | — | — |
| Accept/decline offer | A own | Documented assist | Documented assist | — | — | — | — | — | — |
| Initiate screening | Complete own action | Status only | C | — | C | — | V | — | — |
| Record screening result | Submit own evidence when requested | — | Intake only | — | C | — | — | — | — |
| Decide screening disposition | — | — | — | — | A | — | Oversight only | — | — |
| Start adverse-action process | Candidate response only | — | Administrative support | — | A | — | Oversight | — | — |
| Approve onboarding item | — | — | A | — | A if designated | — | V | — | — |
| Assign training | — | — | C/M | — | C/M | C/M | V | — | — |
| Record training result | Complete own learner action | — | — | — | V | A | V | — | — |
| Record competency result | Attend/attest own evaluation | — | — | — | V | A | V/A if evaluator | — | — |
| Start final compliance review | — | — | — | — | C | — | C if designated | — | — |
| Return final review with deficiencies | — | — | — | — | A | — | A if designated | — | — |
| Approve Ready for Assignment | — | — | — | — | A | — | A if configured | — | — |
| Place compliance hold | — | Limited operational request | Limited document hold | Classification hold only | A | Training/competency hold only | A | — | — |
| Remove compliance hold | — | — | Limited document hold | Classification hold only | A | Training/competency hold only | A | — | — |
| Withdraw candidacy | A own | Documented assist | Documented assist | — | — | — | A | — | — |
| Reactivate candidacy | Request only | Request | Request | — | Review if applicable | Review if applicable | A | — | — |
| Archive record | — | — | Request | — | Request | — | A | Technical operation after approval | — |
| Export records | Own provided documents only | Limited approved export | Limited approved export | Limited approved export | Restricted approved export | Limited approved export | X | Technical export after approval | X assigned |

## 9. Separation-of-Duties Rules

### 9.1 Mandatory Rules

1. A user may not approve their own worker-classification proposal.
2. A candidate may not approve or verify their own screening result, onboarding review, training result, competency result, or readiness.
3. The person who enters a restricted screening result may not make the final disposition when dual review is configured.
4. An evaluator may not alter an evaluation after signing it; corrections require a new version or amendment.
5. A system administrator may not use administrative access to approve business decisions.
6. A user may not approve a compensation or offer change they made when dual approval is configured.
7. Final readiness approval may not be completed by the candidate or by a recruiter acting only in the recruiter role.
8. A user whose own candidacy or worker file exists in the system may not use a staff role to access or approve that record.
9. Audit records may not be modified by the actor whose actions they document.
10. Break-glass access may not be used to perform ordinary workflow approvals.

### 9.2 Configurable Dual Approval

The agency may require two different authorized users for:

- Contractor classification.
- High-risk screening disposition.
- Offer approval above a configured compensation threshold.
- Manual compliance waiver where permitted.
- Final Ready for Assignment approval.
- Restricted export.
- Retention override or legal hold removal.

The system must compare user identifiers, not only role names, when enforcing two-person approval.

## 10. Field-Level Access Rules

### 10.1 Masked Fields

When a full value is unnecessary, display a masked form:

- Tax identifier: last four digits only.
- Bank account: bank name, account type, and last four digits.
- Identity document: document type, issuer, and expiration without exposing the image.
- Driver's license: masked number and expiration.
- Screening order: provider reference and status without report contents.

### 10.2 Restricted Attachments

Restricted attachments require:

- An explicit file-category permission.
- Record-scope permission.
- A valid business purpose when prompted.
- Audit of view, download, print, or export.
- Short-lived access links.
- No public or guessable URL.

### 10.3 Internal Notes

- All notes must declare an audience: candidate visible, staff internal, or restricted-review only.
- The default note audience is staff internal.
- Restricted-review notes require the applicable specialist permission.
- Changing a note's audience is an audited action.
- Candidate-facing communication must not be generated by copying internal notes automatically.

## 11. Candidate Portal Rules

Candidates may:

- View and update permitted profile fields.
- Save and submit their application.
- Upload requested documents.
- Complete assigned forms and acknowledgments.
- View and act on an eligible offer or agreement.
- Complete assigned learning activities.
- View candidate-facing status, deadlines, and next actions.
- Respond to approved requests for information or disputes.
- Withdraw their candidacy.

Candidates may not:

- Search the staff system.
- Enumerate other candidate identifiers.
- View staff names unless intentionally displayed.
- View internal scorecards or deliberations.
- View restricted reports or medical adjudication notes.
- Change workflow stage, requirement applicability, due dates, or approval status.
- Replace a finalized document without an active correction request.
- Reopen a closed candidacy without staff approval.

## 12. Administrative and Support Access

### 12.1 Normal Administration

Administrators may:

- Create, disable, and restore staff accounts.
- Assign approved roles and record scopes.
- Configure authentication and provider settings.
- Manage non-business technical configuration.
- View system health and technical logs that exclude protected content.

### 12.2 Impersonation

User impersonation is disabled by default. If later enabled, it must:

- Require a documented support purpose.
- Require recent authentication.
- Be time limited.
- Display a persistent impersonation banner.
- Prevent access to designated highly restricted screens unless separately authorized.
- Audit the administrator, represented user, start, end, reason, and actions.

### 12.3 Break-Glass Access

Break-glass access is for urgent security, availability, or data-recovery situations only.

It requires:

- Explicit reason.
- Strong recent authentication.
- Time-limited elevation.
- Immediate security audit event.
- Notification to a designated reviewer.
- Mandatory post-event review.

Break-glass access does not allow business approval, evidence alteration, or audit deletion.

## 13. Export and Printing Rules

- Export is denied by default.
- Export permission is separate from view permission.
- An export must define purpose, record scope, fields, and format.
- Restricted fields are excluded unless explicitly approved.
- Export files must have controlled storage and expiration.
- Every export records requester, approver when required, filter, field set, record count, time, and file identifier.
- Candidate bulk exports are not available to recruiters by default.
- Printing a restricted document is treated as an export event.
- Reports should use aggregate or masked values when detailed values are unnecessary.

## 14. Configuration Permissions

| Configuration area | Create/edit | Approve/publish | View history |
| --- | --- | --- | --- |
| Job and position templates | HR, MGR | MGR | HR, MGR, AUD |
| Application templates | HR | MGR | REC, HR, MGR, AUD |
| Interview scorecards | REC, HR | MGR | REC, HR, MGR, AUD |
| Classification questionnaire | CLR | MGR/authorized legal reviewer | CLR, MGR, AUD |
| Offer templates | HR | MGR | HR, MGR, AUD |
| Screening requirement matrix | COM | MGR/COM approver | COM, MGR, AUD |
| Onboarding requirement matrix | HR, COM | MGR | HR, COM, MGR, AUD |
| Training catalog and rules | TRN, COM | MGR/COM | TRN, COM, MGR, AUD |
| Competency task catalog | TRN, COM | MGR/COM | TRN, COM, MGR, AUD |
| Candidate message templates | REC, HR | MGR | REC, HR, MGR, AUD |
| Retention rules | COM, MGR | Designated authority | COM, MGR, AUD |
| Roles and permissions | ADM implements approved change | MGR/security owner approves | MGR, ADM, AUD |
| Organization hierarchy | MGR | MGR | HR, MGR, AUD |
| Positions and job descriptions | HR, MGR | MGR | HR, MGR, AUD |
| Hiring cycles | HR, MGR | MGR | HR, MGR, AUD |

Publishing a configuration creates an immutable version and effective date. Historical records remain linked to the version that governed them.

The last three rows were added by M2.1 (authorization catalog version 2, approved 2026-10-07). They use narrow codes: `organization|branch|team.{read,configure,status_change}`, `position.{read,create,edit,activate,retire}`, `job_description.{read,edit,publish}`, and `hiring_cycle.{read,create,edit,publish,open,close,cancel,archive}`.

- **Hierarchy changes:** `PSA_MANAGER` only, authorized against an organization-wide scope.
- **HR:** `HR_SPECIALIST` may create and edit draft positions, descriptions, and hiring cycles within scope, and read the hierarchy.
- **Approval actions:** `PSA_MANAGER` alone activates, publishes, opens, closes, cancels, archives, and retires.
- **Auditor:** `AUDITOR_READ_ONLY` reads only through an approved audit assignment.
- **No grant:** Recruiter, Classification Reviewer, Compliance Reviewer, Trainer/Evaluator, and System Administrator receive nothing. Administrator technical authority never implies business publication.
- **Public:** the public sees only the approved public projection of currently open hiring cycles.

### 14a. Account self-service (implemented in M1.5, ADR-0011)

A principal's own account security (masked summary, own sessions, own password, own backup codes, own reauthentication) is not a business resource and is not in the permission catalog. It is governed by closed self-service policies (`CANDIDATE_*`, `STAFF_*`) bound to the server-resolved principal's own account and audience; they grant nothing on any other record and cannot be held by a service account.

## 15. Authentication Strength by Action

### 15.1 Standard Authenticated Session

Suitable for:

- Candidate application editing.
- Ordinary staff queue and record viewing.
- Nonrestricted scheduling and communication.

### 15.2 Recent Authentication Required

Require password reentry, multifactor confirmation, or equivalent recent authentication for:

- Viewing full restricted identity or financial values.
- Viewing or downloading restricted screening and medical documents.
- Changing bank or payment information.
- Approving worker classification.
- Recording final adverse action.
- Approving Ready for Assignment.
- Assigning or changing privileged roles.
- Performing a restricted export.
- Starting break-glass access.
- Changing organization, branch, or team status; activating, inactivating, or retiring a position; publishing a job description; and publishing, opening, closing, cancelling, or archiving a hiring cycle (M2.1: `RECENT_STAFF_AUTH`, purpose `CONFIGURATION_CHANGE`, with a reason code).

The exact reauthentication interval will be defined in the security specification.

## 16. Permission Naming Convention

Use stable permission keys in the form:

```text
<resource>.<action>
```

Examples:

```text
candidate.read.assigned
application.review
interview.scorecard.submit
classification.review.decide
offer.issue
screening.result.read_restricted
screening.disposition.decide
medical_document.download
onboarding.item.approve
training.result.record
competency.evaluation.record
readiness.final_approval
audit.read.assigned
record.export.restricted
configuration.publish
role_assignment.manage
```

Do not encode database row identifiers, UI page names, or temporary implementation details into permission names.

## 17. Audit Requirements for Authorization

Always audit:

- Login, logout, failed login, recovery, and multifactor changes.
- Account enable, disable, role, and scope changes.
- Authorization denials for high-risk commands.
- Restricted document view, download, print, and export.
- Classification, screening, adverse-action, competency, and readiness decisions.
- Manual overrides and waivers.
- Impersonation and break-glass access.
- Bulk search or export activity.
- Permission and configuration publication.

Routine page views of ordinary nonrestricted records may use summarized access telemetry rather than individual business audit events, subject to the security design.

## 18. Authorization Test Requirements

For every protected API operation, tests must include:

1. Unauthenticated request is rejected.
2. Wrong role is rejected.
3. Correct role but wrong record scope is rejected.
4. Correct role and scope but prohibited workflow state is rejected.
5. Correct role but restricted field permission missing is rejected or redacted.
6. Separation-of-duties conflict is rejected.
7. Required recent authentication missing is rejected.
8. Authorized request succeeds.
9. Successful high-risk action produces the correct audit event.
10. Rejected high-risk action produces the required security or audit event.

Additional tests must prove:

- Candidate A cannot infer or access Candidate B.
- Recruiters cannot retrieve restricted report contents through API parameters or exports.
- Administrators cannot convert technical access into business approval.
- Field redaction applies to list, detail, search, export, and audit views.
- Removing a role or disabling an account takes effect immediately.
- A stale session cannot retain a revoked privilege.

## 19. Initial Implementation Guidance

- Centralize permission checks in an authorization policy layer.
- Apply record-scope filters in the query layer and recheck object authorization before returning data.
- Use explicit response schemas to prevent accidental restricted-field serialization.
- Avoid loading restricted columns when the caller does not need them.
- Use separate storage categories or access paths for general, identity/financial, and screening/medical documents.
- Treat background jobs and integrations as service principals with narrowly scoped permissions.
- Never grant a generic `admin = allow all` shortcut.
- Deny access when role, scope, sensitivity, or workflow context is missing.

## 20. Open Authorization Decisions

- Whether the PSA Manager may also act as Classification Reviewer.
- Whether final readiness requires one compliance approval or two-person approval.
- Which HR users may access full I-9 or tax documents.
- Whether an external occupational-health reviewer will be added in a future release.
- Exact branch, team, and assigned-record scope rules.
- Restricted-export approval and expiration duration.
- Reauthentication interval for high-risk actions.
- Retention and access behavior after candidacy closure.

Until these decisions are approved, implement the more restrictive behavior and keep the rule configurable.

## 21. Next Specification

The next document is `docs/DATA_MODEL.md`. It will translate the product, workflow, and permission rules into:

- Core entities and relationships.
- Workflow and sub-workflow records.
- Requirement and evidence versioning.
- Document classifications.
- Audit and outbox models.
- Field-level sensitivity and retention metadata.

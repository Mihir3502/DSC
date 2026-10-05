Antigravity Workspace Rules
This file configures Google Antigravity for the PSA Workforce Hiring System.
Shared Project Instructions
Treat the following file as the authoritative product, compliance, security, workflow, and definition-of-done instructions:
@[PSA Hiring System Instructions](CLAUDE.md)
If this file conflicts with CLAUDE.md, stop and ask for clarification instead of choosing one silently.
Confirmed Technical Direction
- Use a single TypeScript codebase for Release 1.
- Optimize the initial setup for local development.
- Support two authenticated experiences: internal HR staff and external candidates.
- Keep deployment-specific services replaceable until the production hosting decision is approved.
- Do not add client assignment, scheduling, EVV, payroll, billing, or leave features to Release 1.
The exact framework, ORM, authentication library, test framework, and deployment target must come from docs/ARCHITECTURE.md after that document is approved. Do not silently select or replace these technologies.
Required Agent Workflow
For every implementation task:
1. Read CLAUDE.md and the relevant document under docs/.
2. Inspect the current code, configuration, migrations, and tests.
3. Restate the requested outcome and list any assumptions.
4. Create a short plan with testable acceptance criteria.
5. Identify affected roles, workflow states, readiness gates, restricted data, and audit events.
6. Implement the smallest complete vertical change.
7. Run formatting, linting, type checking, unit tests, integration tests, and relevant browser tests.
8. Verify authorization, validation, error states, and audit behavior.
9. Provide a concise completion summary containing changed files, validation results, assumptions, and remaining risks.
Do not continue past an unresolved requirement that affects worker classification, eligibility, screening disposition, permissions, retention, or Ready for Assignment approval.
Planning and Change Control
- One task should address one clearly defined outcome.
- Do not implement from a broad request such as “build the hiring system.” Break it into approved vertical slices.
- Do not make unrelated refactors while implementing a feature.
- Do not change database schema, workflow states, role permissions, or security controls without identifying the change in the plan.
- Do not delete or rename data fields without a migration and backward-compatibility analysis.
- Do not alter an approved requirement only to simplify implementation.
- Record new architectural decisions in docs/ARCHITECTURE.md or an approved decision record.
Local-First Requirements
- A new developer must be able to start the application using documented repository commands.
- Keep secrets in ignored local environment files; provide a safe example environment file with placeholders.
- Provide deterministic seed data containing synthetic applicants and staff users only.
- Avoid dependencies on paid external services for the basic local workflow.
- Wrap email, electronic signature, background-screening, file-storage, and other external providers behind interfaces with local development adapters.
- Local development must support testing the complete candidate-to-ready workflow without contacting real screening, medical, identity, or payroll systems.
HR Staff and Candidate Boundaries
Candidate users may access only their own:
- Profile and application.
- Requested forms and document uploads.
- Interview scheduling information intended for them.
- Offer or agreement documents intended for them.
- Training assignments and completion information intended for them.
- High-level application status messages approved for candidate display.
Candidates must never access:
- Internal interview notes.
- Other candidates or workers.
- Screening adjudication details not approved for disclosure.
- Internal compliance notes.
- Classification-review deliberations.
- Staff-only audit records or reports.
Staff access must follow the role and separation-of-duties rules in CLAUDE.md and the future role-permission matrix.
Verification Artifacts
When Antigravity changes a user-facing workflow, provide:
- A task plan.
- Test results.
- Screenshots for the successful path.
- Screenshots or test evidence for important blocked and error states.
- A short walkthrough of the state transition and authorization behavior.
Never use real personal, medical, screening, tax, banking, or identity information in screenshots or demonstrations.
Stop Conditions
Stop and request a decision if:
- A task would expand Release 1 scope.
- A requested transition bypasses a compliance gate.
- W-2 versus 1099 treatment is unclear.
- The authoritative product documents disagree.
- A change could expose restricted data.
- The requested behavior lacks an identified authorized role.
- A destructive migration or irreversible external action would be required.
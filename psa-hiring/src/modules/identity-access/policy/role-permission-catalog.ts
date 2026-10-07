import type {
  CatalogStatus,
  Designation,
  HoldCategory,
  ParticipantRelationship,
  RoleCode,
} from "../domain/authorization-vocabulary";
import type { GrantCondition } from "../domain/grant-condition";

// Reviewed Release 1 role-permission grants (packet M1.4 §8.3, §16,
// ADR-0005). Each grant is the restrictive interpretation of
// ROLE_PERMISSION_MATRIX.md §7, §8, and §14:
//
// R1 "if designated / if configured" → DESIGNATION condition (denies until
//    a designation source exists).
// R2 "if interviewer / if evaluator / if assigned" → PARTICIPANT condition.
// R3 "Status only" → a separate *.status.read permission, never content.
// R4 "V limited", "evidence only", "C limited" → no content grant.
// R5 Administrator support/template/catalog/technical cells → no business
//    permission; technical permissions only.
// R6 Auditor "assigned" cells → read/export only, through an
//    AUDIT_ASSIGNMENT-scoped assignment only.
// R7 Assist, intake, request, oversight, review-if-applicable, and
//    technical-after-approval cells → no grant (pending decision).
// R8 Limited exports → record.export.standard with recorded approval;
//    restricted export → compliance reviewer only, dual control.
//
// A grant is a maximum capability; scope, sensitivity, workflow,
// separation, and recent authentication still apply.

export type GrantDefinition = Readonly<{
  roleCode: RoleCode;
  permissionCode: string;
  condition: GrantCondition | null;
  status: CatalogStatus;
}>;

type Spec = string | readonly [string, GrantCondition];

const designated = (designation: Designation): GrantCondition =>
  Object.freeze({ v: 1, kind: "DESIGNATION", designation });
const participant = (relationship: ParticipantRelationship): GrantCondition =>
  Object.freeze({ v: 1, kind: "PARTICIPANT", relationship });
const holdOnly = (...categories: HoldCategory[]): GrantCondition =>
  Object.freeze({ v: 1, kind: "HOLD_CATEGORY", categories });
const owned: GrantCondition = Object.freeze({
  v: 1,
  kind: "CANDIDATE_OWNERSHIP",
});

const configAreas = [
  "position_template",
  "application_template",
  "scorecard_template",
  "classification_questionnaire",
  "offer_template",
  "screening_requirement_matrix",
  "onboarding_requirement_matrix",
  "training_catalog",
  "competency_task_catalog",
  "message_template",
  "retention_rule",
] as const;
const history = (area: (typeof configAreas)[number]) =>
  `configuration.${area}.history.read`;
const edit = (area: (typeof configAreas)[number]) =>
  `configuration.${area}.edit`;
const publish = (area: (typeof configAreas)[number]) =>
  `configuration.${area}.publish`;

const grantSpecs: Readonly<Record<RoleCode, readonly Spec[]>> = {
  CANDIDATE: [
    ["candidate.own_profile.read", owned],
    ["candidate.own_profile.edit", owned],
    ["application.own.edit", owned],
    ["application.own.submit", owned],
    ["interview.own_schedule.read", owned],
    ["interview.own_schedule.self_schedule", owned],
    ["offer.own.read", owned],
    ["offer.own.respond", owned],
    ["onboarding.own_form.complete", owned],
    ["onboarding.own_restricted_document.submit", owned],
    ["screening.own_action.complete", owned],
    ["training.own.complete", owned],
    ["candidacy.own_status.read", owned],
    ["candidacy.own.withdraw", owned],
    ["candidacy.own.request_reactivation", owned],
    ["record.export.own_documents", owned],
  ],

  RECRUITER: [
    "candidate.read.assigned",
    "application.read",
    "application.review",
    "application.start_on_behalf",
    "prescreen.begin",
    "prescreen.complete",
    "recruiting_note.read",
    "recruiting_note.write",
    "interview.schedule.read",
    "interview.schedule.manage",
    "interview.scorecard.read",
    ["interview.scorecard.submit", participant("INTERVIEWER")],
    "interview.scorecard.review",
    "selection.read",
    "selection.decide",
    "compensation.read",
    "compensation.propose",
    "offer.draft.create",
    "offer.read",
    "offer.edit",
    "offer.issue",
    "offer.withdraw",
    "classification.path.propose",
    "classification.proposal.read",
    "classification.decision.read",
    "classification.status.read",
    "onboarding.status.read",
    "screening.status.read",
    "training.status.read",
    "capability_profile.read",
    "readiness.read",
    "compliance_hold.read",
    "communication.read",
    "communication.send",
    "record.export.standard",
    history("application_template"),
    edit("scorecard_template"),
    history("scorecard_template"),
    edit("message_template"),
    history("message_template"),
    "configuration.requirement.read",
  ],

  HR_SPECIALIST: [
    "candidate.read.assigned",
    "candidate.profile.edit",
    "application.read",
    "application.review",
    "application.start_on_behalf",
    "prescreen.begin",
    "prescreen.complete",
    "recruiting_note.read",
    "interview.schedule.read",
    "interview.schedule.manage",
    "interview.scorecard.read",
    ["interview.scorecard.submit", participant("INTERVIEWER")],
    "selection.read",
    "selection.decide",
    "compensation.read",
    "compensation.propose",
    "offer.draft.create",
    "offer.read",
    "offer.edit",
    "offer.review",
    ["offer.approve", designated("OFFER_APPROVER")],
    "offer.issue",
    "offer.withdraw",
    "classification.path.propose",
    "classification.proposal.read",
    "classification.review.start",
    "classification.decision.read",
    "onboarding.form.read",
    "onboarding.form.edit",
    "onboarding.item.review",
    "onboarding.item.approve",
    // Matrix §20: which HR users may access full I-9/tax documents is open.
    [
      "identity_document.read_masked",
      designated("RESTRICTED_IDENTITY_REVIEWER"),
    ],
    [
      "identity_document.read_restricted",
      designated("RESTRICTED_IDENTITY_REVIEWER"),
    ],
    ["identity_document.download", designated("RESTRICTED_IDENTITY_REVIEWER")],
    ["identity_document.manage", designated("RESTRICTED_IDENTITY_REVIEWER")],
    [
      "tax_banking_document.read_restricted",
      designated("RESTRICTED_IDENTITY_REVIEWER"),
    ],
    [
      "tax_banking_document.download",
      designated("RESTRICTED_IDENTITY_REVIEWER"),
    ],
    ["tax_banking_document.manage", designated("RESTRICTED_IDENTITY_REVIEWER")],
    "screening.authorization.read",
    "screening.authorization.manage",
    "screening.authorization.review",
    "screening.initiate",
    "screening.status.read",
    "training.assignment.read",
    "training.assignment.manage",
    "competency.evaluation.read",
    "capability_profile.read",
    "final_review.read",
    "readiness.read",
    "compliance_hold.read",
    ["compliance_hold.place", holdOnly("DOCUMENT")],
    ["compliance_hold.remove", holdOnly("DOCUMENT")],
    "communication.read",
    "communication.send",
    "record.export.standard",
    edit("position_template"),
    history("position_template"),
    edit("application_template"),
    history("application_template"),
    edit("scorecard_template"),
    history("scorecard_template"),
    edit("offer_template"),
    history("offer_template"),
    edit("onboarding_requirement_matrix"),
    history("onboarding_requirement_matrix"),
    edit("message_template"),
    history("message_template"),
    "configuration.requirement.read",
  ],

  CLASSIFICATION_REVIEWER: [
    "candidate.read.assigned",
    "application.read",
    "interview.schedule.read",
    "selection.read",
    "classification.proposal.read",
    "classification.review.start",
    "classification.analysis.read",
    "classification.analysis.edit",
    "classification.review.decide",
    "classification.decision.read",
    "offer.read",
    "readiness.read",
    "compliance_hold.read",
    ["compliance_hold.place", holdOnly("CLASSIFICATION")],
    ["compliance_hold.remove", holdOnly("CLASSIFICATION")],
    "record.export.standard",
    edit("classification_questionnaire"),
    history("classification_questionnaire"),
  ],

  COMPLIANCE_REVIEWER: [
    "candidate.read.assigned",
    "application.read",
    "interview.schedule.read",
    "selection.read",
    "classification.proposal.read",
    "classification.decision.read",
    "offer.read",
    "onboarding.form.read",
    ["onboarding.item.approve", designated("ONBOARDING_APPROVER")],
    [
      "identity_document.read_masked",
      designated("RESTRICTED_IDENTITY_REVIEWER"),
    ],
    [
      "identity_document.read_restricted",
      designated("RESTRICTED_IDENTITY_REVIEWER"),
    ],
    "screening.authorization.read",
    "screening.authorization.review",
    "screening.initiate",
    "screening.result.record",
    "screening.result.read_restricted",
    "screening.report.download",
    "screening.disposition.decide",
    "medical_document.read_restricted",
    "medical_document.download",
    "medical_clearance.decide",
    "adverse_action.read_restricted",
    "adverse_action.start",
    "adverse_action.manage",
    "adverse_action.final_record",
    "training.assignment.read",
    "training.assignment.manage",
    "training.result.read",
    "competency.evaluation.read",
    "capability_profile.read",
    "capability_profile.approve",
    "final_review.read",
    "final_review.start",
    "final_review.edit",
    "final_review.return",
    "readiness.read",
    "readiness.final_approval",
    "compliance_hold.read",
    "compliance_hold.place",
    "compliance_hold.remove",
    "communication.read",
    "communication.send",
    "audit.business.read",
    ["audit.restricted.read", designated("RESTRICTED_AUDIT_REVIEWER")],
    "record.export.restricted",
    edit("screening_requirement_matrix"),
    [
      "configuration.screening_requirement_matrix.publish",
      designated("CONFIGURATION_APPROVER"),
    ],
    history("screening_requirement_matrix"),
    edit("onboarding_requirement_matrix"),
    history("onboarding_requirement_matrix"),
    edit("training_catalog"),
    publish("training_catalog"),
    history("training_catalog"),
    edit("competency_task_catalog"),
    publish("competency_task_catalog"),
    history("competency_task_catalog"),
    edit("retention_rule"),
    history("retention_rule"),
    "configuration.requirement.read",
  ],

  TRAINER_EVALUATOR: [
    "candidate.summary.read",
    ["interview.schedule.read", participant("EVALUATOR")],
    ["interview.schedule.manage", participant("INTERVIEWER")],
    ["interview.scorecard.submit", participant("INTERVIEWER")],
    "training.assignment.read",
    "training.assignment.manage",
    "training.result.read",
    "training.result.record",
    "competency.evaluation.read",
    "competency.evaluation.record",
    "competency.evaluation.edit",
    "competency.evaluation.amend",
    "capability_profile.edit",
    "readiness.read",
    "compliance_hold.read",
    ["compliance_hold.place", holdOnly("TRAINING_COMPETENCY")],
    ["compliance_hold.remove", holdOnly("TRAINING_COMPETENCY")],
    "record.export.standard",
    edit("training_catalog"),
    history("training_catalog"),
    edit("competency_task_catalog"),
    history("competency_task_catalog"),
  ],

  PSA_MANAGER: [
    "candidate.read.assigned",
    "application.read",
    ["prescreen.complete", designated("PRESCREEN_APPROVER")],
    "recruiting_note.read",
    "interview.schedule.read",
    "interview.scorecard.read",
    ["interview.scorecard.submit", participant("INTERVIEWER")],
    "selection.read",
    "selection.decide",
    "compensation.read",
    "compensation.approve",
    "offer.draft.create",
    "offer.read",
    "offer.approve",
    "offer.issue",
    "offer.withdraw",
    "classification.path.propose",
    "classification.proposal.read",
    "classification.review.start",
    "classification.analysis.read",
    // Matrix §20: whether the PSA Manager may act as classification reviewer.
    ["classification.review.decide", designated("CLASSIFICATION_APPROVER")],
    "classification.decision.read",
    "onboarding.form.read",
    "onboarding.status.read",
    "screening.status.read",
    "training.assignment.read",
    "training.result.read",
    "competency.evaluation.read",
    ["competency.evaluation.record", participant("EVALUATOR")],
    "capability_profile.read",
    "capability_profile.approve",
    "final_review.read",
    ["final_review.start", designated("FINAL_REVIEWER")],
    ["final_review.return", designated("FINAL_REVIEWER")],
    "readiness.read",
    ["readiness.final_approval", designated("READINESS_APPROVER")],
    "compliance_hold.read",
    "compliance_hold.place",
    "compliance_hold.remove",
    "communication.read",
    "candidacy.withdraw",
    "candidacy.reactivate",
    "record.archive",
    "record.export.standard",
    "audit.business.read",
    ["audit.restricted.read", designated("RESTRICTED_AUDIT_REVIEWER")],
    "role_assignment.propose",
    "role_assignment.approve",
    "role_assignment.revoke",
    "role_assignment.read",
    edit("position_template"),
    edit("retention_rule"),
    ...configAreas.flatMap((area) => [
      ...(area === "retention_rule"
        ? ([[publish(area), designated("RETENTION_AUTHORITY")]] as const)
        : [publish(area)]),
      history(area),
    ]),
    "configuration.requirement.read",
  ],

  SYSTEM_ADMINISTRATOR: [
    "role_assignment.propose",
    "role_assignment.revoke",
    "role_assignment.read",
    "staff_account.invite",
    "staff_account.restrict",
    "staff_account.restore",
    "staff_recovery.manage",
    "authentication.configuration.manage",
    "provider.configuration.manage",
    "technical_configuration.manage",
    "system_health.read",
    "technical_log.read",
    "security_event.read",
  ],

  AUDITOR_READ_ONLY: [
    "candidate.read.assigned",
    "application.read",
    "recruiting_note.read",
    "interview.schedule.read",
    "interview.scorecard.read",
    "selection.read",
    "compensation.read",
    "classification.proposal.read",
    "classification.analysis.read",
    "classification.decision.read",
    "offer.read",
    "onboarding.form.read",
    "identity_document.read_restricted",
    "tax_banking_document.read_restricted",
    "screening.authorization.read",
    "screening.result.read_restricted",
    "medical_document.read_restricted",
    "adverse_action.read_restricted",
    "training.assignment.read",
    "competency.evaluation.read",
    "capability_profile.read",
    "final_review.read",
    "readiness.read",
    "compliance_hold.read",
    "communication.read",
    "audit.read.assigned",
    "audit.export.assigned",
    "audit.restricted.read.assigned",
    "audit.restricted.export.assigned",
    "record.export.assigned",
    "role_assignment.read",
    ...configAreas.map(history),
    "configuration.requirement.read",
  ],
};

export const grantCatalog: readonly GrantDefinition[] = Object.freeze(
  (Object.entries(grantSpecs) as [RoleCode, readonly Spec[]][]).flatMap(
    ([roleCode, specs]) =>
      specs.map((spec) =>
        Object.freeze({
          roleCode,
          permissionCode: typeof spec === "string" ? spec : spec[0],
          condition: typeof spec === "string" ? null : spec[1],
          status: "ACTIVE" as const,
        }),
      ),
  ),
);

/**
 * Matrix cells deliberately not granted (or granted only conditionally)
 * pending an approved decision (packet §16, matrix §20). Recorded here so
 * the matrix traceability guard and ADR-0005 stay in step.
 */
export const pendingMatrixDecisions: readonly Readonly<{
  matrixRef: string;
  roles: string;
  cell: string;
  interpretation: string;
}>[] = Object.freeze([
  {
    matrixRef: "§7:Other candidate profiles",
    roles: "TRN",
    cell: "V limited",
    interpretation: "candidate.summary.read only",
  },
  {
    matrixRef: "§7:Internal recruiting notes",
    roles: "CLR, COM",
    cell: "V limited",
    interpretation: "no grant",
  },
  {
    matrixRef: "§7:Interview scorecards",
    roles: "CLR, COM",
    cell: "V limited",
    interpretation: "no grant",
  },
  {
    matrixRef: "§7:Compensation proposal",
    roles: "CLR",
    cell: "V limited",
    interpretation: "no grant",
  },
  {
    matrixRef: "§7:Classification analysis",
    roles: "REC; HR, COM",
    cell: "Status only; V limited",
    interpretation: "REC classification.status.read; HR/COM no grant",
  },
  {
    matrixRef: "§7:General onboarding forms",
    roles: "CLR",
    cell: "V limited",
    interpretation: "no grant",
  },
  {
    matrixRef: "§7:I-9/identity documents",
    roles: "HR, COM",
    cell: "Restricted CERA; V if designated",
    interpretation: "DESIGNATION RESTRICTED_IDENTITY_REVIEWER (matrix §20)",
  },
  {
    matrixRef: "§7:Tax and banking documents",
    roles: "HR",
    cell: "Restricted CERA",
    interpretation: "DESIGNATION RESTRICTED_IDENTITY_REVIEWER (matrix §20)",
  },
  {
    matrixRef: "§7:Criminal/registry report",
    roles: "MGR",
    cell: "Status/exception only",
    interpretation: "screening.status.read only; exception view pending",
  },
  {
    matrixRef: "§7:Drug-screen record",
    roles: "MGR",
    cell: "Status/exception only",
    interpretation: "screening.status.read only; exception view pending",
  },
  {
    matrixRef: "§7:TB/medical record",
    roles: "MGR",
    cell: "Status/exception only",
    interpretation: "screening.status.read only; exception view pending",
  },
  {
    matrixRef: "§7:Adverse/dispute case",
    roles: "MGR",
    cell: "Restricted oversight",
    interpretation: "no grant",
  },
  {
    matrixRef: "§7:Final review",
    roles: "TRN",
    cell: "V evidence only",
    interpretation: "no grant",
  },
  {
    matrixRef: "§7:Holds and deficiencies",
    roles: "REC",
    cell: "C/V scoped (vs §8 limited operational request)",
    interpretation: "compliance_hold.read only",
  },
  {
    matrixRef: "§7:Candidate communications",
    roles: "CLR, TRN; MGR",
    cell: "C limited; V/M",
    interpretation: "CLR/TRN no grant; MGR communication.read only",
  },
  {
    matrixRef: "§7:Business audit timeline",
    roles: "REC, HR, CLR, TRN",
    cell: "V limited",
    interpretation: "no grant",
  },
  {
    matrixRef: "§7:Requirement configuration",
    roles: "CLR, TRN",
    cell: "V classification; V training",
    interpretation: "area history.read only",
  },
  {
    matrixRef: "§7:User and role configuration",
    roles: "MGR; ADM",
    cell: "Request changes; M",
    interpretation:
      "MGR propose/approve/revoke per §14; ADM propose/revoke (implements), never approves",
  },
  {
    matrixRef: "§7 (all rows)",
    roles: "ADM",
    cell: "Support / template / catalog / technical support",
    interpretation:
      "no business permission (support access arrives with break-glass/support design)",
  },
  {
    matrixRef: "§8:Save own application",
    roles: "HR",
    cell: "Assist only",
    interpretation: "application.assist, no grant",
  },
  {
    matrixRef: "§8:Submit application",
    roles: "REC, HR",
    cell: "Documented assist",
    interpretation: "application.assist, no grant",
  },
  {
    matrixRef: "§8:Accept/decline offer",
    roles: "REC, HR",
    cell: "Documented assist",
    interpretation: "application.assist, no grant",
  },
  {
    matrixRef: "§8:Withdraw candidacy",
    roles: "REC, HR",
    cell: "Documented assist",
    interpretation: "application.assist, no grant",
  },
  {
    matrixRef: "§8:Record screening result",
    roles: "HR",
    cell: "Intake only",
    interpretation: "screening.result.intake, no grant",
  },
  {
    matrixRef: "§8:Start adverse-action process",
    roles: "HR; MGR",
    cell: "Administrative support; Oversight",
    interpretation: "no grant",
  },
  {
    matrixRef: "§8:Decide screening disposition",
    roles: "MGR",
    cell: "Oversight only",
    interpretation: "no grant",
  },
  {
    matrixRef: "§8:Reactivate candidacy",
    roles: "REC, HR; COM, TRN",
    cell: "Request; Review if applicable",
    interpretation: "no grant",
  },
  {
    matrixRef: "§8:Archive record",
    roles: "HR, COM; ADM",
    cell: "Request; Technical operation after approval",
    interpretation: "no grant",
  },
  {
    matrixRef: "§8:Export records",
    roles: "REC, HR, CLR, TRN; MGR; ADM",
    cell: "Limited approved export; X; Technical export after approval",
    interpretation:
      "record.export.standard with recorded approval; MGR standard only; ADM no grant",
  },
  {
    matrixRef: "§8:Place compliance hold",
    roles: "REC",
    cell: "Limited operational request",
    interpretation: "no grant",
  },
  {
    matrixRef: "§8:Complete prescreen",
    roles: "MGR",
    cell: "V/A if designated",
    interpretation: "DESIGNATION PRESCREEN_APPROVER",
  },
  {
    matrixRef: "§8:Approve offer",
    roles: "HR",
    cell: "A if designated",
    interpretation: "DESIGNATION OFFER_APPROVER",
  },
  {
    matrixRef: "§8:Decide contractor classification",
    roles: "MGR",
    cell: "A if designated",
    interpretation: "DESIGNATION CLASSIFICATION_APPROVER (matrix §20)",
  },
  {
    matrixRef: "§8:Approve onboarding item",
    roles: "COM",
    cell: "A if designated",
    interpretation: "DESIGNATION ONBOARDING_APPROVER",
  },
  {
    matrixRef: "§8:Start final compliance review",
    roles: "MGR",
    cell: "C if designated",
    interpretation: "DESIGNATION FINAL_REVIEWER",
  },
  {
    matrixRef: "§8:Return final review with deficiencies",
    roles: "MGR",
    cell: "A if designated",
    interpretation: "DESIGNATION FINAL_REVIEWER",
  },
  {
    matrixRef: "§8:Approve Ready for Assignment",
    roles: "MGR",
    cell: "A if configured",
    interpretation:
      "DESIGNATION READINESS_APPROVER; FINAL_READINESS dual control on (matrix §20)",
  },
  {
    matrixRef: "§14:Classification questionnaire",
    roles: "legal reviewer",
    cell: "MGR/authorized legal reviewer",
    interpretation: "MGR only; no legal-reviewer role",
  },
  {
    matrixRef: "§14:Screening requirement matrix",
    roles: "COM",
    cell: "MGR/COM approver",
    interpretation: "COM publish requires DESIGNATION CONFIGURATION_APPROVER",
  },
  {
    matrixRef: "§14:Retention rules",
    roles: "MGR",
    cell: "Designated authority",
    interpretation:
      "DESIGNATION RETENTION_AUTHORITY; RETENTION_LEGAL_HOLD dual control",
  },
  {
    matrixRef: "§14:Roles and permissions",
    roles: "security owner",
    cell: "MGR/security owner approves",
    interpretation: "MGR approves; no security-owner role",
  },
  {
    matrixRef: "§9.2",
    roles: "all",
    cell: "Manual compliance waiver",
    interpretation: "compliance.waiver.approve, no grant",
  },
  {
    matrixRef: "§12.2, §12.3",
    roles: "all",
    cell: "Impersonation, break-glass",
    interpretation: "permissions defined, no grant",
  },
]);

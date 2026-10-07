import type { ReauthenticationPurpose } from "../domain/authentication-assurance";
import type {
  CatalogStatus,
  DualControlHook,
  Operation,
  PermissionDomain,
  SensitivityLevel,
  SeparationPolicyCode,
  WorkflowPolicyCode,
} from "../domain/authorization-vocabulary";

// Reviewed Release 1 permission catalog (packet M1.4 §8, ADR-0005). This
// TypeScript manifest is the single authoritative source: the catalog
// apply script writes it to `auth.permission`, and drift between this file,
// the database, and ROLE_PERMISSION_MATRIX.md fails CI.
//
// Rules: narrow `<resource>.<action>` codes; no wildcard, `all`, `admin`,
// prefix, or inherited permission; view, edit, approve, download, export,
// configure, and role-manage are distinct. Codes are never deleted or
// reused: retire them by setting `status: "RETIRED"`. A permission is a
// maximum capability only; scope, sensitivity, workflow, separation, and
// recent authentication can still deny.
//
// `matrixRefs` trace each permission to ROLE_PERMISSION_MATRIX.md: `§7:` data
// domains, `§8:` workflow commands, `§14:` configuration areas, plus other
// sections. Documentation only; they are not stored in the database.

export type RecentAuthRequirement = Readonly<{
  policy: "RECENT_STAFF_AUTH" | "RECENT_STRONG_AUTH";
  purpose: ReauthenticationPurpose;
}>;

export type PermissionDefinition = Readonly<{
  code: string;
  resource: string;
  action: string;
  operation: Operation;
  maxSensitivity: SensitivityLevel;
  domain: PermissionDomain;
  description: string;
  status: CatalogStatus;
  /** Staff grants need a resolved scope; candidate-self needs ownership. */
  requiresScope: boolean;
  workflowPolicy: WorkflowPolicyCode | null;
  recentAuth: RecentAuthRequirement | null;
  separationPolicy: SeparationPolicyCode | null;
  dualControlHook: DualControlHook | null;
  requiresReason: boolean;
  restrictedData: boolean;
  isExport: boolean;
  highRisk: boolean;
  matrixRefs: readonly string[];
}>;

const restricted: readonly SensitivityLevel[] = [
  "RESTRICTED_IDENTITY_FINANCIAL",
  "RESTRICTED_SCREENING_MEDICAL",
  "SECURITY_AUDIT_RESTRICTED",
];

type Options = Readonly<{
  workflow?: boolean;
  recentAuth?: RecentAuthRequirement;
  separation?: SeparationPolicyCode;
  dual?: DualControlHook;
  reason?: boolean;
  status?: CatalogStatus;
}>;

const INT = "INTERNAL";
const CP = "CONFIDENTIAL_PERSONNEL";
const RIF = "RESTRICTED_IDENTITY_FINANCIAL";
const RSM = "RESTRICTED_SCREENING_MEDICAL";
const SAR = "SECURITY_AUDIT_RESTRICTED";

const restrictedRead: RecentAuthRequirement = {
  policy: "RECENT_STAFF_AUTH",
  purpose: "RESTRICTED_DATA_ACCESS",
};
const strongApproval: RecentAuthRequirement = {
  policy: "RECENT_STRONG_AUTH",
  purpose: "HIGH_RISK_APPROVAL",
};
const strongExport: RecentAuthRequirement = {
  policy: "RECENT_STRONG_AUTH",
  purpose: "RESTRICTED_EXPORT",
};
const strongAccess: RecentAuthRequirement = {
  policy: "RECENT_STRONG_AUTH",
  purpose: "PRIVILEGED_ACCESS_CHANGE",
};
const recentAccess: RecentAuthRequirement = {
  policy: "RECENT_STAFF_AUTH",
  purpose: "PRIVILEGED_ACCESS_CHANGE",
};

function p(
  resource: string,
  action: string,
  operation: Operation,
  maxSensitivity: SensitivityLevel,
  domain: PermissionDomain,
  description: string,
  matrixRefs: readonly string[],
  options: Options = {},
): PermissionDefinition {
  const restrictedData = restricted.includes(maxSensitivity);
  return Object.freeze({
    code: `${resource}.${action}`,
    resource,
    action,
    operation,
    maxSensitivity,
    domain,
    description,
    status: options.status ?? "ACTIVE",
    requiresScope: domain !== "CANDIDATE_SELF",
    workflowPolicy: options.workflow ? "CANDIDACY_WORKFLOW" : null,
    recentAuth: options.recentAuth ?? null,
    separationPolicy: options.separation ?? null,
    dualControlHook: options.dual ?? null,
    requiresReason: options.reason ?? false,
    restrictedData,
    isExport: operation === "EXPORT",
    highRisk:
      restrictedData ||
      options.recentAuth !== undefined ||
      options.dual !== undefined ||
      operation === "EXPORT",
    matrixRefs: Object.freeze([...matrixRefs]),
  });
}

const S = "BUSINESS" as const;
const T = "TECHNICAL" as const;
const C = "CANDIDATE_SELF" as const;
const wf = { workflow: true } as const;

// ---------------------------------------------------------------- candidate
const candidateSelf = [
  p(
    "candidate",
    "own_profile.read",
    "READ",
    CP,
    C,
    "Read own candidate profile",
    ["§7:Own candidate profile", "§11"],
  ),
  p(
    "candidate",
    "own_profile.edit",
    "EDIT",
    CP,
    C,
    "Edit permitted own profile fields",
    ["§7:Own candidate profile", "§11"],
    wf,
  ),
  p(
    "application",
    "own.edit",
    "EDIT",
    CP,
    C,
    "Start and save own application before submission",
    [
      "§7:Application answers",
      "§8:Start own application",
      "§8:Save own application",
    ],
    wf,
  ),
  p(
    "application",
    "own.submit",
    "CREATE",
    CP,
    C,
    "Submit own application",
    ["§8:Submit application"],
    wf,
  ),
  p(
    "interview",
    "own_schedule.read",
    "READ",
    INT,
    C,
    "Read own interview schedule",
    ["§7:Interview schedule"],
  ),
  p(
    "interview",
    "own_schedule.self_schedule",
    "EDIT",
    INT,
    C,
    "Self-schedule an invited interview",
    ["§8:Schedule interview"],
    wf,
  ),
  p(
    "offer",
    "own.read",
    "READ",
    CP,
    C,
    "Read own released offer, agreement, and selection message",
    [
      "§7:Offer or agreement",
      "§7:Compensation proposal",
      "§7:Selection decision",
    ],
  ),
  p(
    "offer",
    "own.respond",
    "EDIT",
    CP,
    C,
    "Accept, decline, or sign own offer or agreement",
    ["§7:Offer or agreement", "§8:Accept/decline offer"],
    wf,
  ),
  p(
    "onboarding",
    "own_form.complete",
    "EDIT",
    CP,
    C,
    "Complete own general onboarding forms and screening authorization",
    ["§7:General onboarding forms", "§7:Screening authorization"],
    wf,
  ),
  p(
    "onboarding",
    "own_restricted_document.submit",
    "CREATE",
    RIF,
    C,
    "Submit own identity, tax, and banking documents",
    ["§7:I-9/identity documents", "§7:Tax and banking documents"],
    wf,
  ),
  p(
    "screening",
    "own_action.complete",
    "CREATE",
    RSM,
    C,
    "Complete own screening actions, uploads, and dispute responses",
    [
      "§7:Criminal/registry report",
      "§7:Drug-screen record",
      "§7:TB/medical record",
      "§7:Adverse/dispute case",
      "§8:Initiate screening",
      "§8:Record screening result",
      "§8:Start adverse-action process",
    ],
    wf,
  ),
  p(
    "training",
    "own.complete",
    "EDIT",
    CP,
    C,
    "Complete own learner and evaluation-attendance actions",
    [
      "§7:Training assignment",
      "§8:Record training result",
      "§8:Record competency result",
    ],
    wf,
  ),
  p(
    "candidacy",
    "own_status.read",
    "READ",
    INT,
    C,
    "Read own candidate-facing status, summaries, and messages",
    [
      "§7:Classification proposal",
      "§7:Classification decision",
      "§7:Competency evaluation",
      "§7:Capability profile",
      "§7:Final review",
      "§7:Readiness record",
      "§7:Holds and deficiencies",
      "§7:Candidate communications",
    ],
  ),
  p(
    "candidacy",
    "own.withdraw",
    "EDIT",
    INT,
    C,
    "Withdraw own candidacy",
    ["§8:Withdraw candidacy"],
    wf,
  ),
  p(
    "candidacy",
    "own.request_reactivation",
    "CREATE",
    INT,
    C,
    "Request reactivation of own candidacy",
    ["§8:Reactivate candidacy"],
    wf,
  ),
  p(
    "record",
    "export.own_documents",
    "EXPORT",
    CP,
    C,
    "Export own provided documents",
    ["§8:Export records"],
  ),
];

// --------------------------------------------------------- recruiting
const recruiting = [
  p(
    "candidate",
    "read.assigned",
    "READ",
    CP,
    S,
    "Read candidate profiles within scope",
    ["§7:Own candidate profile", "§7:Other candidate profiles"],
  ),
  p(
    "candidate",
    "summary.read",
    "READ",
    INT,
    S,
    "Read a limited candidate summary",
    ["§7:Other candidate profiles"],
  ),
  p(
    "candidate",
    "profile.edit",
    "EDIT",
    CP,
    S,
    "Edit candidate profile fields",
    ["§7:Own candidate profile"],
    wf,
  ),
  p("application", "read", "READ", CP, S, "Read application answers", [
    "§7:Application answers",
  ]),
  p(
    "application",
    "review",
    "REVIEW",
    CP,
    S,
    "Review and return an application for correction",
    ["§7:Application answers", "§8:Return application"],
    wf,
  ),
  p(
    "application",
    "start_on_behalf",
    "CREATE",
    CP,
    S,
    "Start an application on a candidate's behalf",
    ["§8:Start own application"],
    wf,
  ),
  p(
    "application",
    "assist",
    "EDIT",
    CP,
    S,
    "Documented assist with candidate actions (pending decision)",
    [
      "§8:Save own application",
      "§8:Submit application",
      "§8:Accept/decline offer",
      "§8:Withdraw candidacy",
    ],
    { workflow: true, reason: true },
  ),
  p(
    "prescreen",
    "begin",
    "REVIEW",
    CP,
    S,
    "Begin prescreen",
    ["§8:Begin prescreen"],
    wf,
  ),
  p(
    "prescreen",
    "complete",
    "APPROVE",
    CP,
    S,
    "Complete prescreen",
    ["§8:Complete prescreen"],
    wf,
  ),
  p(
    "recruiting_note",
    "read",
    "READ",
    CP,
    S,
    "Read internal recruiting notes",
    ["§7:Internal recruiting notes"],
  ),
  p(
    "recruiting_note",
    "write",
    "CREATE",
    CP,
    S,
    "Create and edit internal recruiting notes",
    ["§7:Internal recruiting notes"],
  ),
  p("interview", "schedule.read", "READ", INT, S, "Read interview schedules", [
    "§7:Interview schedule",
  ]),
  p(
    "interview",
    "schedule.manage",
    "EDIT",
    INT,
    S,
    "Create and manage interview schedules",
    ["§7:Interview schedule", "§8:Schedule interview"],
    wf,
  ),
  p("interview", "scorecard.read", "READ", CP, S, "Read interview scorecards", [
    "§7:Interview scorecards",
  ]),
  p(
    "interview",
    "scorecard.submit",
    "CREATE",
    CP,
    S,
    "Submit an interview scorecard as an interviewer",
    ["§7:Interview scorecards", "§8:Submit interview scorecard"],
    wf,
  ),
  p(
    "interview",
    "scorecard.review",
    "REVIEW",
    CP,
    S,
    "Review and return interview scorecards",
    ["§7:Interview scorecards"],
    wf,
  ),
  p("selection", "read", "READ", CP, S, "Read selection decisions", [
    "§7:Selection decision",
  ]),
  p(
    "selection",
    "decide",
    "APPROVE",
    CP,
    S,
    "Select or not select a candidate",
    ["§7:Selection decision", "§8:Select/not select"],
    { workflow: true, reason: true },
  ),
];

// ------------------------------------------------- offer and compensation
const offer = [
  p("compensation", "read", "READ", CP, S, "Read compensation proposals", [
    "§7:Compensation proposal",
  ]),
  p(
    "compensation",
    "propose",
    "EDIT",
    CP,
    S,
    "Create or edit a compensation proposal",
    ["§7:Compensation proposal"],
    wf,
  ),
  p(
    "compensation",
    "approve",
    "APPROVE",
    CP,
    S,
    "Approve a compensation proposal",
    ["§7:Compensation proposal", "§9.1:6", "§9.2"],
    {
      workflow: true,
      separation: "OFFER_SELF_APPROVAL",
      dual: "OFFER_COMPENSATION_THRESHOLD",
      reason: true,
    },
  ),
  p(
    "offer",
    "draft.create",
    "CREATE",
    CP,
    S,
    "Create an offer draft",
    ["§8:Create offer draft"],
    wf,
  ),
  p("offer", "read", "READ", CP, S, "Read offers and agreements", [
    "§7:Offer or agreement",
  ]),
  p(
    "offer",
    "edit",
    "EDIT",
    CP,
    S,
    "Edit an offer before finalization",
    ["§7:Offer or agreement"],
    wf,
  ),
  p(
    "offer",
    "review",
    "REVIEW",
    CP,
    S,
    "Review and return an offer",
    ["§7:Offer or agreement"],
    wf,
  ),
  p(
    "offer",
    "approve",
    "APPROVE",
    CP,
    S,
    "Approve an offer",
    ["§7:Offer or agreement", "§8:Approve offer", "§9.1:6"],
    {
      workflow: true,
      separation: "OFFER_SELF_APPROVAL",
      dual: "OFFER_COMPENSATION_THRESHOLD",
      reason: true,
    },
  ),
  p(
    "offer",
    "issue",
    "CREATE",
    CP,
    S,
    "Issue an approved offer",
    ["§8:Issue/withdraw offer"],
    wf,
  ),
  p(
    "offer",
    "withdraw",
    "EDIT",
    CP,
    S,
    "Withdraw an issued offer",
    ["§8:Issue/withdraw offer"],
    { workflow: true, reason: true },
  ),
];

// --------------------------------------------------------- classification
const classification = [
  p(
    "classification",
    "path.propose",
    "CREATE",
    CP,
    S,
    "Propose the W-2 or 1099 path",
    ["§7:Classification proposal", "§8:Propose W-2 or 1099 path"],
    wf,
  ),
  p(
    "classification",
    "proposal.read",
    "READ",
    CP,
    S,
    "Read classification proposals",
    ["§7:Classification proposal"],
  ),
  p(
    "classification",
    "review.start",
    "CREATE",
    CP,
    S,
    "Start a classification review",
    ["§8:Start classification review"],
    wf,
  ),
  p(
    "classification",
    "analysis.read",
    "READ",
    CP,
    S,
    "Read classification analysis",
    ["§7:Classification analysis"],
  ),
  p(
    "classification",
    "analysis.edit",
    "EDIT",
    CP,
    S,
    "Create, edit, and return classification analysis",
    ["§7:Classification analysis"],
    wf,
  ),
  p(
    "classification",
    "review.decide",
    "APPROVE",
    CP,
    S,
    "Decide worker classification",
    [
      "§7:Classification decision",
      "§8:Decide contractor classification",
      "§9.1:1",
      "§15.2",
    ],
    {
      workflow: true,
      recentAuth: strongApproval,
      separation: "CLASSIFICATION_SELF_APPROVAL",
      dual: "CLASSIFICATION_DECISION",
      reason: true,
    },
  ),
  p(
    "classification",
    "decision.read",
    "READ",
    CP,
    S,
    "Read classification decisions",
    ["§7:Classification decision"],
  ),
  p(
    "classification",
    "status.read",
    "READ",
    INT,
    S,
    "Read classification review status only",
    ["§7:Classification analysis"],
  ),
];

// ------------------------------------- onboarding, identity, and financial
const onboarding = [
  p("onboarding", "form.read", "READ", CP, S, "Read general onboarding forms", [
    "§7:General onboarding forms",
  ]),
  p(
    "onboarding",
    "form.edit",
    "EDIT",
    CP,
    S,
    "Create and edit general onboarding forms",
    ["§7:General onboarding forms"],
    wf,
  ),
  p(
    "onboarding",
    "item.review",
    "REVIEW",
    CP,
    S,
    "Review and return an onboarding item",
    ["§7:General onboarding forms"],
    wf,
  ),
  p(
    "onboarding",
    "item.approve",
    "APPROVE",
    CP,
    S,
    "Approve an onboarding item",
    ["§7:General onboarding forms", "§8:Approve onboarding item", "§9.1:2"],
    { workflow: true, separation: "CANDIDATE_SELF_VERIFICATION" },
  ),
  p(
    "onboarding",
    "status.read",
    "READ",
    INT,
    S,
    "Read onboarding status only",
    [
      "§7:General onboarding forms",
      "§7:I-9/identity documents",
      "§7:Tax and banking documents",
    ],
  ),
  p(
    "identity_document",
    "read_masked",
    "READ",
    RIF,
    S,
    "Read masked identity-document metadata",
    ["§7:I-9/identity documents", "§10.1"],
  ),
  p(
    "identity_document",
    "read_restricted",
    "READ",
    RIF,
    S,
    "Read full identity-document values",
    ["§7:I-9/identity documents", "§15.2"],
    { recentAuth: restrictedRead, reason: true },
  ),
  p(
    "identity_document",
    "download",
    "DOWNLOAD",
    RIF,
    S,
    "Download identity documents",
    ["§7:I-9/identity documents", "§10.2", "§15.2"],
    { recentAuth: restrictedRead, reason: true },
  ),
  p(
    "identity_document",
    "manage",
    "EDIT",
    RIF,
    S,
    "Create, edit, review, and approve identity documents",
    ["§7:I-9/identity documents"],
    { workflow: true, recentAuth: restrictedRead },
  ),
  p(
    "tax_banking_document",
    "read_restricted",
    "READ",
    RIF,
    S,
    "Read full tax and banking values",
    ["§7:Tax and banking documents", "§15.2"],
    { recentAuth: restrictedRead, reason: true },
  ),
  p(
    "tax_banking_document",
    "download",
    "DOWNLOAD",
    RIF,
    S,
    "Download tax and banking documents",
    ["§7:Tax and banking documents", "§10.2"],
    { recentAuth: restrictedRead, reason: true },
  ),
  p(
    "tax_banking_document",
    "manage",
    "EDIT",
    RIF,
    S,
    "Create, edit, review, and approve tax and banking documents",
    ["§7:Tax and banking documents", "§15.2"],
    {
      workflow: true,
      recentAuth: {
        policy: "RECENT_STRONG_AUTH",
        purpose: "RESTRICTED_DATA_ACCESS",
      },
    },
  ),
];

// ------------------------------------------------- screening and medical
const screening = [
  p(
    "screening",
    "authorization.read",
    "READ",
    CP,
    S,
    "Read screening authorizations",
    ["§7:Screening authorization"],
  ),
  p(
    "screening",
    "authorization.manage",
    "EDIT",
    CP,
    S,
    "Create screening authorization requests",
    ["§7:Screening authorization"],
    wf,
  ),
  p(
    "screening",
    "authorization.review",
    "REVIEW",
    CP,
    S,
    "Review and return screening authorizations",
    ["§7:Screening authorization"],
    wf,
  ),
  p(
    "screening",
    "initiate",
    "CREATE",
    CP,
    S,
    "Initiate screening",
    ["§8:Initiate screening"],
    wf,
  ),
  p(
    "screening",
    "status.read",
    "READ",
    INT,
    S,
    "Read screening and clearance status only",
    [
      "§7:Screening authorization",
      "§7:Criminal/registry report",
      "§7:Drug-screen record",
      "§7:TB/medical record",
      "§7:Adverse/dispute case",
    ],
  ),
  p(
    "screening",
    "result.record",
    "CREATE",
    RSM,
    S,
    "Record a restricted screening result",
    ["§8:Record screening result"],
    wf,
  ),
  p(
    "screening",
    "result.intake",
    "CREATE",
    RSM,
    S,
    "Intake a screening result (pending decision)",
    ["§8:Record screening result"],
    wf,
  ),
  p(
    "screening",
    "result.read_restricted",
    "READ",
    RSM,
    S,
    "Read restricted criminal, registry, and drug-screen results",
    ["§7:Criminal/registry report", "§7:Drug-screen record", "§15.2"],
    { recentAuth: restrictedRead, reason: true },
  ),
  p(
    "screening",
    "report.download",
    "DOWNLOAD",
    RSM,
    S,
    "Download restricted screening reports",
    ["§7:Criminal/registry report", "§10.2", "§15.2"],
    { recentAuth: restrictedRead, reason: true },
  ),
  p(
    "screening",
    "disposition.decide",
    "APPROVE",
    RSM,
    S,
    "Decide screening disposition",
    [
      "§7:Criminal/registry report",
      "§7:Drug-screen record",
      "§8:Decide screening disposition",
      "§9.1:3",
    ],
    {
      workflow: true,
      recentAuth: strongApproval,
      separation: "RESTRICTED_RESULT_ENTRANT",
      dual: "HIGH_RISK_SCREENING_DISPOSITION",
      reason: true,
    },
  ),
  p(
    "medical_document",
    "read_restricted",
    "READ",
    RSM,
    S,
    "Read TB and medical records",
    ["§7:TB/medical record", "§15.2"],
    { recentAuth: restrictedRead, reason: true },
  ),
  p(
    "medical_document",
    "download",
    "DOWNLOAD",
    RSM,
    S,
    "Download TB and medical documents",
    ["§7:TB/medical record", "§10.2", "§15.2"],
    { recentAuth: restrictedRead, reason: true },
  ),
  p(
    "medical_clearance",
    "decide",
    "APPROVE",
    RSM,
    S,
    "Approve TB/medical clearance",
    ["§7:TB/medical record", "§9.1:2"],
    {
      workflow: true,
      recentAuth: {
        policy: "RECENT_STAFF_AUTH",
        purpose: "HIGH_RISK_APPROVAL",
      },
      separation: "CANDIDATE_SELF_VERIFICATION",
      reason: true,
    },
  ),
  p(
    "adverse_action",
    "read_restricted",
    "READ",
    RSM,
    S,
    "Read adverse-action and dispute cases",
    ["§7:Adverse/dispute case"],
    { recentAuth: restrictedRead, reason: true },
  ),
  p(
    "adverse_action",
    "start",
    "CREATE",
    RSM,
    S,
    "Start the adverse-action process",
    ["§8:Start adverse-action process"],
    { workflow: true, reason: true },
  ),
  p(
    "adverse_action",
    "manage",
    "EDIT",
    RSM,
    S,
    "Edit and review adverse-action and dispute cases",
    ["§7:Adverse/dispute case"],
    wf,
  ),
  p(
    "adverse_action",
    "final_record",
    "APPROVE",
    RSM,
    S,
    "Record final adverse action",
    ["§7:Adverse/dispute case", "§15.2"],
    {
      workflow: true,
      recentAuth: strongApproval,
      separation: "CANDIDATE_SELF_VERIFICATION",
      reason: true,
    },
  ),
];

// -------------------------------- training, competency, and readiness
const readiness = [
  p("training", "assignment.read", "READ", CP, S, "Read training assignments", [
    "§7:Training assignment",
  ]),
  p(
    "training",
    "assignment.manage",
    "EDIT",
    CP,
    S,
    "Assign and manage training",
    ["§7:Training assignment", "§8:Assign training"],
    wf,
  ),
  p(
    "training",
    "status.read",
    "READ",
    INT,
    S,
    "Read training and competency status only",
    ["§7:Training assignment", "§7:Competency evaluation"],
  ),
  p("training", "result.read", "READ", CP, S, "Read training results", [
    "§8:Record training result",
  ]),
  p(
    "training",
    "result.record",
    "APPROVE",
    CP,
    S,
    "Record a training result",
    ["§8:Record training result", "§9.1:2"],
    { workflow: true, separation: "CANDIDATE_SELF_VERIFICATION" },
  ),
  p(
    "competency",
    "evaluation.read",
    "READ",
    CP,
    S,
    "Read competency evaluations",
    ["§7:Competency evaluation"],
  ),
  p(
    "competency",
    "evaluation.record",
    "APPROVE",
    CP,
    S,
    "Record a competency result",
    ["§7:Competency evaluation", "§8:Record competency result", "§9.1:2"],
    { workflow: true, separation: "CANDIDATE_SELF_VERIFICATION" },
  ),
  p(
    "competency",
    "evaluation.edit",
    "EDIT",
    CP,
    S,
    "Edit an unsigned competency evaluation",
    ["§7:Competency evaluation", "§9.1:4"],
    { workflow: true, separation: "SIGNED_EVALUATION_IMMUTABLE" },
  ),
  p(
    "competency",
    "evaluation.amend",
    "CREATE",
    CP,
    S,
    "Amend a signed evaluation with a new version",
    ["§7:Competency evaluation", "§9.1:4"],
    { workflow: true, reason: true },
  ),
  p("capability_profile", "read", "READ", CP, S, "Read capability profiles", [
    "§7:Capability profile",
  ]),
  p(
    "capability_profile",
    "edit",
    "EDIT",
    CP,
    S,
    "Create and return capability profiles",
    ["§7:Capability profile"],
    wf,
  ),
  p(
    "capability_profile",
    "approve",
    "APPROVE",
    CP,
    S,
    "Approve a capability profile",
    ["§7:Capability profile", "§9.1:2"],
    { workflow: true, separation: "CANDIDATE_SELF_VERIFICATION" },
  ),
  p("final_review", "read", "READ", CP, S, "Read final compliance reviews", [
    "§7:Final review",
  ]),
  p(
    "final_review",
    "start",
    "CREATE",
    CP,
    S,
    "Start a final compliance review",
    ["§7:Final review", "§8:Start final compliance review"],
    wf,
  ),
  p(
    "final_review",
    "edit",
    "EDIT",
    CP,
    S,
    "Edit a final compliance review",
    ["§7:Final review"],
    wf,
  ),
  p(
    "final_review",
    "return",
    "REVIEW",
    CP,
    S,
    "Return a final review with deficiencies",
    ["§7:Final review", "§8:Return final review with deficiencies"],
    { workflow: true, reason: true },
  ),
  p("readiness", "read", "READ", CP, S, "Read readiness records", [
    "§7:Readiness record",
  ]),
  p(
    "readiness",
    "final_approval",
    "APPROVE",
    CP,
    S,
    "Approve Ready for Assignment",
    [
      "§7:Readiness record",
      "§7:Final review",
      "§8:Approve Ready for Assignment",
      "§9.1:7",
      "§15.2",
    ],
    {
      workflow: true,
      recentAuth: strongApproval,
      separation: "READINESS_APPROVAL",
      dual: "FINAL_READINESS",
      reason: true,
    },
  ),
];

// ----------------------------------------------- holds and communications
const holds = [
  p("compliance_hold", "read", "READ", CP, S, "Read holds and deficiencies", [
    "§7:Holds and deficiencies",
  ]),
  p(
    "compliance_hold",
    "place",
    "CREATE",
    CP,
    S,
    "Place a compliance hold",
    ["§7:Holds and deficiencies", "§8:Place compliance hold"],
    { workflow: true, reason: true },
  ),
  p(
    "compliance_hold",
    "remove",
    "EDIT",
    CP,
    S,
    "Remove a compliance hold",
    ["§7:Holds and deficiencies", "§8:Remove compliance hold"],
    { workflow: true, reason: true },
  ),
  p(
    "compliance",
    "waiver.approve",
    "APPROVE",
    CP,
    S,
    "Approve a manual compliance waiver (pending decision)",
    ["§9.2"],
    {
      workflow: true,
      recentAuth: strongApproval,
      dual: "MANUAL_COMPLIANCE_WAIVER",
      reason: true,
    },
  ),
  p("communication", "read", "READ", CP, S, "Read candidate communications", [
    "§7:Candidate communications",
  ]),
  p(
    "communication",
    "send",
    "CREATE",
    CP,
    S,
    "Create and send candidate communications",
    ["§7:Candidate communications"],
  ),
];

// ------------------------------------------------ lifecycle and exports
const lifecycle = [
  p(
    "candidacy",
    "withdraw",
    "EDIT",
    INT,
    S,
    "Withdraw a candidacy",
    ["§8:Withdraw candidacy"],
    { workflow: true, reason: true },
  ),
  p(
    "candidacy",
    "reactivate",
    "APPROVE",
    INT,
    S,
    "Approve reactivation of a candidacy",
    ["§8:Reactivate candidacy"],
    { workflow: true, reason: true },
  ),
  p(
    "record",
    "archive",
    "APPROVE",
    CP,
    S,
    "Approve archiving a record",
    ["§8:Archive record"],
    { workflow: true, reason: true },
  ),
  p(
    "record",
    "export.standard",
    "EXPORT",
    CP,
    S,
    "Export approved nonrestricted records",
    ["§8:Export records", "§13"],
    { separation: "EXPORT_APPROVAL", reason: true },
  ),
  p(
    "record",
    "export.restricted",
    "EXPORT",
    RSM,
    S,
    "Export approved restricted screening and medical records",
    ["§8:Export records", "§13", "§15.2"],
    {
      recentAuth: strongExport,
      separation: "EXPORT_APPROVAL",
      dual: "RESTRICTED_EXPORT",
      reason: true,
    },
  ),
  p(
    "record",
    "export.assigned",
    "EXPORT",
    CP,
    S,
    "Export records within an approved audit assignment",
    ["§8:Export records", "§5.3"],
    { reason: true },
  ),
];

// ----------------------------------------------------------------- audit
const audit = [
  p(
    "audit",
    "business.read",
    "READ",
    CP,
    S,
    "Read the business audit timeline",
    ["§7:Business audit timeline"],
  ),
  p(
    "audit",
    "read.assigned",
    "READ",
    CP,
    S,
    "Read the business audit timeline within an audit assignment",
    ["§7:Business audit timeline", "§5.3"],
  ),
  p(
    "audit",
    "export.assigned",
    "EXPORT",
    CP,
    S,
    "Export the business audit timeline within an audit assignment",
    ["§7:Business audit timeline"],
    { reason: true },
  ),
  p(
    "audit",
    "restricted.read",
    "READ",
    SAR,
    S,
    "Read restricted access audit",
    ["§7:Restricted access audit"],
    { recentAuth: restrictedRead, reason: true },
  ),
  p(
    "audit",
    "restricted.read.assigned",
    "READ",
    SAR,
    S,
    "Read restricted access audit within an audit assignment",
    ["§7:Restricted access audit", "§5.3"],
    { recentAuth: restrictedRead },
  ),
  p(
    "audit",
    "restricted.export.assigned",
    "EXPORT",
    SAR,
    S,
    "Export restricted access audit within an audit assignment",
    ["§7:Restricted access audit"],
    { recentAuth: strongExport, reason: true },
  ),
];

// ------------------------------------------------- configuration (§14)
function configArea(
  area: string,
  row: string,
  label: string,
  publishOptions: Options = {},
) {
  const refs = [`§14:${row}`, "§7:Requirement configuration"];
  return [
    p(
      "configuration",
      `${area}.edit`,
      "CONFIGURE",
      INT,
      S,
      `Create and edit ${label}`,
      refs,
    ),
    p(
      "configuration",
      `${area}.publish`,
      "CONFIGURE",
      INT,
      S,
      `Approve and publish ${label}`,
      refs,
      { reason: true, ...publishOptions },
    ),
    p(
      "configuration",
      `${area}.history.read`,
      "READ",
      INT,
      S,
      `Read ${label} version history`,
      refs,
    ),
  ];
}

const configuration = [
  ...configArea(
    "position_template",
    "Job and position templates",
    "job and position templates",
  ),
  ...configArea(
    "application_template",
    "Application templates",
    "application templates",
  ),
  ...configArea(
    "scorecard_template",
    "Interview scorecards",
    "interview scorecard templates",
  ),
  ...configArea(
    "classification_questionnaire",
    "Classification questionnaire",
    "the classification questionnaire",
  ),
  ...configArea("offer_template", "Offer templates", "offer templates"),
  ...configArea(
    "screening_requirement_matrix",
    "Screening requirement matrix",
    "the screening requirement matrix",
  ),
  ...configArea(
    "onboarding_requirement_matrix",
    "Onboarding requirement matrix",
    "the onboarding requirement matrix",
  ),
  ...configArea(
    "training_catalog",
    "Training catalog and rules",
    "the training catalog and rules",
  ),
  ...configArea(
    "competency_task_catalog",
    "Competency task catalog",
    "the competency task catalog",
  ),
  ...configArea(
    "message_template",
    "Candidate message templates",
    "candidate message templates",
  ),
  ...configArea("retention_rule", "Retention rules", "retention rules", {
    recentAuth: strongApproval,
    dual: "RETENTION_LEGAL_HOLD",
  }),
  p(
    "configuration",
    "requirement.read",
    "READ",
    INT,
    S,
    "Read published requirement configuration",
    ["§7:Requirement configuration"],
  ),
];

// ---------------------------------------- access and technical (ADM)
const technical = [
  p(
    "role_assignment",
    "propose",
    "ADMINISTER",
    INT,
    T,
    "Propose a staff role/scope assignment",
    [
      "§7:User and role configuration",
      "§12.1",
      "§14:Roles and permissions",
      "§15.2",
    ],
    { recentAuth: strongAccess, reason: true },
  ),
  p(
    "role_assignment",
    "approve",
    "ADMINISTER",
    INT,
    T,
    "Approve or reject a proposed role/scope assignment",
    ["§7:User and role configuration", "§14:Roles and permissions", "§15.2"],
    { recentAuth: strongAccess, reason: true },
  ),
  p(
    "role_assignment",
    "revoke",
    "ADMINISTER",
    INT,
    T,
    "Revoke a role/scope assignment",
    ["§7:User and role configuration", "§12.1", "§14:Roles and permissions"],
    { recentAuth: recentAccess, reason: true },
  ),
  p(
    "role_assignment",
    "read",
    "READ",
    INT,
    T,
    "Read role/scope assignment history",
    ["§7:User and role configuration", "§14:Roles and permissions"],
  ),
  p(
    "staff_account",
    "invite",
    "ADMINISTER",
    INT,
    T,
    "Invite a staff account",
    ["§7:User and role configuration", "§12.1"],
    { recentAuth: strongAccess, reason: true },
  ),
  p(
    "staff_account",
    "restrict",
    "ADMINISTER",
    INT,
    T,
    "Lock or disable a staff account",
    ["§7:User and role configuration", "§12.1"],
    { recentAuth: recentAccess, reason: true },
  ),
  p(
    "staff_account",
    "restore",
    "ADMINISTER",
    INT,
    T,
    "Restore a disabled staff account",
    ["§7:User and role configuration", "§12.1"],
    { recentAuth: strongAccess, reason: true },
  ),
  p(
    "staff_recovery",
    "manage",
    "ADMINISTER",
    SAR,
    T,
    "Process staff recovery and MFA-reset cases",
    ["§7:User and role configuration", "§12.1"],
    { recentAuth: strongAccess, reason: true },
  ),
  p(
    "authentication",
    "configuration.manage",
    "CONFIGURE",
    SAR,
    T,
    "Configure authentication settings",
    ["§12.1"],
    { recentAuth: strongAccess, reason: true },
  ),
  p(
    "provider",
    "configuration.manage",
    "CONFIGURE",
    INT,
    T,
    "Configure external provider settings",
    ["§12.1"],
    { recentAuth: strongAccess, reason: true },
  ),
  p(
    "technical_configuration",
    "manage",
    "CONFIGURE",
    INT,
    T,
    "Manage non-business technical configuration",
    ["§7:Requirement configuration", "§12.1"],
    { reason: true },
  ),
  p("system_health", "read", "READ", INT, T, "Read system health", ["§12.1"]),
  p(
    "technical_log",
    "read",
    "READ",
    INT,
    T,
    "Read technical logs that exclude protected content",
    ["§12.1"],
  ),
  p(
    "security_event",
    "read",
    "READ",
    SAR,
    T,
    "Read security events (security operations)",
    ["§7:Restricted access audit"],
    { recentAuth: restrictedRead, reason: true },
  ),
  p(
    "break_glass",
    "start",
    "ADMINISTER",
    SAR,
    T,
    "Start break-glass access (not implemented; no grant)",
    ["§12.3", "§15.2"],
    {
      recentAuth: { policy: "RECENT_STRONG_AUTH", purpose: "BREAK_GLASS" },
      reason: true,
    },
  ),
  p(
    "impersonation",
    "start",
    "ADMINISTER",
    SAR,
    T,
    "Start user impersonation (disabled; no grant)",
    ["§12.2"],
    { recentAuth: strongAccess, reason: true },
  ),
];

export const permissionCatalog: readonly PermissionDefinition[] = Object.freeze(
  [
    ...candidateSelf,
    ...recruiting,
    ...offer,
    ...classification,
    ...onboarding,
    ...screening,
    ...readiness,
    ...holds,
    ...lifecycle,
    ...audit,
    ...configuration,
    ...technical,
  ],
);

const byCode = new Map(permissionCatalog.map((p) => [p.code, p]));

export function findPermission(code: unknown): PermissionDefinition | null {
  return typeof code === "string" ? (byCode.get(code) ?? null) : null;
}

/** Stable permission-code shape: 2–4 lowercase dotted segments. */
export const permissionCodePattern = /^[a-z][a-z_]*(\.[a-z][a-z_]*){1,3}$/;

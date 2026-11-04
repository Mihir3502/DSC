import "server-only";
import {
  authorize,
  project,
  resolveCurrentCandidate,
  resolveCurrentStaff,
  type AuthorizationRequest,
  type Principal,
  type ProjectionContract,
} from "@/modules/identity-access";
import {
  candidacyWorkflow,
  candidateDependencies,
  candidateStatusCode,
  candidateStatusWording,
  findCandidacyByPublicId,
  isCandidacyPublicId,
  type CandidacyRow,
  type CandidateDependencies,
  type CandidateExecutor,
} from "@/modules/candidates";
import { cycleForCandidacy } from "@/modules/organization";
import {
  listSubmittableAttachments,
  listSubmittedAttachments,
} from "@/modules/documents";
import {
  checkApplication,
  parseTemplate,
  returnReasons,
  type ApplicationTemplate,
  type ReturnReason,
  type TemplateField,
} from "../domain/application-template";
import { reviewTokenFor } from "./application-submission";
import {
  findDraft,
  findEffectiveCertification,
  findEffectiveTemplateVersion,
  findLatestSubmission,
  findLatestVersion,
  findReturn,
  listReturns,
  findTemplateVersion,
  listDraftSections,
  type DraftSectionRow,
} from "../infrastructure/applications-repository";
import {
  applicationOverviewContract,
  applicationReceiptContract,
  applicationReviewContract,
  applicationSectionContract,
  staffApplicationReviewContract,
  type ApplicationOverviewView,
  type StaffApplicationReviewView,
  type ApplicationReceiptView,
  type ApplicationReviewView,
  type ApplicationSectionView,
} from "../presentation/application-views";

// Candidate queries for application drafts (packet M2.4 §7–§8). Each query
// derives the account from the session, authorizes against the requested
// candidacy, and returns one exact projection. Unknown and not-owned IDs
// are one NOT_FOUND. Reads never write: a draft begins only by command.

export type ApplicationQueryResult<V> =
  | Readonly<{ kind: "OK"; view: V }>
  | Readonly<{ kind: "UNAUTHENTICATED" | "NOT_FOUND" }>;

const db = (deps: CandidateDependencies) =>
  deps.db as unknown as CandidateExecutor;

const statusLabels = {
  IN_PROGRESS: "In progress",
  COMPLETE: "Complete",
} as const;

/** One unambiguous format; no per-user timezone setting exists yet. */
export function savedLabel(at: Date): string {
  return `${new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(at)} UTC`;
}

function render<V extends object>(
  contract: ProjectionContract<V, V>,
  view: V,
  allowed: readonly string[],
  deps: CandidateDependencies,
): ApplicationQueryResult<V> {
  const projected = project(contract, view, {
    audience: contract.audience,
    purpose: contract.purpose,
    allowed: new Set(allowed),
  });
  if (projected.kind !== "PROJECTED") {
    deps.logger.error("authz.projection_refused", {
      module: "applications",
      action: contract.name,
      reasonCode: projected.reason,
    });
    return { kind: "NOT_FOUND" };
  }
  return { kind: "OK", view: projected.value };
}

function ownRequest(
  principal: Principal,
  permission: string,
  operation: "READ" | "EDIT" | "CREATE" | "REVIEW",
  id: string,
): AuthorizationRequest {
  return {
    principal: {
      accountId: principal.accountId,
      accountType: principal.accountType,
      sessionId: principal.sessionId,
    },
    permission,
    operation,
    resource: { kind: "RECORD", id, sensitivity: "CONFIDENTIAL_PERSONNEL" },
  };
}

async function candidacyById(deps: CandidateDependencies, publicId: unknown) {
  return isCandidacyPublicId(publicId)
    ? findCandidacyByPublicId(db(deps), publicId, null)
    : null;
}

const isEditable = (row: CandidacyRow) =>
  row.status === "ACTIVE" && row.currentStage === "APPLICATION_INCOMPLETE";

async function templateFor(
  deps: CandidateDependencies,
  templateVersionId: string | null,
): Promise<ApplicationTemplate | null> {
  const version = templateVersionId
    ? await findTemplateVersion(db(deps), templateVersionId)
    : await findEffectiveTemplateVersion(db(deps), deps.clock());
  return version ? parseTemplate(version.schemaJson) : null;
}

/** The return a version answers: its own if returned, else what it corrects. */
async function openReturn(
  deps: CandidateDependencies,
  version: Readonly<{
    id: string;
    status: string;
    supersedesId: string | null;
  }> | null,
) {
  if (!version || version.status === "SUBMITTED") return null;
  if (version.status === "RETURNED") return findReturn(db(deps), version.id);
  return version.supersedesId
    ? findReturn(db(deps), version.supersedesId)
    : null;
}

const correctionOf = (
  returned: Readonly<{ reasonCode: string; instructions: string }> | null,
) =>
  returned
    ? {
        reason: returnReasons[returned.reasonCode as ReturnReason],
        instructions: returned.instructions,
      }
    : null;

const latestSave = (rows: readonly DraftSectionRow[]) =>
  rows.reduce<Date | null>(
    (latest, r) => (!latest || r.savedAt > latest ? r.savedAt : latest),
    null,
  );

/** The application overview: opening, status, and each section's progress. */
export async function queryApplicationOverview(
  headers: Headers,
  candidacyId: unknown,
  deps: CandidateDependencies = candidateDependencies(),
): Promise<ApplicationQueryResult<ApplicationOverviewView>> {
  const principal = await resolveCurrentCandidate(headers);
  if (!principal) return { kind: "UNAUTHENTICATED" };
  const row = await candidacyById(deps, candidacyId);
  if (!row) return { kind: "NOT_FOUND" };
  const decision = await authorize(
    ownRequest(principal, "candidate.candidacy.read_own", "READ", row.id),
    deps,
  );
  if (decision.decision !== "ALLOW") return { kind: "NOT_FOUND" };
  const found = await cycleForCandidacy(
    db(deps),
    { cycleId: row.hiringCycleId },
    deps.clock(),
  );
  const draft = await findLatestVersion(db(deps), row.id);
  const template = await templateFor(deps, draft?.templateVersionId ?? null);
  const saved = draft ? await listDraftSections(db(deps), draft.id) : [];
  const bySection = new Map(saved.map((s) => [s.sectionCode, s]));
  const returned = await openReturn(deps, draft);
  const reopened = (returned?.reopened ?? {}) as Record<string, unknown>;
  const isOpen = (code: string) =>
    returned === null || Object.hasOwn(reopened, code);
  const sections = (template?.sections ?? []).map((s) => {
    const current = bySection.get(s.code);
    return {
      code: s.code,
      title: s.title,
      description: s.description,
      editable: isOpen(s.code),
      status:
        returned && isOpen(s.code) && (current?.version ?? 1) === 1
          ? ("Needs correction" as const)
          : returned && !current
            ? ("Complete" as const)
            : current
              ? statusLabels[
                  current.completionStatus as keyof typeof statusLabels
                ]
              : ("Not started" as const),
    };
  });
  const last = latestSave(saved);
  return render(
    applicationOverviewContract,
    {
      candidacyId: row.publicId,
      reference: row.candidateReference,
      title: found?.cycle.publicTitle ?? "",
      location: found?.cycle.locationLabel ?? "",
      status:
        candidateStatusWording[
          candidateStatusCode(row.currentStage, row.status)
        ].label,
      started: draft?.status === "DRAFT" || draft?.status === "SUBMITTED",
      submitted: draft?.status === "SUBMITTED",
      correction: correctionOf(returned),
      attachmentsEditable: returned === null || returned.attachmentsReopened,
      editable: isEditable(row) && template !== null,
      sections,
      completeCount: sections.filter((s) => s.status === "Complete").length,
      lastSaved: last ? savedLabel(last) : null,
    },
    ["candidate.candidacy.read_own"],
    deps,
  );
}

/** One section's form, pinned to the draft's template version. */
export async function queryApplicationSection(
  headers: Headers,
  candidacyId: unknown,
  sectionCode: unknown,
  deps: CandidateDependencies = candidateDependencies(),
): Promise<ApplicationQueryResult<ApplicationSectionView>> {
  const principal = await resolveCurrentCandidate(headers);
  if (!principal) return { kind: "UNAUTHENTICATED" };
  const row = await candidacyById(deps, candidacyId);
  if (!row) return { kind: "NOT_FOUND" };
  const decision = await authorize(
    {
      ...ownRequest(principal, "application.own.edit", "EDIT", row.id),
      workflow: candidacyWorkflow(row),
    },
    deps,
  );
  if (decision.decision !== "ALLOW" || !isEditable(row)) {
    return { kind: "NOT_FOUND" };
  }
  const draft = await findDraft(db(deps), row.id);
  if (!draft) return { kind: "NOT_FOUND" };
  const template = await templateFor(deps, draft.templateVersionId);
  const index =
    template?.sections.findIndex((s) => s.code === sectionCode) ?? -1;
  if (!template || index < 0) return { kind: "NOT_FOUND" };
  const section = template.sections[index]!;
  const returned = await openReturn(deps, draft);
  const reopened = (returned?.reopened ?? {}) as Record<
    string,
    readonly string[] | undefined
  >;
  if (returned && !Object.hasOwn(reopened, section.code)) {
    return { kind: "NOT_FOUND" };
  }
  const saved = await listDraftSections(db(deps), draft.id);
  const current = saved.find((s) => s.sectionCode === section.code) ?? null;
  const answers = (current?.answers ?? {}) as Record<
    string,
    string | string[] | undefined
  >;
  const neighbor = (s: (typeof template.sections)[number] | undefined) =>
    s ? { code: s.code, title: s.title } : null;
  return render(
    applicationSectionContract,
    {
      candidacyId: row.publicId,
      reference: row.candidateReference,
      code: section.code,
      title: section.title,
      description: section.description,
      status:
        returned && (current?.version ?? 1) === 1
          ? "Needs correction"
          : current
            ? statusLabels[
                current.completionStatus as keyof typeof statusLabels
              ]
            : "Not started",
      version: current?.version ?? 0,
      fields: section.fields.map((f) => ({
        code: f.code,
        label: f.label,
        hint: f.hint ?? null,
        type: f.type,
        required: f.required,
        flagged: reopened[section.code]?.includes(f.code) === true,
        options:
          f.type === "single_choice" || f.type === "multi_choice"
            ? f.options
            : [],
        value: answers[f.code] ?? null,
      })),
      lastSaved: current ? savedLabel(current.savedAt) : null,
      correction: correctionOf(returned),
      previous: neighbor(template.sections[index - 1]),
      next: neighbor(template.sections[index + 1]),
    },
    ["application.own.edit"],
    deps,
  );
}

function displayValue(
  field: TemplateField,
  value: string | readonly string[] | undefined,
): string | null {
  if (value === undefined) return null;
  if (field.type === "single_choice" || field.type === "multi_choice") {
    const chosen = Array.isArray(value) ? value : [value];
    return field.options
      .filter((o) => chosen.includes(o.value))
      .map((o) => o.label)
      .join(", ");
  }
  return String(value);
}

/** Everything the candidate certifies: answers, files, and the statement. */
export async function queryApplicationReview(
  headers: Headers,
  candidacyId: unknown,
  deps: CandidateDependencies = candidateDependencies(),
): Promise<ApplicationQueryResult<ApplicationReviewView>> {
  const principal = await resolveCurrentCandidate(headers);
  if (!principal) return { kind: "UNAUTHENTICATED" };
  const row = await candidacyById(deps, candidacyId);
  if (!row) return { kind: "NOT_FOUND" };
  const decision = await authorize(
    {
      ...ownRequest(principal, "application.own.submit", "CREATE", row.id),
      workflow: candidacyWorkflow(row),
    },
    deps,
  );
  if (decision.decision !== "ALLOW" || !isEditable(row)) {
    return { kind: "NOT_FOUND" };
  }
  const draft = await findDraft(db(deps), row.id);
  const template = draft
    ? await templateFor(deps, draft.templateVersionId)
    : null;
  const certification = await findEffectiveCertification(
    db(deps),
    deps.clock(),
  );
  if (!draft || !template || !certification) return { kind: "NOT_FOUND" };
  const answers = Object.fromEntries(
    (await listDraftSections(db(deps), draft.id)).map((s) => [
      s.sectionCode,
      s.answers,
    ]),
  ) as Record<string, Record<string, string | string[] | undefined>>;
  const check = checkApplication(template, answers);
  const returned = await openReturn(deps, draft);
  const reopened = (returned?.reopened ?? {}) as Record<string, unknown>;
  const files = await listSubmittableAttachments(db(deps), row.id);
  const found = await cycleForCandidacy(
    db(deps),
    { cycleId: row.hiringCycleId },
    deps.clock(),
  );
  return render(
    applicationReviewContract,
    {
      candidacyId: row.publicId,
      reference: row.candidateReference,
      title: found?.cycle.publicTitle ?? "",
      complete: check.complete,
      // A correction staff asked for isn't held to the cycle's closing.
      accepting: found?.accepting === true || draft.supersedesId !== null,
      attachmentsEditable: returned === null || returned.attachmentsReopened,
      correction: correctionOf(returned),
      sections: template.sections.map((section, index) => ({
        code: section.code,
        title: section.title,
        complete: check.sections[index]!.complete,
        editable: returned === null || Object.hasOwn(reopened, section.code),
        missing: [...check.sections[index]!.missing],
        answers: section.fields.flatMap((field) => {
          const value = displayValue(
            field,
            answers[section.code]?.[field.code],
          );
          return value === null ? [] : [{ label: field.label, value }];
        }),
      })),
      attachments: files.included.map(({ category, name, size }) => ({
        category,
        name,
        size,
      })),
      excludedAttachments: [...files.excluded],
      certification: {
        version: certification.versionNumber,
        statement: certification.statement,
      },
      reviewToken: reviewTokenFor(
        answers,
        files.included.map((f) => f.versionId),
        certification.versionNumber,
      ),
    },
    ["application.own.submit"],
    deps,
  );
}

/** The candidate's receipt, read from the frozen submission. */
export async function queryApplicationReceipt(
  headers: Headers,
  candidacyId: unknown,
  deps: CandidateDependencies = candidateDependencies(),
): Promise<ApplicationQueryResult<ApplicationReceiptView>> {
  const principal = await resolveCurrentCandidate(headers);
  if (!principal) return { kind: "UNAUTHENTICATED" };
  const row = await candidacyById(deps, candidacyId);
  if (!row) return { kind: "NOT_FOUND" };
  const decision = await authorize(
    ownRequest(principal, "candidate.candidacy.read_own", "READ", row.id),
    deps,
  );
  if (decision.decision !== "ALLOW") return { kind: "NOT_FOUND" };
  const frozen = await findLatestSubmission(db(deps), row.id);
  if (!frozen) return { kind: "NOT_FOUND" };
  const found = await cycleForCandidacy(
    db(deps),
    { cycleId: row.hiringCycleId },
    deps.clock(),
  );
  return render(
    applicationReceiptContract,
    {
      candidacyId: row.publicId,
      reference: row.candidateReference,
      receiptNumber: frozen.submission.receiptNumber,
      title: found?.cycle.publicTitle ?? "",
      submitted: savedLabel(frozen.submission.submittedAt),
      certifiedName: frozen.submission.certifiedName,
      certificationVersion: frozen.certificationVersion,
      sectionCount: Object.keys(
        frozen.submission.answers as Record<string, unknown>,
      ).length,
      attachmentCount: frozen.attachmentCount,
    },
    ["candidate.candidacy.read_own"],
    deps,
  );
}

const silent: CandidateDependencies["events"] = {
  record: async () => true,
  recordInTransaction: async () => {},
};

/**
 * What a staff member reviews (M2.7): the frozen submission, exactly as
 * certified, for a candidacy in their scope. Anything else is one NOT_FOUND.
 * Reading it writes nothing, and files have no download here yet.
 */
export async function queryStaffApplicationReview(
  headers: Headers,
  candidacyId: unknown,
  deps: CandidateDependencies = candidateDependencies(),
): Promise<ApplicationQueryResult<StaffApplicationReviewView>> {
  const principal = await resolveCurrentStaff(headers);
  if (!principal) return { kind: "UNAUTHENTICATED" };
  const row = await candidacyById(deps, candidacyId);
  if (!row) return { kind: "NOT_FOUND" };
  const decision = await authorize(
    ownRequest(principal, "application.read", "READ", row.id),
    deps,
  );
  if (decision.decision !== "ALLOW") return { kind: "NOT_FOUND" };
  // The newest frozen submission, even while a correction is being drafted.
  const latest = await findLatestVersion(db(deps), row.id);
  const record = await findLatestSubmission(db(deps), row.id);
  if (!latest || !record) return { kind: "NOT_FOUND" };
  const frozen = record.submission;
  const template = await templateFor(deps, frozen.templateVersionId);
  if (!template) return { kind: "NOT_FOUND" };
  const review = await authorize(
    {
      ...ownRequest(principal, "application.review", "REVIEW", row.id),
      workflow: candidacyWorkflow(row),
    },
    { ...deps, events: silent },
  );
  const answers = frozen.answers as Record<
    string,
    Record<string, string | string[] | undefined>
  >;
  const found = await cycleForCandidacy(
    db(deps),
    { cycleId: row.hiringCycleId },
    deps.clock(),
  );
  const files = await listSubmittedAttachments(db(deps), frozen.id);
  const returns = await listReturns(db(deps), row.id);
  return render(
    staffApplicationReviewContract,
    {
      candidacyId: row.publicId,
      reference: row.candidateReference,
      title: found?.cycle.publicTitle ?? "",
      submitted: savedLabel(frozen.submittedAt),
      receiptNumber: frozen.receiptNumber,
      certifiedName: frozen.certifiedName,
      certificationVersion: record.certificationVersion,
      version: row.version,
      awaitingCorrection: latest.status !== "SUBMITTED",
      canReturn:
        review.decision === "ALLOW" &&
        latest.status === "SUBMITTED" &&
        row.status === "ACTIVE" &&
        row.currentStage === "APPLICATION_SUBMITTED",
      sections: template.sections.map((section) => ({
        code: section.code,
        title: section.title,
        fields: section.fields.map((field) => ({
          code: field.code,
          label: field.label,
          value: displayValue(field, answers[section.code]?.[field.code]),
        })),
      })),
      attachments: [...files],
      earlierReturns: returns.map((r) => ({
        when: savedLabel(r.returnedAt),
        reason: returnReasons[r.reasonCode as ReturnReason],
        instructions: r.instructions,
      })),
    },
    ["application.read"],
    deps,
  );
}

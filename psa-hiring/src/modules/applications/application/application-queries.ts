import "server-only";
import {
  authorize,
  project,
  resolveCurrentCandidate,
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
import { listSubmittableAttachments } from "@/modules/documents";
import {
  checkApplication,
  parseTemplate,
  type ApplicationTemplate,
  type TemplateField,
} from "../domain/application-template";
import { reviewTokenFor } from "./application-submission";
import {
  findDraft,
  findEffectiveCertification,
  findEffectiveTemplateVersion,
  findLatestSubmission,
  findLatestVersion,
  findTemplateVersion,
  listDraftSections,
  type DraftSectionRow,
} from "../infrastructure/applications-repository";
import {
  applicationOverviewContract,
  applicationReceiptContract,
  applicationReviewContract,
  applicationSectionContract,
  type ApplicationOverviewView,
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
  operation: "READ" | "EDIT" | "CREATE",
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
  const sections = (template?.sections ?? []).map((s) => {
    const current = bySection.get(s.code);
    return {
      code: s.code,
      title: s.title,
      description: s.description,
      status: current
        ? statusLabels[current.completionStatus as keyof typeof statusLabels]
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
      started: draft !== null,
      submitted: draft?.status === "SUBMITTED",
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
      status: current
        ? statusLabels[current.completionStatus as keyof typeof statusLabels]
        : "Not started",
      version: current?.version ?? 0,
      fields: section.fields.map((f) => ({
        code: f.code,
        label: f.label,
        hint: f.hint ?? null,
        type: f.type,
        required: f.required,
        options:
          f.type === "single_choice" || f.type === "multi_choice"
            ? f.options
            : [],
        value: answers[f.code] ?? null,
      })),
      lastSaved: current ? savedLabel(current.savedAt) : null,
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
      accepting: found?.accepting === true,
      sections: template.sections.map((section, index) => ({
        code: section.code,
        title: section.title,
        complete: check.sections[index]!.complete,
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

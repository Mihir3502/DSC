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
import { candidacyWorkflow } from "./application-commands";
import {
  parseTemplate,
  type ApplicationTemplate,
} from "../domain/application-template";
import {
  findDraft,
  findEffectiveTemplateVersion,
  findTemplateVersion,
  listDraftSections,
  type DraftSectionRow,
} from "../infrastructure/applications-repository";
import {
  applicationOverviewContract,
  applicationSectionContract,
  type ApplicationOverviewView,
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
  operation: "READ" | "EDIT",
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
  const draft = await findDraft(db(deps), row.id);
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

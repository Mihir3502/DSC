import "server-only";
import {
  authorizeCandidateCommand,
  candidateDependencies,
  findCandidacyByPublicId,
  fingerprint,
  isCandidacyPublicId,
  refuse,
  runCandidateCommand,
  type CandidacyRow,
  type CandidateActor,
  type CandidateDependencies,
  type CandidateOutcome,
  type CommandContext,
} from "@/modules/candidates";
import {
  assistReasons,
  MAX_ANSWERS_JSON_LENGTH,
  parseTemplate,
  validateSection,
  type AnswerProblem,
  type TemplateSection,
} from "../domain/application-template";
import {
  findDraft,
  findDraftSection,
  findEffectiveTemplateVersion,
  findTemplateVersion,
  insertDraft,
  insertDraftSection,
  updateDraftSection,
} from "../infrastructure/applications-repository";

// Named application-draft commands (packet M2.4 §8–§10). Each one locks
// the candidacy, authorizes against it, re-checks its state, and commits
// the draft, its audit event, and its idempotency receipt together. The
// client supplies only a key, references, an expected version, and answers;
// ownership, state, actor, and time are all derived on the server. Audit
// metadata names the section and its status, never an answer.

export type ApplicationCommandResult =
  | CandidateOutcome
  | Readonly<{
      kind: "INVALID_INPUT";
      fields: Readonly<Record<string, AnswerProblem>>;
    }>;

const recordOf = (row: CandidacyRow) =>
  ({
    kind: "RECORD",
    id: row.id,
    sensitivity: "CONFIDENTIAL_PERSONNEL",
  }) as const;

async function lockCandidacy(ctx: CommandContext, publicId: string) {
  const row = await findCandidacyByPublicId(ctx.tx, publicId, "update");
  return row ?? refuse("NOT_FOUND");
}

/** Only an active application in progress has an editable draft. */
function requireEditable(row: CandidacyRow) {
  if (
    row.status !== "ACTIVE" ||
    row.currentStage !== "APPLICATION_INCOMPLETE"
  ) {
    refuse("INVALID_TRANSITION");
  }
}

/** The server-read state the workflow policy decides on. */
export const candidacyWorkflow = (row: CandidacyRow) =>
  ({
    policy: "CANDIDACY_WORKFLOW",
    state: row.status === "ACTIVE" ? row.currentStage : "CLOSED",
  }) as const;

const accountOf = (actor: CandidateActor) =>
  actor.kind === "BOOTSTRAP" ? actor.accountId : actor.principal.accountId;

export type BeginDraftInput = Readonly<{
  commandKey?: string;
  candidacyId?: string;
}>;

/** begin_application_draft: pins the current template; safe to repeat. */
export async function beginApplicationDraft(
  input: BeginDraftInput,
  actor: CandidateActor,
  deps: CandidateDependencies = candidateDependencies(),
): Promise<ApplicationCommandResult> {
  if (actor.kind === "STAFF")
    return { kind: "REFUSED", reason: "NOT_AUTHORIZED" };
  if (!isCandidacyPublicId(input.candidacyId))
    return { kind: "REFUSED", reason: "NOT_FOUND" };
  return runCandidateCommand(
    deps,
    actor,
    {
      name: "begin_application_draft",
      commandKey: input.commandKey,
      fingerprint: fingerprint({ candidacy: input.candidacyId }),
    },
    async (ctx) => {
      const row = await lockCandidacy(ctx, input.candidacyId!);
      await authorizeCandidateCommand(
        ctx,
        deps,
        "application.own.edit",
        "EDIT",
        recordOf(row),
        undefined,
        candidacyWorkflow(row),
      );
      requireEditable(row);
      const existing = await findDraft(ctx.tx, row.id);
      if (existing) {
        return { outcome: "EXISTING", targetId: row.id, version: 1 };
      }
      const template = await findEffectiveTemplateVersion(ctx.tx, ctx.now);
      if (!template || !parseTemplate(template.schemaJson)) {
        return refuse("TEMPLATE_UNAVAILABLE");
      }
      await insertDraft(ctx.tx, {
        candidacyId: row.id,
        templateVersionId: template.id,
        createdByAccountId: ctx.actorId,
        createdAt: ctx.now,
      });
      ctx.events.push({
        code: "application.started",
        recordRef: row.id,
        candidacyRef: row.id,
        organizationRef: row.organizationId,
        newVersion: 1,
        changeCodes: [`TEMPLATE_V${template.versionNumber}`],
      });
      return { outcome: "CREATED", targetId: row.id, version: 1 };
    },
  );
}

export type SaveSectionInput = Readonly<{
  commandKey?: string;
  candidacyId?: string;
  sectionCode?: string;
  /** "0" when the section has never been saved. */
  expectedVersion?: string;
  /** The section's answers as one JSON object. */
  answers?: string;
}>;

function parseExpected(value: unknown): number | null {
  return typeof value === "string" && /^(0|[1-9][0-9]{0,8})$/.test(value)
    ? Number(value)
    : null;
}

function parseAnswers(value: unknown): unknown {
  if (typeof value !== "string" || value.length > MAX_ANSWERS_JSON_LENGTH) {
    return undefined;
  }
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

class SectionProblems extends Error {
  constructor(readonly fields: Readonly<Record<string, AnswerProblem>>) {
    super("invalid answers");
  }
}

async function runSave(
  input: SaveSectionInput,
  actor: CandidateActor,
  deps: CandidateDependencies,
  options: Readonly<{
    name: string;
    authorizeSave: (ctx: CommandContext, row: CandidacyRow) => Promise<void>;
    event: "application.section_saved" | "application.section_assisted";
    kind: "CANDIDATE" | "STAFF_ASSIST";
    reasonCode: string | null;
  }>,
): Promise<ApplicationCommandResult> {
  const expected = parseExpected(input.expectedVersion);
  const raw = parseAnswers(input.answers);
  if (expected === null || raw === undefined) {
    return { kind: "REFUSED", reason: "INVALID_INPUT" };
  }
  if (!isCandidacyPublicId(input.candidacyId))
    return { kind: "REFUSED", reason: "NOT_FOUND" };
  if (!deps.limiter.consume("applicationSavePerAccount", accountOf(actor))) {
    return { kind: "REFUSED", reason: "RATE_LIMITED" };
  }
  try {
    return await runCandidateCommand(
      deps,
      actor,
      {
        name: options.name,
        commandKey: input.commandKey,
        fingerprint: fingerprint({
          candidacy: input.candidacyId,
          section: input.sectionCode,
          expected,
          answers: input.answers,
          reason: options.reasonCode,
        }),
      },
      async (ctx) => {
        const row = await lockCandidacy(ctx, input.candidacyId!);
        await options.authorizeSave(ctx, row);
        requireEditable(row);
        const draft =
          (await findDraft(ctx.tx, row.id)) ?? refuse("INVALID_TRANSITION");
        const version = await findTemplateVersion(
          ctx.tx,
          draft.templateVersionId,
        );
        const template = version && parseTemplate(version.schemaJson);
        if (!template) return refuse("TEMPLATE_UNAVAILABLE");
        const section: TemplateSection =
          template.sections.find((s) => s.code === input.sectionCode) ??
          refuse("NOT_FOUND");
        const checked = validateSection(section, raw);
        if (!checked.ok) {
          if ("rejected" in checked) return refuse("INVALID_INPUT");
          throw new SectionProblems(checked.problems);
        }
        const current = await findDraftSection(ctx.tx, draft.id, section.code);
        if ((current?.version ?? 0) !== expected) refuse("STALE_VERSION");
        const write = {
          answers: checked.answers,
          completionStatus: checked.completion,
          savedByAccountId: ctx.actorId,
          savedByKind: options.kind,
          assistReasonCode: options.reasonCode,
          savedAt: ctx.now,
        };
        const saved = current
          ? await updateDraftSection(ctx.tx, current.id, expected, write)
          : await insertDraftSection(ctx.tx, draft.id, section.code, write);
        if (!saved) return refuse("STALE_VERSION");
        ctx.events.push({
          code: options.event,
          recordRef: row.id,
          candidacyRef: row.id,
          organizationRef: row.organizationId,
          ...(current ? { previousVersion: current.version } : {}),
          newVersion: saved.version,
          changeCodes: [section.code.toUpperCase(), checked.completion],
          ...(options.reasonCode ? { reasonCode: options.reasonCode } : {}),
        });
        return { outcome: "SAVED", targetId: row.id, version: saved.version };
      },
    );
  } catch (error) {
    if (error instanceof SectionProblems) {
      return { kind: "INVALID_INPUT", fields: error.fields };
    }
    throw error;
  }
}

/** save_application_section: the candidate's own autosave or manual save. */
export async function saveApplicationSection(
  input: SaveSectionInput,
  actor: CandidateActor,
  deps: CandidateDependencies = candidateDependencies(),
): Promise<ApplicationCommandResult> {
  if (actor.kind === "STAFF")
    return { kind: "REFUSED", reason: "NOT_AUTHORIZED" };
  return runSave(input, actor, deps, {
    name: "save_application_section",
    authorizeSave: (ctx, row) =>
      authorizeCandidateCommand(
        ctx,
        deps,
        "application.own.edit",
        "EDIT",
        recordOf(row),
        undefined,
        candidacyWorkflow(row),
      ),
    event: "application.section_saved",
    kind: "CANDIDATE",
    reasonCode: null,
  });
}

/**
 * assist_save_application_section: a documented staff save on a candidate's
 * behalf. `application.assist` has no role grant until the business approves
 * one (M2.4 decision), so every real staff request is denied today.
 */
export async function assistSaveApplicationSection(
  input: SaveSectionInput & Readonly<{ reasonCode?: string }>,
  actor: CandidateActor,
  deps: CandidateDependencies = candidateDependencies(),
): Promise<ApplicationCommandResult> {
  if (actor.kind === "CANDIDATE")
    return { kind: "REFUSED", reason: "NOT_AUTHORIZED" };
  const reason = input.reasonCode;
  if (!assistReasons.some((r) => r === reason)) {
    return { kind: "REFUSED", reason: "INVALID_INPUT" };
  }
  return runSave(input, actor, deps, {
    name: "assist_save_application_section",
    authorizeSave: (ctx, row) =>
      authorizeCandidateCommand(
        ctx,
        deps,
        "application.assist",
        "EDIT",
        recordOf(row),
        reason,
        candidacyWorkflow(row),
      ),
    event: "application.section_assisted",
    kind: "STAFF_ASSIST",
    reasonCode: reason!,
  });
}

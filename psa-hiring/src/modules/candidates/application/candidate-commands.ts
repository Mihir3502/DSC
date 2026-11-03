import "server-only";
import {
  readVerifiedCandidateEmail,
  verifyApplicationHandoff,
} from "@/modules/identity-access";
import { cycleForCandidacy, type CandidacyCycle } from "@/modules/organization";
import {
  canonicalPair,
  candidateVisibleStatus,
  decideMerge,
  DUPLICATE_RULESET,
  evaluateDuplicateSignals,
  isCandidacyPublicId,
  isMember,
  mergeReasons,
  prospectCloseReasons,
  reviewReasons,
  stageTransition,
  type CandidacyStage,
  type CandidacyStatus,
  type MergeSide,
} from "../domain/candidacy-policy";
import {
  NORMALIZATION_VERSION,
  normalizeContactEmail,
  normalizeName,
  normalizePhone,
  type FieldProblem,
} from "../domain/normalization";
import {
  findActiveCandidacy,
  findCandidacyByPublicId,
  findMatchByPublicId,
  findPerson,
  findPersonByAccount,
  findSignalPeople,
  insertCandidacy,
  insertMatchIfAbsent,
  insertMergeRecord,
  insertPerson,
  insertStageHistory,
  lockActiveCandidaciesOf,
  reparentCandidacies,
  updateCandidacy,
  updateMatch,
  updatePersonForMerge,
  type CandidacyRow,
  type Executor,
  type PersonRow,
} from "../infrastructure/candidates-repository";
import {
  authorizeCandidateCommand,
  candidateDependencies,
  fingerprint,
  refuse,
  runCandidateCommand,
  Unchanged,
  type CandidateActor,
  type CandidateDependencies,
  type CandidateOutcome,
  type CommandContext,
} from "./candidate-runtime";

// Named person/candidacy commands (packet M2.2 §10–§17, §21). Every fact
// that matters — ownership, hierarchy, cycle availability, source, stage,
// owner, worker path, survivor — is derived on the server inside the
// command's transaction. Inputs carry only bounded, normalized values the
// person typed, a command key, expected versions, and closed reason codes.

export type CandidateResult =
  | CandidateOutcome
  | Readonly<{
      kind: "INVALID_INPUT";
      fields: Readonly<Record<string, FieldProblem>>;
    }>;

class InputProblems extends Error {
  constructor(readonly fields: Record<string, FieldProblem>) {
    super("invalid input");
  }
}

async function validated(
  run: () => Promise<CandidateOutcome>,
): Promise<CandidateResult> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof InputProblems)
      return { kind: "INVALID_INPUT", fields: error.fields };
    throw error;
  }
}

type NameInput = Readonly<{
  legalFirstName?: string;
  legalMiddleName?: string;
  legalLastName?: string;
  preferredName?: string;
  phone?: string;
}>;

function personFields(input: NameInput) {
  const problems: Record<string, FieldProblem> = {};
  const name = (field: keyof NameInput, optional: boolean) => {
    const result = normalizeName(input[field], { max: 100, optional });
    if (!result.ok) problems[field] = result.problem;
    return result.ok ? result.value : null;
  };
  const values = {
    legalFirstName: name("legalFirstName", false) ?? "",
    legalMiddleName: name("legalMiddleName", true),
    legalLastName: name("legalLastName", false) ?? "",
    preferredName: name("preferredName", true),
  };
  const phone = normalizePhone(input.phone);
  if (!phone.ok) problems.phone = phone.problem;
  return {
    problems,
    values,
    phone: phone.ok ? phone.value : null,
  };
}

function version(value: unknown): number {
  if (typeof value !== "string" || !/^[1-9][0-9]{0,8}$/.test(value)) {
    return refuse("INVALID_INPUT");
  }
  return Number(value);
}

function placementResource(cycle: CandidacyCycle) {
  return cycle.teamId
    ? ({
        kind: "SCOPE",
        scopeType: "TEAM",
        id: cycle.teamId,
        sensitivity: "CONFIDENTIAL_PERSONNEL",
      } as const)
    : ({
        kind: "SCOPE",
        scopeType: "BRANCH",
        id: cycle.branchId,
        sensitivity: "CONFIDENTIAL_PERSONNEL",
      } as const);
}

async function acceptingCycle(
  ctx: CommandContext,
  key: Readonly<{ publicReference: string }> | Readonly<{ cycleId: string }>,
): Promise<CandidacyCycle> {
  const found = await cycleForCandidacy(ctx.tx, key, ctx.now);
  if (!found || !found.accepting) return refuse("OPENING_UNAVAILABLE");
  return found.cycle;
}

function historyActor(actor: CandidateActor) {
  return actor.kind === "BOOTSTRAP"
    ? { actorAccountId: null, systemActor: "TEST_HARNESS" }
    : { actorAccountId: actor.principal.accountId, systemActor: null };
}

async function recordStage(
  ctx: CommandContext,
  row: CandidacyRow,
  command: string,
  from: Readonly<{ stage: string; status: string; version: number }> | null,
  reasonCode: string | null,
) {
  await insertStageHistory(ctx.tx, {
    candidacyId: row.id,
    fromStage: from?.stage ?? null,
    toStage: row.currentStage,
    fromStatus: from?.status ?? null,
    toStatus: row.status,
    commandCode: command,
    ...historyActor(ctx.actor),
    reasonCode,
    versionBefore: from?.version ?? null,
    versionAfter: row.version,
    correlationId: null,
    occurredAt: ctx.now,
  });
  ctx.events.push({
    code: "candidacy.stage_changed",
    recordRef: row.id,
    candidacyRef: row.id,
    organizationRef: row.organizationId,
    ...(from ? { previousVersion: from.version } : {}),
    newVersion: row.version,
    changeCodes: [command.toUpperCase(), row.currentStage, row.status],
    ...(reasonCode ? { reasonCode } : {}),
  });
}

/**
 * evaluate_duplicate_suspicion: DUP-1 against ACTIVE people with a
 * candidacy in the same organization. Records one PENDING case per
 * canonical pair and ruleset; never blocks, links, or merges.
 */
async function evaluateDuplicates(
  ctx: CommandContext,
  subject: PersonRow,
  organizationId: string,
): Promise<number> {
  const others = await findSignalPeople(
    ctx.tx,
    organizationId,
    subject.emailNormalized,
    subject.phoneE164,
    subject.id,
  );
  let created = 0;
  for (const other of others) {
    const result = evaluateDuplicateSignals(
      {
        emailNormalized: subject.emailNormalized,
        phoneE164: subject.phoneE164,
      },
      other,
    );
    if (!result) continue;
    const [a, b] = canonicalPair(subject.id, other.id);
    const match = await insertMatchIfAbsent(
      ctx.tx,
      {
        organizationId,
        personAId: a,
        personBId: b,
        rulesetVersion: DUPLICATE_RULESET,
        signalCodes: [...result.signals],
        confidenceTier: result.tier,
      },
      ctx.now,
    );
    if (match) {
      created += 1;
      ctx.events.push({
        code: "duplicate_match.created",
        recordRef: match.id,
        organizationRef: organizationId,
        newVersion: match.version,
        changeCodes: [
          DUPLICATE_RULESET.replace("-", "_"),
          result.tier,
          ...result.signals,
        ],
      });
    }
  }
  return created;
}

function newCandidacyEvents(ctx: CommandContext, row: CandidacyRow) {
  ctx.events.push({
    code: "candidacy.created",
    recordRef: row.id,
    candidacyRef: row.id,
    organizationRef: row.organizationId,
    newVersion: row.version,
    changeCodes: [row.sourceCode, row.currentStage],
  });
}

// ---------------------------------------------------- candidate self-start

export type StartOwnInput = NameInput &
  Readonly<{ commandKey?: string; handoffToken?: string }>;

/**
 * start_own_candidacy (create_own_person_and_candidacy when no person is
 * linked yet): a verified candidate starts an application for the opening
 * named by their signed handoff. Returns CREATED or EXISTING with the
 * candidate's own candidacy; never reveals any other person or record.
 */
export async function startOwnCandidacy(
  input: StartOwnInput,
  actor: CandidateActor,
  deps: CandidateDependencies = candidateDependencies(),
): Promise<CandidateResult> {
  return validated(async () => {
    if (actor.kind === "STAFF")
      return { kind: "REFUSED", reason: "NOT_AUTHORIZED" };
    const reference = verifyApplicationHandoff(input.handoffToken);
    if (!reference) return { kind: "REFUSED", reason: "OPENING_UNAVAILABLE" };
    const fields = personFields(input);
    const accountId =
      actor.kind === "CANDIDATE" ? actor.principal.accountId : actor.accountId;
    const spec = {
      name: "start_own_candidacy",
      commandKey: input.commandKey,
      fingerprint: fingerprint({
        reference,
        first: fields.values.legalFirstName,
        middle: fields.values.legalMiddleName,
        last: fields.values.legalLastName,
        preferred: fields.values.preferredName,
        phone: fields.phone?.display ?? null,
      }),
    };
    if (Object.keys(fields.problems).length === 0) {
      if (!deps.limiter.consume("candidateStartPerAccount", accountId)) {
        return { kind: "REFUSED", reason: "RATE_LIMITED" };
      }
    }
    const attempt = () =>
      runCandidateCommand(
        deps,
        actor,
        {
          ...spec,
          onConflict: {
            constraint: "candidacy_current_unique",
            resolve: async () =>
              existingOwnCandidacy(deps, accountId, reference),
          },
        },
        async (ctx) => {
          // Own-account resource: the M1 ownership adapter answers OWNER
          // only for the principal's own account and records.
          await authorizeCandidateCommand(
            ctx,
            deps,
            "candidate.candidacy.create_own",
            "CREATE",
            {
              kind: "RECORD",
              id: accountId,
              sensitivity: "CONFIDENTIAL_PERSONNEL",
            },
          );
          const cycle = await acceptingCycle(ctx, {
            publicReference: reference,
          });
          let owner = await findPersonByAccount(ctx.tx, accountId, "update");
          if (!owner) {
            if (Object.keys(fields.problems).length > 0)
              throw new InputProblems(fields.problems);
            await authorizeCandidateCommand(
              ctx,
              deps,
              "candidate.person.create_own",
              "CREATE",
              {
                kind: "RECORD",
                id: accountId,
                sensitivity: "CONFIDENTIAL_PERSONNEL",
              },
            );
            // The contact email is the account's verified login email,
            // read on the server; it is never typed or claimed.
            const email = await readVerifiedCandidateEmail(ctx.tx, accountId);
            if (!email) return refuse("NOT_AUTHORIZED");
            owner = await insertPerson(
              ctx.tx,
              {
                ...fields.values,
                emailDisplay: email,
                emailNormalized: email,
                phoneDisplay: fields.phone?.display ?? null,
                phoneE164: fields.phone?.e164 ?? null,
                normalizationVersion: NORMALIZATION_VERSION,
                candidateAccountId: accountId,
              },
              ctx.actorId,
              ctx.now,
            );
            ctx.events.push(
              {
                code: "person.created",
                recordRef: owner.id,
                organizationRef: cycle.organizationId,
                newVersion: owner.version,
                changeCodes: [
                  "CANDIDATE_SELF_SERVICE",
                  NORMALIZATION_VERSION.replace("-", "_"),
                ],
              },
              {
                code: "person.account_linked",
                recordRef: owner.id,
                accountRef: accountId,
                organizationRef: cycle.organizationId,
                newVersion: owner.version,
                changeCodes: ["VERIFIED_SELF_SERVICE"],
              },
            );
          }
          const existing = await findActiveCandidacy(
            ctx.tx,
            owner.id,
            cycle.id,
          );
          if (existing) {
            return {
              outcome: "EXISTING",
              targetId: existing.id,
              version: existing.version,
            };
          }
          const to = stageTransition("start_application", null)!;
          const row = await insertCandidacy(
            ctx.tx,
            {
              personId: owner.id,
              hiringCycleId: cycle.id,
              organizationId: cycle.organizationId,
              positionId: cycle.positionId,
              branchId: cycle.branchId,
              teamId: cycle.teamId,
              sourceCode: "CANDIDATE_SELF_SERVICE",
              currentStage: to.stage,
              candidateVisibleStatus: candidateVisibleStatus(
                to.stage,
                to.status,
              ),
              ownerAccountId: null,
              startedAt: ctx.now,
            },
            ctx.actorId,
            ctx.now,
          );
          newCandidacyEvents(ctx, row);
          await recordStage(ctx, row, "start_application", null, null);
          await evaluateDuplicates(ctx, owner, cycle.organizationId);
          return { outcome: "CREATED", targetId: row.id, version: row.version };
        },
      );
    const first = await attempt();
    // A concurrent first start may have created the person: retry once.
    if (first.kind === "REFUSED" && first.reason === "INVALID_TRANSITION")
      return attempt();
    return first;
  });
}

async function existingOwnCandidacy(
  deps: CandidateDependencies,
  accountId: string,
  reference: string,
): Promise<CandidateOutcome> {
  const db = deps.db as unknown as Executor;
  const owner = await findPersonByAccount(db, accountId, null);
  const found = await cycleForCandidacy(
    db,
    { publicReference: reference },
    deps.clock(),
  );
  if (!owner || !found)
    return { kind: "REFUSED", reason: "OPENING_UNAVAILABLE" };
  const existing = await findActiveCandidacy(db, owner.id, found.cycle.id);
  return existing
    ? {
        kind: "DONE",
        outcome: "EXISTING",
        targetId: existing.id,
        version: existing.version,
        replayed: false,
      }
    : { kind: "REFUSED", reason: "STALE_VERSION" };
}

// ---------------------------------------------------------- staff prospect

export type ProspectInput = NameInput &
  Readonly<{
    commandKey?: string;
    cycleReference?: string;
    email?: string;
    acknowledgeDuplicate?: string;
    assignToMe?: string;
  }>;

/**
 * create_staff_prospect: a scoped staff member records a minimal unowned
 * prospect for an accepting opening. Possible duplicates are reported as
 * a single boolean first; creating anyway needs an explicit
 * acknowledgement. The creator never becomes the candidate owner.
 */
export async function createStaffProspect(
  input: ProspectInput,
  actor: CandidateActor,
  deps: CandidateDependencies = candidateDependencies(),
): Promise<CandidateResult> {
  return validated(async () => {
    if (actor.kind === "CANDIDATE")
      return { kind: "REFUSED", reason: "NOT_AUTHORIZED" };
    const fields = personFields(input);
    const email = normalizeContactEmail(input.email);
    if (!email) fields.problems.email = "INVALID_EMAIL";
    if (
      typeof input.cycleReference !== "string" ||
      !/^[0-9a-hjkmnp-tv-z]{12}$/.test(input.cycleReference)
    ) {
      fields.problems.cycleReference = "REQUIRED";
    }
    if (
      input.acknowledgeDuplicate !== undefined &&
      input.acknowledgeDuplicate !== "yes"
    ) {
      return { kind: "REFUSED", reason: "INVALID_INPUT" };
    }
    if (input.assignToMe !== undefined && input.assignToMe !== "yes") {
      return { kind: "REFUSED", reason: "INVALID_INPUT" };
    }
    if (Object.keys(fields.problems).length > 0)
      throw new InputProblems(fields.problems);
    if (
      !deps.limiter.consume(
        "staffProspectCreatePerAccount",
        actor.kind === "STAFF" ? actor.principal.accountId : actor.accountId,
      )
    ) {
      return { kind: "REFUSED", reason: "RATE_LIMITED" };
    }
    const reference = input.cycleReference!;
    return runCandidateCommand(
      deps,
      actor,
      {
        name: "create_staff_prospect",
        commandKey: input.commandKey,
        fingerprint: fingerprint({
          reference,
          ...fields.values,
          email: email!.normalized,
          phone: fields.phone?.display ?? null,
          acknowledge: input.acknowledgeDuplicate ?? null,
          assignToMe: input.assignToMe ?? null,
        }),
      },
      async (ctx) => {
        const cycle = await acceptingCycle(ctx, { publicReference: reference });
        await authorizeCandidateCommand(
          ctx,
          deps,
          "candidate.prospect.create",
          "CREATE",
          placementResource(cycle),
        );
        if (input.assignToMe === "yes") {
          await authorizeCandidateCommand(
            ctx,
            deps,
            "candidate.owner.assign",
            "EDIT",
            placementResource(cycle),
            "INITIAL_ASSIGNMENT",
          );
        }
        const signals = await findSignalPeople(
          ctx.tx,
          cycle.organizationId,
          email!.normalized,
          fields.phone?.e164 ?? null,
          null,
        );
        if (signals.length > 0 && input.acknowledgeDuplicate !== "yes") {
          throw new Unchanged("POSSIBLE_DUPLICATE", null);
        }
        const created = await insertPerson(
          ctx.tx,
          {
            ...fields.values,
            emailDisplay: email!.display,
            emailNormalized: email!.normalized,
            phoneDisplay: fields.phone?.display ?? null,
            phoneE164: fields.phone?.e164 ?? null,
            normalizationVersion: NORMALIZATION_VERSION,
            candidateAccountId: null,
          },
          ctx.actorId,
          ctx.now,
        );
        ctx.events.push({
          code: "person.created",
          recordRef: created.id,
          organizationRef: cycle.organizationId,
          newVersion: created.version,
          changeCodes: [
            "STAFF_ENTERED",
            NORMALIZATION_VERSION.replace("-", "_"),
          ],
        });
        const to = stageTransition("create_prospect", null)!;
        const ownerAccountId = input.assignToMe === "yes" ? ctx.actorId : null;
        const row = await insertCandidacy(
          ctx.tx,
          {
            personId: created.id,
            hiringCycleId: cycle.id,
            organizationId: cycle.organizationId,
            positionId: cycle.positionId,
            branchId: cycle.branchId,
            teamId: cycle.teamId,
            sourceCode: "STAFF_ENTERED",
            currentStage: to.stage,
            candidateVisibleStatus: candidateVisibleStatus(to.stage, to.status),
            ownerAccountId,
            startedAt: null,
          },
          ctx.actorId,
          ctx.now,
        );
        newCandidacyEvents(ctx, row);
        await recordStage(ctx, row, "create_prospect", null, null);
        if (ownerAccountId) {
          ctx.events.push({
            code: "candidacy.owner_assigned",
            recordRef: row.id,
            candidacyRef: row.id,
            organizationRef: row.organizationId,
            newVersion: row.version,
            reasonCode: "INITIAL_ASSIGNMENT",
          });
        }
        await evaluateDuplicates(ctx, created, cycle.organizationId);
        return { outcome: "CREATED", targetId: row.id, version: row.version };
      },
    );
  });
}

// --------------------------------------------------- candidacy transitions

export type CandidacyCommandInput = Readonly<{
  commandKey?: string;
  candidacyId?: string;
  expectedVersion?: string;
  reasonCode?: string;
}>;

async function lockCandidacy(
  ctx: CommandContext,
  publicId: string,
): Promise<CandidacyRow> {
  const row = await findCandidacyByPublicId(ctx.tx, publicId, "update");
  return row ?? refuse("NOT_FOUND");
}

const recordOf = (row: CandidacyRow) =>
  ({
    kind: "RECORD",
    id: row.id,
    sensitivity: "CONFIDENTIAL_PERSONNEL",
  }) as const;

/** start_application_from_prospect: same candidacy, same person. */
export async function startApplicationFromProspect(
  input: CandidacyCommandInput,
  actor: CandidateActor,
  deps: CandidateDependencies = candidateDependencies(),
): Promise<CandidateResult> {
  return validated(async () => {
    if (!isCandidacyPublicId(input.candidacyId))
      return { kind: "REFUSED", reason: "NOT_FOUND" };
    const expected = version(input.expectedVersion);
    return runCandidateCommand(
      deps,
      actor,
      {
        name: "start_application_from_prospect",
        commandKey: input.commandKey,
        fingerprint: fingerprint({ id: input.candidacyId, expected }),
      },
      async (ctx) => {
        const row = await lockCandidacy(ctx, input.candidacyId!);
        await authorizeCandidateCommand(
          ctx,
          deps,
          "candidate.prospect.create",
          "CREATE",
          recordOf(row),
        );
        if (row.version !== expected) refuse("STALE_VERSION");
        const to =
          stageTransition("start_application_from_prospect", {
            stage: row.currentStage as CandidacyStage,
            status: row.status as CandidacyStatus,
          }) ?? refuse("INVALID_TRANSITION");
        await acceptingCycle(ctx, { cycleId: row.hiringCycleId });
        const updated =
          (await updateCandidacy(
            ctx.tx,
            row.id,
            expected,
            {
              currentStage: to.stage,
              status: to.status,
              candidateVisibleStatus: candidateVisibleStatus(
                to.stage,
                to.status,
              ),
              startedAt: ctx.now,
            },
            ctx.actorId,
            ctx.now,
          )) ?? refuse("STALE_VERSION");
        await recordStage(
          ctx,
          updated,
          "start_application_from_prospect",
          {
            stage: row.currentStage,
            status: row.status,
            version: row.version,
          },
          null,
        );
        return {
          outcome: "UPDATED",
          targetId: row.id,
          version: updated.version,
        };
      },
    );
  });
}

/** close_prospect: PROSPECT → TERMINAL with a bounded reason; nothing erased. */
export async function closeProspect(
  input: CandidacyCommandInput,
  actor: CandidateActor,
  deps: CandidateDependencies = candidateDependencies(),
): Promise<CandidateResult> {
  return validated(async () => {
    if (!isCandidacyPublicId(input.candidacyId))
      return { kind: "REFUSED", reason: "NOT_FOUND" };
    const expected = version(input.expectedVersion);
    if (!isMember(prospectCloseReasons, input.reasonCode))
      return { kind: "REFUSED", reason: "INVALID_INPUT" };
    const reason = input.reasonCode;
    return runCandidateCommand(
      deps,
      actor,
      {
        name: "close_prospect",
        commandKey: input.commandKey,
        fingerprint: fingerprint({ id: input.candidacyId, expected, reason }),
      },
      async (ctx) => {
        const row = await lockCandidacy(ctx, input.candidacyId!);
        await authorizeCandidateCommand(
          ctx,
          deps,
          "candidate.prospect.close",
          "EDIT",
          recordOf(row),
          reason,
        );
        if (row.version !== expected) refuse("STALE_VERSION");
        const to =
          stageTransition("close_prospect", {
            stage: row.currentStage as CandidacyStage,
            status: row.status as CandidacyStatus,
          }) ?? refuse("INVALID_TRANSITION");
        const updated =
          (await updateCandidacy(
            ctx.tx,
            row.id,
            expected,
            {
              status: to.status,
              candidateVisibleStatus: candidateVisibleStatus(
                to.stage,
                to.status,
              ),
              closedAt: ctx.now,
              closureReasonCode: reason,
            },
            ctx.actorId,
            ctx.now,
          )) ?? refuse("STALE_VERSION");
        await recordStage(
          ctx,
          updated,
          "close_prospect",
          {
            stage: row.currentStage,
            status: row.status,
            version: row.version,
          },
          reason,
        );
        ctx.events.push({
          code: "prospect.closed",
          recordRef: row.id,
          candidacyRef: row.id,
          organizationRef: row.organizationId,
          previousVersion: row.version,
          newVersion: updated.version,
          reasonCode: reason,
        });
        return {
          outcome: "UPDATED",
          targetId: row.id,
          version: updated.version,
        };
      },
    );
  });
}

/**
 * assign_candidacy_owner: operational ownership only. M2.2 supports
 * assigning the acting staff member (no staff directory exists yet); the
 * actor's own authorization on the record proves eligibility and scope.
 * It never grants candidate-account ownership.
 */
export async function assignCandidacyOwnerToSelf(
  input: CandidacyCommandInput,
  actor: CandidateActor,
  deps: CandidateDependencies = candidateDependencies(),
): Promise<CandidateResult> {
  return validated(async () => {
    if (actor.kind === "CANDIDATE")
      return { kind: "REFUSED", reason: "NOT_AUTHORIZED" };
    if (!isCandidacyPublicId(input.candidacyId))
      return { kind: "REFUSED", reason: "NOT_FOUND" };
    const expected = version(input.expectedVersion);
    return runCandidateCommand(
      deps,
      actor,
      {
        name: "assign_candidacy_owner",
        commandKey: input.commandKey,
        fingerprint: fingerprint({ id: input.candidacyId, expected }),
      },
      async (ctx) => {
        const row = await lockCandidacy(ctx, input.candidacyId!);
        await authorizeCandidateCommand(
          ctx,
          deps,
          "candidate.owner.assign",
          "EDIT",
          recordOf(row),
          "WORKLOAD_BALANCE",
        );
        await authorizeCandidateCommand(
          ctx,
          deps,
          "candidate.prospect.read",
          "READ",
          recordOf(row),
        );
        if (row.version !== expected) refuse("STALE_VERSION");
        if (row.status !== "ACTIVE") refuse("INVALID_TRANSITION");
        const updated =
          (await updateCandidacy(
            ctx.tx,
            row.id,
            expected,
            { ownerAccountId: ctx.actorId },
            ctx.actorId,
            ctx.now,
          )) ?? refuse("STALE_VERSION");
        ctx.events.push({
          code: "candidacy.owner_assigned",
          recordRef: row.id,
          candidacyRef: row.id,
          organizationRef: row.organizationId,
          previousVersion: row.version,
          newVersion: updated.version,
          reasonCode: "WORKLOAD_BALANCE",
        });
        return {
          outcome: "UPDATED",
          targetId: row.id,
          version: updated.version,
        };
      },
    );
  });
}

// ------------------------------------------------- duplicate review/merge

export type MatchCommandInput = Readonly<{
  commandKey?: string;
  matchId?: string;
  expectedVersion?: string;
  decision?: string;
  reasonCode?: string;
}>;

/** review_duplicate_match: PENDING → NOT_DUPLICATE or CONFIRMED_DUPLICATE. */
export async function reviewDuplicateMatch(
  input: MatchCommandInput,
  actor: CandidateActor,
  deps: CandidateDependencies = candidateDependencies(),
): Promise<CandidateResult> {
  return validated(async () => {
    if (!isCandidacyPublicId(input.matchId))
      return { kind: "REFUSED", reason: "NOT_FOUND" };
    const expected = version(input.expectedVersion);
    const decision = input.decision;
    const reason = input.reasonCode;
    const coherent =
      (decision === "CONFIRMED_DUPLICATE" &&
        reason === "SAME_PERSON_CONFIRMED") ||
      (decision === "NOT_DUPLICATE" &&
        (reason === "DIFFERENT_PEOPLE_CONFIRMED" ||
          reason === "INSUFFICIENT_EVIDENCE"));
    if (!coherent || !isMember(reviewReasons, reason))
      return { kind: "REFUSED", reason: "INVALID_INPUT" };
    return runCandidateCommand(
      deps,
      actor,
      {
        name: "review_duplicate_match",
        commandKey: input.commandKey,
        fingerprint: fingerprint({
          id: input.matchId,
          expected,
          decision,
          reason,
        }),
      },
      async (ctx) => {
        const match =
          (await findMatchByPublicId(ctx.tx, input.matchId!, "update")) ??
          refuse("NOT_FOUND");
        await authorizeCandidateCommand(
          ctx,
          deps,
          "candidate.duplicate.review",
          "REVIEW",
          {
            kind: "RECORD",
            id: match.id,
            sensitivity: "CONFIDENTIAL_PERSONNEL",
          },
          reason,
        );
        if (match.version !== expected) refuse("STALE_VERSION");
        if (match.status !== "PENDING") refuse("INVALID_TRANSITION");
        const updated =
          (await updateMatch(
            ctx.tx,
            match.id,
            expected,
            {
              status: decision!,
              reviewedByAccountId: ctx.actorId,
              reviewedAt: ctx.now,
              reasonCode: reason,
            },
            ctx.now,
          )) ?? refuse("STALE_VERSION");
        ctx.events.push({
          code: "duplicate_match.reviewed",
          recordRef: match.id,
          organizationRef: match.organizationId,
          previousVersion: match.version,
          newVersion: updated.version,
          reasonCode: reason,
          changeCodes: [decision!],
        });
        return {
          outcome: decision!,
          targetId: match.id,
          version: updated.version,
        };
      },
    );
  });
}

async function mergeSide(
  ctx: CommandContext,
  row: PersonRow,
  cycles: readonly CandidacyRow[],
): Promise<MergeSide> {
  return {
    personId: row.id,
    status: row.status as MergeSide["status"],
    candidateAccountId: row.candidateAccountId,
    createdAt: row.createdAt,
    activeCycleIds: cycles
      .filter((c) => c.personId === row.id && c.status === "ACTIVE")
      .map((c) => c.hiringCycleId),
  };
}

/**
 * merge_people: provenance-preserving merge of a CONFIRMED case. Locks the
 * case, both people (ID order), and every candidacy of both; blocks with
 * zero changes on any gate failure; otherwise reparents candidacies,
 * transfers the single account link, marks the merged person MERGED with a
 * redirect to the survivor, and writes an immutable merge record.
 */
export async function mergePeople(
  input: MatchCommandInput,
  actor: CandidateActor,
  deps: CandidateDependencies = candidateDependencies(),
): Promise<CandidateResult> {
  return validated(async () => {
    if (!isCandidacyPublicId(input.matchId))
      return { kind: "REFUSED", reason: "NOT_FOUND" };
    const expected = version(input.expectedVersion);
    if (!isMember(mergeReasons, input.reasonCode))
      return { kind: "REFUSED", reason: "INVALID_INPUT" };
    const reason = input.reasonCode;
    let blockedContext: { matchId: string; organizationId: string } | null =
      null;
    const result = await runCandidateCommand(
      deps,
      actor,
      {
        name: "merge_people",
        commandKey: input.commandKey,
        fingerprint: fingerprint({ id: input.matchId, expected, reason }),
      },
      async (ctx) => {
        const match =
          (await findMatchByPublicId(ctx.tx, input.matchId!, "update")) ??
          refuse("NOT_FOUND");
        await authorizeCandidateCommand(
          ctx,
          deps,
          "candidate.person.merge",
          "APPROVE",
          {
            kind: "RECORD",
            id: match.id,
            sensitivity: "CONFIDENTIAL_PERSONNEL",
          },
          reason,
        );
        if (match.version !== expected) refuse("STALE_VERSION");
        blockedContext = {
          matchId: match.id,
          organizationId: match.organizationId,
        };
        const [firstId, secondId] = [match.personAId, match.personBId].sort();
        const first =
          (await findPerson(ctx.tx, firstId!, "update")) ?? refuse("NOT_FOUND");
        const second =
          (await findPerson(ctx.tx, secondId!, "update")) ??
          refuse("NOT_FOUND");
        const candidacies = await lockActiveCandidaciesOf(ctx.tx, [
          first.id,
          second.id,
        ]);
        const decision = decideMerge(
          match.status,
          await mergeSide(ctx, first, candidacies),
          await mergeSide(ctx, second, candidacies),
        );
        if (decision.kind === "BLOCKED") return refuse(decision.reason);
        const survivor =
          decision.survivor.personId === first.id ? first : second;
        const merged = survivor === first ? second : first;
        const mergeRecordId = await insertMergeRecord(ctx.tx, {
          survivingPersonId: survivor.id,
          mergedPersonId: merged.id,
          matchId: match.id,
          fieldResolutionCodes: decision.resolutionCodes,
          reasonCode: reason,
          executedByAccountId: ctx.actorId,
          occurredAt: ctx.now,
        });
        const mergedRow =
          (await updatePersonForMerge(
            ctx.tx,
            merged.id,
            merged.version,
            {
              status: "MERGED",
              mergedIntoPersonId: survivor.id,
              mergedAt: ctx.now,
              candidateAccountId: null,
            },
            ctx.actorId,
            ctx.now,
          )) ?? refuse("STALE_VERSION");
        let survivorVersion = survivor.version;
        if (merged.candidateAccountId) {
          const transferred =
            (await updatePersonForMerge(
              ctx.tx,
              survivor.id,
              survivor.version,
              { candidateAccountId: merged.candidateAccountId },
              ctx.actorId,
              ctx.now,
            )) ?? refuse("STALE_VERSION");
          survivorVersion = transferred.version;
          ctx.events.push({
            code: "person.account_linked",
            recordRef: survivor.id,
            accountRef: merged.candidateAccountId,
            organizationRef: match.organizationId,
            previousVersion: survivor.version,
            newVersion: transferred.version,
            changeCodes: ["MERGE_TRANSFER"],
          });
        }
        const references = await reparentCandidacies(
          ctx.tx,
          merged.id,
          survivor.id,
          ctx.actorId,
          ctx.now,
        );
        const closed =
          (await updateMatch(
            ctx.tx,
            match.id,
            match.version,
            { status: "MERGED", mergeRecordId },
            ctx.now,
          )) ?? refuse("STALE_VERSION");
        ctx.events.push(
          {
            code: "person.merged",
            recordRef: merged.id,
            organizationRef: match.organizationId,
            previousVersion: merged.version,
            newVersion: mergedRow.version,
            reasonCode: reason,
            changeCodes: decision.resolutionCodes,
            count: references.length,
          },
          {
            code: "duplicate_match.reviewed",
            recordRef: match.id,
            organizationRef: match.organizationId,
            previousVersion: match.version,
            newVersion: closed.version,
            reasonCode: reason,
            changeCodes: ["MERGED"],
          },
        );
        void survivorVersion;
        return {
          outcome: "MERGED",
          targetId: survivor.id,
          version: survivorVersion,
        };
      },
    );
    if (
      result.kind === "REFUSED" &&
      result.reason.startsWith("BLOCKED_") &&
      blockedContext
    ) {
      const context = blockedContext as {
        matchId: string;
        organizationId: string;
      };
      await deps.events.record({
        code: "person.merge_blocked",
        recordRef: context.matchId,
        organizationRef: context.organizationId,
        reasonCode: result.reason,
        ...(actor.kind === "BOOTSTRAP"
          ? { systemActor: "TEST_HARNESS" as const }
          : { actorRef: actor.principal.accountId }),
      });
    }
    return result;
  });
}

import "server-only";
import { randomBytes } from "node:crypto";
import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  ne,
  or,
  sql,
  type AnyColumn,
  type SQL,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Database } from "@/shared/database";
import type { QueryConstraint } from "@/modules/identity-access/application/authorize";
import { constraintPredicate } from "@/modules/identity-access/infrastructure/scope-predicates";
import { referenceAlphabet } from "../domain/candidacy-policy";
import {
  candidacy,
  candidacyHold,
  candidacyStageHistory,
  candidateCommandReceipt,
  duplicateCandidateMatch,
  person,
  personMergeRecord,
  workItem,
  workResponsibilityHistory,
} from "./candidates-schema";
import { user } from "@/modules/identity-access/infrastructure/auth-schema";
import {
  branch,
  position,
} from "@/modules/organization/infrastructure/organization-schema";
import {
  dueWindow,
  type WorkQueueCursor,
  type WorkQueueFilters,
} from "../domain/work-queue";

// Candidates-module repository (packet M2.2 §17, §21–§22). Narrow named
// statements only: no generic update, patch, search, or delete. Version
// predicates repeat the command's optimistic check in SQL.

export type Executor = Pick<
  Database,
  "select" | "selectDistinct" | "insert" | "update" | "delete" | "execute"
>;

type Lock = "update" | "share" | null;

function locked<T extends { for: (mode: "update" | "share") => unknown }>(
  query: T,
  lock: Lock,
) {
  return lock ? query.for(lock) : query;
}

const lowerAlphabet = referenceAlphabet.toLowerCase();

/** 12 random Crockford characters for route identifiers. */
export function newPublicId(): string {
  let out = "";
  for (const byte of randomBytes(12)) out += lowerAlphabet[byte & 31];
  return out;
}

/** "C-" + 8 random Crockford characters (~40 bits; unique constraint). */
export function newCandidateReference(): string {
  let out = "C-";
  for (const byte of randomBytes(8)) out += referenceAlphabet[byte & 31];
  return out;
}

export type PersonRow = typeof person.$inferSelect;
export type CandidacyRow = typeof candidacy.$inferSelect;
export type MatchRow = typeof duplicateCandidateMatch.$inferSelect;

// ------------------------------------------------------------------ person

export async function findPersonByAccount(
  tx: Executor,
  accountId: string,
  lock: Lock,
): Promise<PersonRow | null> {
  const rows = await locked(
    tx.select().from(person).where(eq(person.candidateAccountId, accountId)),
    lock,
  );
  return (rows as PersonRow[])[0] ?? null;
}

export async function findPerson(
  tx: Executor,
  id: string,
  lock: Lock,
): Promise<PersonRow | null> {
  const rows = await locked(
    tx.select().from(person).where(eq(person.id, id)),
    lock,
  );
  return (rows as PersonRow[])[0] ?? null;
}

export async function insertPerson(
  tx: Executor,
  values: Readonly<{
    legalFirstName: string;
    legalMiddleName: string | null;
    legalLastName: string;
    preferredName: string | null;
    emailDisplay: string;
    emailNormalized: string;
    phoneDisplay: string | null;
    phoneE164: string | null;
    normalizationVersion: string;
    candidateAccountId: string | null;
  }>,
  actorId: string,
  now: Date,
): Promise<PersonRow> {
  const [row] = await tx
    .insert(person)
    .values({
      ...values,
      createdAt: now,
      updatedAt: now,
      createdByAccountId: actorId,
      updatedByAccountId: actorId,
    })
    .returning();
  return row!;
}

// --------------------------------------------------------------- candidacy

export async function findActiveCandidacy(
  tx: Executor,
  personId: string,
  hiringCycleId: string,
): Promise<CandidacyRow | null> {
  const [row] = await tx
    .select()
    .from(candidacy)
    .where(
      and(
        eq(candidacy.personId, personId),
        eq(candidacy.hiringCycleId, hiringCycleId),
        eq(candidacy.status, "ACTIVE"),
      ),
    );
  return row ?? null;
}

export async function findCandidacyByPublicId(
  tx: Executor,
  publicId: string,
  lock: Lock,
): Promise<CandidacyRow | null> {
  const rows = await locked(
    tx.select().from(candidacy).where(eq(candidacy.publicId, publicId)),
    lock,
  );
  return (rows as CandidacyRow[])[0] ?? null;
}

export async function findCandidacy(
  tx: Executor,
  id: string,
  lock: Lock,
): Promise<CandidacyRow | null> {
  const rows = await locked(
    tx.select().from(candidacy).where(eq(candidacy.id, id)),
    lock,
  );
  return (rows as CandidacyRow[])[0] ?? null;
}

export async function insertCandidacy(
  tx: Executor,
  values: Readonly<{
    personId: string;
    hiringCycleId: string;
    organizationId: string;
    positionId: string;
    branchId: string;
    teamId: string | null;
    sourceCode: string;
    currentStage: string;
    candidateVisibleStatus: string;
    ownerAccountId: string | null;
    startedAt: Date | null;
  }>,
  actorId: string,
  now: Date,
): Promise<CandidacyRow> {
  const [row] = await tx
    .insert(candidacy)
    .values({
      ...values,
      publicId: newPublicId(),
      candidateReference: newCandidateReference(),
      createdAt: now,
      updatedAt: now,
      createdByAccountId: actorId,
      updatedByAccountId: actorId,
    })
    .returning();
  return row!;
}

export async function updateCandidacy(
  tx: Executor,
  id: string,
  expectedVersion: number,
  patch: Partial<
    Pick<
      CandidacyRow,
      | "currentStage"
      | "status"
      | "candidateVisibleStatus"
      | "ownerAccountId"
      | "startedAt"
      | "closedAt"
      | "closureReasonCode"
      | "personId"
    >
  >,
  actorId: string,
  now: Date,
): Promise<CandidacyRow | null> {
  const [row] = await tx
    .update(candidacy)
    .set({
      ...patch,
      version: sql`${candidacy.version} + 1`,
      updatedAt: now,
      updatedByAccountId: actorId,
    })
    .where(and(eq(candidacy.id, id), eq(candidacy.version, expectedVersion)))
    .returning();
  return row ?? null;
}

export async function insertStageHistory(
  tx: Executor,
  values: Readonly<{
    candidacyId: string;
    fromStage: string | null;
    toStage: string;
    fromStatus: string | null;
    toStatus: string;
    commandCode: string;
    actorAccountId: string | null;
    systemActor: string | null;
    reasonCode: string | null;
    versionBefore: number | null;
    versionAfter: number;
    correlationId: string | null;
    occurredAt: Date;
  }>,
): Promise<void> {
  await tx.insert(candidacyStageHistory).values(values);
}

export async function listStageHistory(tx: Executor, candidacyId: string) {
  return tx
    .select({
      fromStage: candidacyStageHistory.fromStage,
      toStage: candidacyStageHistory.toStage,
      toStatus: candidacyStageHistory.toStatus,
      commandCode: candidacyStageHistory.commandCode,
      reasonCode: candidacyStageHistory.reasonCode,
      occurredAt: candidacyStageHistory.occurredAt,
    })
    .from(candidacyStageHistory)
    .where(eq(candidacyStageHistory.candidacyId, candidacyId))
    .orderBy(asc(candidacyStageHistory.occurredAt))
    .limit(50);
}

// ---------------------------------------------------------------- duplicates

/**
 * ACTIVE people (other than `excludePersonId`) with a candidacy in the
 * organization whose normalized email or E.164 phone equals the given
 * values. Exact B-tree lookups only; at most 20 rows.
 */
export async function findSignalPeople(
  tx: Executor,
  organizationId: string,
  emailNormalized: string,
  phoneE164: string | null,
  excludePersonId: string | null,
): Promise<
  readonly Readonly<{
    id: string;
    emailNormalized: string;
    phoneE164: string | null;
  }>[]
> {
  const signal: SQL = phoneE164
    ? or(
        eq(person.emailNormalized, emailNormalized),
        eq(person.phoneE164, phoneE164),
      )!
    : eq(person.emailNormalized, emailNormalized);
  return tx
    .selectDistinct({
      id: person.id,
      emailNormalized: person.emailNormalized,
      phoneE164: person.phoneE164,
    })
    .from(person)
    .innerJoin(candidacy, eq(candidacy.personId, person.id))
    .where(
      and(
        signal,
        eq(person.status, "ACTIVE"),
        eq(candidacy.organizationId, organizationId),
        excludePersonId ? ne(person.id, excludePersonId) : undefined,
      ),
    )
    .orderBy(asc(person.id))
    .limit(20);
}

/** Inserts a PENDING case unless an open case exists for the pair/ruleset. */
export async function insertMatchIfAbsent(
  tx: Executor,
  values: Readonly<{
    organizationId: string;
    personAId: string;
    personBId: string;
    rulesetVersion: string;
    signalCodes: string[];
    confidenceTier: string;
  }>,
  now: Date,
): Promise<MatchRow | null> {
  const rows = await tx
    .insert(duplicateCandidateMatch)
    .values({
      ...values,
      publicId: newPublicId(),
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing({
      target: [
        duplicateCandidateMatch.personAId,
        duplicateCandidateMatch.personBId,
        duplicateCandidateMatch.rulesetVersion,
      ],
      where: sql`${duplicateCandidateMatch.status} IN ('PENDING', 'CONFIRMED_DUPLICATE')`,
    })
    .returning();
  return rows[0] ?? null;
}

export async function findMatchByPublicId(
  tx: Executor,
  publicId: string,
  lock: Lock,
): Promise<MatchRow | null> {
  const rows = await locked(
    tx
      .select()
      .from(duplicateCandidateMatch)
      .where(eq(duplicateCandidateMatch.publicId, publicId)),
    lock,
  );
  return (rows as MatchRow[])[0] ?? null;
}

export async function updateMatch(
  tx: Executor,
  id: string,
  expectedVersion: number,
  patch: Partial<
    Pick<
      MatchRow,
      | "status"
      | "reviewedByAccountId"
      | "reviewedAt"
      | "reasonCode"
      | "mergeRecordId"
    >
  >,
  now: Date,
): Promise<MatchRow | null> {
  const [row] = await tx
    .update(duplicateCandidateMatch)
    .set({
      ...patch,
      version: sql`${duplicateCandidateMatch.version} + 1`,
      updatedAt: now,
    })
    .where(
      and(
        eq(duplicateCandidateMatch.id, id),
        eq(duplicateCandidateMatch.version, expectedVersion),
      ),
    )
    .returning();
  return row ?? null;
}

/** Whether a person has an open duplicate case (staff flag only). */
export async function hasOpenDuplicate(
  tx: Executor,
  personId: string,
  organizationId: string,
): Promise<boolean> {
  const [row] = await tx
    .select({ id: duplicateCandidateMatch.id })
    .from(duplicateCandidateMatch)
    .where(
      and(
        eq(duplicateCandidateMatch.organizationId, organizationId),
        inArray(duplicateCandidateMatch.status, [
          "PENDING",
          "CONFIRMED_DUPLICATE",
        ]),
        or(
          eq(duplicateCandidateMatch.personAId, personId),
          eq(duplicateCandidateMatch.personBId, personId),
        ),
      ),
    )
    .limit(1);
  return Boolean(row);
}

const noSubject = sql`NULL::uuid` as unknown as AnyColumn;

/** Open duplicate cases inside the authorized constraint (no PII). */
export async function listOpenMatchesInScope(
  tx: Executor,
  constraint: QueryConstraint,
) {
  return tx
    .select({
      id: duplicateCandidateMatch.id,
      publicId: duplicateCandidateMatch.publicId,
      confidenceTier: duplicateCandidateMatch.confidenceTier,
      status: duplicateCandidateMatch.status,
      createdAt: duplicateCandidateMatch.createdAt,
    })
    .from(duplicateCandidateMatch)
    .where(
      and(
        inArray(duplicateCandidateMatch.status, [
          "PENDING",
          "CONFIRMED_DUPLICATE",
        ]),
        constraintPredicate(constraint, {
          organizationId: duplicateCandidateMatch.organizationId,
          branchId: sql`NULL::uuid` as unknown as AnyColumn,
          teamId: sql`NULL::uuid` as unknown as AnyColumn,
          subjectAccountId: noSubject,
        }),
      ),
    )
    .orderBy(
      desc(duplicateCandidateMatch.createdAt),
      asc(duplicateCandidateMatch.id),
    )
    .limit(50);
}

// ------------------------------------------------------------------- merge

export async function lockActiveCandidaciesOf(
  tx: Executor,
  personIds: readonly string[],
): Promise<readonly CandidacyRow[]> {
  const rows = await tx
    .select()
    .from(candidacy)
    .where(inArray(candidacy.personId, [...personIds]))
    .orderBy(asc(candidacy.id))
    .for("update");
  return rows;
}

export async function reparentCandidacies(
  tx: Executor,
  fromPersonId: string,
  toPersonId: string,
  actorId: string,
  now: Date,
): Promise<readonly string[]> {
  const rows = await tx
    .update(candidacy)
    .set({
      personId: toPersonId,
      version: sql`${candidacy.version} + 1`,
      updatedAt: now,
      updatedByAccountId: actorId,
    })
    .where(eq(candidacy.personId, fromPersonId))
    .returning({
      id: candidacy.id,
      candidateReference: candidacy.candidateReference,
    });
  return rows.map((r) => r.candidateReference);
}

export async function updatePersonForMerge(
  tx: Executor,
  id: string,
  expectedVersion: number,
  patch: Partial<
    Pick<
      PersonRow,
      "status" | "mergedIntoPersonId" | "mergedAt" | "candidateAccountId"
    >
  >,
  actorId: string,
  now: Date,
): Promise<PersonRow | null> {
  const [row] = await tx
    .update(person)
    .set({
      ...patch,
      version: sql`${person.version} + 1`,
      updatedAt: now,
      updatedByAccountId: actorId,
    })
    .where(and(eq(person.id, id), eq(person.version, expectedVersion)))
    .returning();
  return row ?? null;
}

export async function insertMergeRecord(
  tx: Executor,
  values: Readonly<{
    survivingPersonId: string;
    mergedPersonId: string;
    matchId: string;
    fieldResolutionCodes: string[];
    reasonCode: string;
    executedByAccountId: string;
    occurredAt: Date;
  }>,
): Promise<string> {
  const [row] = await tx
    .insert(personMergeRecord)
    .values(values)
    .returning({ id: personMergeRecord.id });
  return row!.id;
}

// ---------------------------------------------------------------- receipts

export type Receipt = Readonly<{
  commandName: string;
  requestFingerprint: string;
  targetId: string;
  resultVersion: number;
  outcomeCode: string;
}>;

export async function findReceipt(
  tx: Executor,
  actorAccountId: string,
  commandKey: string,
): Promise<Receipt | null> {
  const [row] = await tx
    .select({
      commandName: candidateCommandReceipt.commandName,
      requestFingerprint: candidateCommandReceipt.requestFingerprint,
      targetId: candidateCommandReceipt.targetId,
      resultVersion: candidateCommandReceipt.resultVersion,
      outcomeCode: candidateCommandReceipt.outcomeCode,
    })
    .from(candidateCommandReceipt)
    .where(
      and(
        eq(candidateCommandReceipt.actorAccountId, actorAccountId),
        eq(candidateCommandReceipt.commandKey, commandKey),
      ),
    );
  return row ?? null;
}

export async function insertReceipt(
  tx: Executor,
  values: Readonly<{
    actorAccountId: string;
    commandKey: string;
    commandName: string;
    requestFingerprint: string;
    targetId: string;
    resultVersion: number;
    outcomeCode: string;
  }>,
): Promise<void> {
  await tx.insert(candidateCommandReceipt).values(values);
}

// --------------------------------------------------- authorization lookups

export type CandidateRecordPlacement = Readonly<{
  organizationId: string;
  branchId: string | null;
  teamId: string | null;
  recordedAt: Date;
  subjectAccountIds: readonly string[];
}>;

/** Placement of a candidacy or duplicate case for staff authorization. */
export async function findCandidateRecordPlacement(
  db: Executor,
  id: string,
): Promise<CandidateRecordPlacement | null> {
  const [c] = await db
    .select({
      organizationId: candidacy.organizationId,
      branchId: candidacy.branchId,
      teamId: candidacy.teamId,
      recordedAt: candidacy.createdAt,
      subject: person.candidateAccountId,
    })
    .from(candidacy)
    .innerJoin(person, eq(person.id, candidacy.personId))
    .where(eq(candidacy.id, id));
  if (c) {
    return {
      organizationId: c.organizationId,
      branchId: c.branchId,
      teamId: c.teamId,
      recordedAt: c.recordedAt,
      subjectAccountIds: c.subject ? [c.subject] : [],
    };
  }
  const [m] = await db
    .select({
      organizationId: duplicateCandidateMatch.organizationId,
      recordedAt: duplicateCandidateMatch.createdAt,
      a: duplicateCandidateMatch.personAId,
      b: duplicateCandidateMatch.personBId,
    })
    .from(duplicateCandidateMatch)
    .where(eq(duplicateCandidateMatch.id, id));
  if (!m) return null;
  const owners = await db
    .select({ account: person.candidateAccountId })
    .from(person)
    .where(
      and(inArray(person.id, [m.a, m.b]), isNotNull(person.candidateAccountId)),
    );
  return {
    organizationId: m.organizationId,
    branchId: null,
    teamId: null,
    recordedAt: m.recordedAt,
    subjectAccountIds: owners.map((o) => o.account!).filter(Boolean),
  };
}

/** Does this candidate account own the person or candidacy? */
export async function accountOwnsRecord(
  db: Executor,
  accountId: string,
  resourceId: string,
): Promise<boolean | null> {
  const [p] = await db
    .select({ owner: person.candidateAccountId })
    .from(person)
    .where(eq(person.id, resourceId));
  if (p) return p.owner === accountId;
  const [c] = await db
    .select({ owner: person.candidateAccountId })
    .from(candidacy)
    .innerJoin(person, eq(person.id, candidacy.personId))
    .where(eq(candidacy.id, resourceId));
  if (c) return c.owner === accountId;
  return null;
}

// --------------------------------------------------------- portal reads

export type WorkItemRow = typeof workItem.$inferSelect;

/** An owner's candidacies, newest first; bounded. */
export async function listCandidaciesOfPerson(
  db: Executor,
  personId: string,
  limit = 50,
): Promise<CandidacyRow[]> {
  return db
    .select()
    .from(candidacy)
    .where(eq(candidacy.personId, personId))
    .orderBy(desc(candidacy.updatedAt), asc(candidacy.publicId))
    .limit(limit);
}

/** Candidate-action tasks on candidacies the caller already owns; bounded. */
export async function listCandidateWorkItems(
  db: Executor,
  candidacyIds: readonly string[],
  limit = 200,
): Promise<WorkItemRow[]> {
  if (candidacyIds.length === 0) return [];
  return db
    .select()
    .from(workItem)
    .where(
      and(
        inArray(workItem.candidacyId, [...candidacyIds]),
        eq(workItem.candidateActionRequired, true),
      ),
    )
    .orderBy(asc(workItem.createdAt), asc(workItem.id))
    .limit(limit);
}

// ----------------------------------------------------- work-item writes

/** Opens the one COMPLETE_APPLICATION task; safe if it already exists. */
export async function ensureCompleteApplicationTask(
  db: Executor,
  candidacyId: string,
  sourceCode: "CANDIDACY_TRANSITION" | "RECONCILIATION",
): Promise<void> {
  await db
    .insert(workItem)
    .values({
      candidacyId,
      workTypeCode: "COMPLETE_APPLICATION",
      targetRecordType: "CANDIDACY",
      targetRecordId: candidacyId,
      candidateActionRequired: true,
      sourceCode,
    })
    .onConflictDoNothing();
}

/** Completes the candidate's task when their application is submitted. */
export async function completeApplicationTask(
  db: Executor,
  candidacyId: string,
  now: Date,
): Promise<void> {
  await db
    .update(workItem)
    .set({
      status: "COMPLETED",
      completedAt: now,
      version: sql`${workItem.version} + 1`,
    })
    .where(
      and(
        eq(workItem.candidacyId, candidacyId),
        inArray(workItem.workTypeCode, [
          "COMPLETE_APPLICATION",
          "CORRECT_APPLICATION",
        ]),
        inArray(workItem.status, ["OPEN", "IN_PROGRESS", "BLOCKED"]),
      ),
    );
}

/** A return finishes the review item and asks the candidate to correct. */
export async function swapReviewItemForCorrection(
  db: Executor,
  candidacyId: string,
  now: Date,
): Promise<void> {
  await completeOpenStaffWork(db, candidacyId, now);
  await db
    .insert(workItem)
    .values({
      candidacyId,
      workTypeCode: "CORRECT_APPLICATION",
      targetRecordType: "CANDIDACY",
      targetRecordId: candidacyId,
      candidateActionRequired: true,
      sourceCode: "CANDIDACY_TRANSITION",
    })
    .onConflictDoNothing();
}

/** One staff review item, unassigned until staff workflows arrive. */
export async function openReviewQueueItem(
  db: Executor,
  candidacyId: string,
): Promise<void> {
  await db
    .insert(workItem)
    .values({
      candidacyId,
      workTypeCode: "REVIEW_SUBMITTED_APPLICATION",
      targetRecordType: "CANDIDACY",
      targetRecordId: candidacyId,
      candidateActionRequired: false,
      sourceCode: "CANDIDACY_TRANSITION",
    })
    .onConflictDoNothing();
}

/** Open staff review items in a scope, oldest first; bounded. */
export async function listSubmittedQueueInScope(
  db: Executor,
  constraint: QueryConstraint,
  limit = 100,
) {
  return db
    .select({
      candidacy,
      queuedAt: workItem.createdAt,
    })
    .from(workItem)
    .innerJoin(candidacy, eq(candidacy.id, workItem.candidacyId))
    .innerJoin(person, eq(person.id, candidacy.personId))
    .where(
      and(
        eq(workItem.workTypeCode, "REVIEW_SUBMITTED_APPLICATION"),
        inArray(workItem.status, ["OPEN", "IN_PROGRESS", "BLOCKED"]),
        constraintPredicate(constraint, {
          organizationId: candidacy.organizationId,
          branchId: candidacy.branchId,
          teamId: candidacy.teamId,
          subjectAccountId: person.candidateAccountId,
        }),
      ),
    )
    .orderBy(asc(workItem.createdAt), asc(workItem.id))
    .limit(limit);
}

/**
 * Bounded reconciliation: opens the missing task for owned active
 * APPLICATION_INCOMPLETE candidacies, and cancels active tasks whose candidacy
 * no longer qualifies. Candidacy state is never changed. Returns counts only.
 */
export async function reconcileWorkItems(
  db: Executor,
  limit: number,
): Promise<Readonly<{ opened: number; canceled: number }>> {
  const opened = await db.execute(sql`
    INSERT INTO app.work_item (candidacy_id, work_type_code, target_record_type, target_record_id, candidate_action_required, source_code)
    SELECT c.id, 'COMPLETE_APPLICATION', 'CANDIDACY', c.id, true, 'RECONCILIATION'
      FROM app.candidacy c
      JOIN app.person p ON p.id = c.person_id
     WHERE c.status = 'ACTIVE' AND c.current_stage = 'APPLICATION_INCOMPLETE'
       AND p.candidate_account_id IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM app.work_item w
          WHERE w.candidacy_id = c.id AND w.work_type_code IN ('COMPLETE_APPLICATION', 'CORRECT_APPLICATION')
            AND w.status IN ('OPEN', 'IN_PROGRESS', 'BLOCKED'))
     ORDER BY c.id
     LIMIT ${limit}
    ON CONFLICT DO NOTHING
  `);
  const canceled = await db.execute(sql`
    UPDATE app.work_item w
       SET status = 'CANCELED', version = w.version + 1, updated_at = now()
     WHERE w.id IN (
       SELECT w2.id FROM app.work_item w2
         JOIN app.candidacy c ON c.id = w2.candidacy_id
        WHERE w2.status IN ('OPEN', 'IN_PROGRESS', 'BLOCKED')
          AND w2.work_type_code IN ('COMPLETE_APPLICATION', 'CORRECT_APPLICATION')
          AND NOT (c.status = 'ACTIVE' AND c.current_stage = 'APPLICATION_INCOMPLETE')
        ORDER BY w2.id
        LIMIT ${limit})
  `);
  const count = (r: unknown) => (r as { rowCount?: number }).rowCount ?? 0;
  return { opened: count(opened), canceled: count(canceled) };
}

// ------------------------------------------------------- M3.1 work queue

const activeWorkStatuses = ["OPEN", "IN_PROGRESS", "BLOCKED"];
const staffItem = alias(workItem, "staff_item");
const ownerAccount = alias(user, "owner_account");

const exactInstant = (column: AnyColumn) =>
  sql<string>`to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

const isReturned = sql<boolean>`EXISTS (SELECT 1 FROM ${workItem} WHERE ${workItem.candidacyId} = ${candidacy.id} AND ${workItem.workTypeCode} = 'CORRECT_APPLICATION' AND ${workItem.status} IN ('OPEN', 'IN_PROGRESS', 'BLOCKED'))`;

const isOnHold = sql<boolean>`EXISTS (SELECT 1 FROM ${candidacyHold} WHERE ${candidacyHold.candidacyId} = ${candidacy.id} AND ${candidacyHold.status} = 'ACTIVE')`;

const staffItemJoin = and(
  eq(staffItem.candidacyId, candidacy.id),
  eq(staffItem.candidateActionRequired, false),
  inArray(staffItem.status, activeWorkStatuses),
);

export type WorkQueueContext = Readonly<{
  constraint: QueryConstraint;
  actorAccountId: string;
  teamIds: readonly string[];
  now: Date;
}>;

function scopedActive(context: WorkQueueContext) {
  return and(
    eq(candidacy.status, "ACTIVE"),
    constraintPredicate(context.constraint, {
      organizationId: candidacy.organizationId,
      branchId: candidacy.branchId,
      teamId: candidacy.teamId,
      subjectAccountId: person.candidateAccountId,
    }),
  )!;
}

function dueCondition(filter: WorkQueueFilters["due"], now: Date) {
  switch (filter) {
    case "OVERDUE":
      return lt(staffItem.dueAt, now);
    case "TODAY":
    case "NEXT_7": {
      const window = dueWindow(filter, now);
      return and(
        gte(staffItem.dueAt, window.from),
        lt(staffItem.dueAt, window.to),
      );
    }
    case "NONE":
      return isNull(staffItem.dueAt);
    default:
      return undefined;
  }
}

function assignmentCondition(
  filter: WorkQueueFilters["assignment"],
  context: WorkQueueContext,
) {
  switch (filter) {
    case "MINE":
      return eq(candidacy.ownerAccountId, context.actorAccountId);
    case "UNASSIGNED":
      return isNull(candidacy.ownerAccountId);
    case "TEAM":
      return context.teamIds.length > 0
        ? inArray(candidacy.teamId, [...context.teamIds])
        : sql`false`;
    default:
      return undefined;
  }
}

function cursorCondition(cursor: WorkQueueCursor | null) {
  if (!cursor) return undefined;
  const after = sql`(${candidacy.createdAt}, ${candidacy.publicId}) > (${cursor.createdAt}::timestamptz, ${cursor.publicId})`;
  if (cursor.dueAt === null) return and(isNull(staffItem.dueAt), after);
  const due = sql`${cursor.dueAt}::timestamptz`;
  return or(
    sql`${staffItem.dueAt} > ${due}`,
    isNull(staffItem.dueAt),
    and(sql`${staffItem.dueAt} = ${due}`, after),
  );
}

function queueWhere(filters: WorkQueueFilters, context: WorkQueueContext) {
  return and(
    scopedActive(context),
    assignmentCondition(filters.assignment, context),
    filters.stage ? eq(candidacy.currentStage, filters.stage) : undefined,
    dueCondition(filters.due, context.now),
    filters.branch ? eq(candidacy.branchId, filters.branch) : undefined,
    filters.position ? eq(candidacy.positionId, filters.position) : undefined,
    filters.workerPath
      ? eq(candidacy.proposedWorkerPath, filters.workerPath)
      : undefined,
    filters.exception === "RETURNED" ? isReturned : undefined,
    filters.exception === "ON_HOLD" ? isOnHold : undefined,
  );
}

/**
 * One page, in a stable order: soonest due first, no due date last, then
 * oldest, then a unique identifier. Scope is in WHERE, so out-of-scope rows are
 * never ordered, counted, or read, and a forged cursor can only move within
 * what the caller may see.
 */
export async function listWorkQueuePage(
  db: Executor,
  filters: WorkQueueFilters,
  context: WorkQueueContext,
  limit: number,
) {
  return db
    .select({
      id: candidacy.id,
      publicId: candidacy.publicId,
      reference: candidacy.candidateReference,
      stage: candidacy.currentStage,
      createdAt: candidacy.createdAt,
      createdAtText: exactInstant(candidacy.createdAt),
      workerPath: candidacy.proposedWorkerPath,
      ownerAccountId: candidacy.ownerAccountId,
      ownerName: ownerAccount.name,
      preferredName: person.preferredName,
      legalFirstName: person.legalFirstName,
      legalLastName: person.legalLastName,
      position: position.internalTitle,
      branch: branch.name,
      itemId: staffItem.id,
      dueAt: staffItem.dueAt,
      dueAtText: exactInstant(staffItem.dueAt),
      returned: isReturned,
      onHold: isOnHold,
    })
    .from(candidacy)
    .innerJoin(person, eq(person.id, candidacy.personId))
    .innerJoin(position, eq(position.id, candidacy.positionId))
    .innerJoin(branch, eq(branch.id, candidacy.branchId))
    .leftJoin(ownerAccount, eq(ownerAccount.id, candidacy.ownerAccountId))
    .leftJoin(staffItem, staffItemJoin)
    .where(and(queueWhere(filters, context), cursorCondition(filters.cursor)))
    .orderBy(
      sql`${staffItem.dueAt} ASC NULLS LAST`,
      asc(candidacy.createdAt),
      asc(candidacy.publicId),
    )
    .limit(limit);
}

/** How many rows match, from the same predicate as the page. */
export async function countWorkQueue(
  db: Executor,
  filters: WorkQueueFilters,
  context: WorkQueueContext,
): Promise<number> {
  const [row] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(candidacy)
    .innerJoin(person, eq(person.id, candidacy.personId))
    .leftJoin(staffItem, staffItemJoin)
    .where(queueWhere(filters, context));
  return row?.total ?? 0;
}

/** Aggregates for the dashboard; every one is inside the caller's scope. */
export async function countWorkQueueDashboard(
  db: Executor,
  context: WorkQueueContext,
) {
  const today = dueWindow("TODAY", context.now);
  const [row] = await db
    .select({
      myDueToday: sql<number>`count(*) FILTER (WHERE ${candidacy.ownerAccountId} = ${context.actorAccountId} AND ${staffItem.dueAt} >= ${today.from.toISOString()}::timestamptz AND ${staffItem.dueAt} < ${today.to.toISOString()}::timestamptz)::int`,
      overdue: sql<number>`count(*) FILTER (WHERE ${staffItem.dueAt} < ${context.now.toISOString()}::timestamptz)::int`,
      unassignedSubmitted: sql<number>`count(*) FILTER (WHERE ${candidacy.ownerAccountId} IS NULL AND ${candidacy.currentStage} = 'APPLICATION_SUBMITTED')::int`,
      returned: sql<number>`count(*) FILTER (WHERE ${isReturned})::int`,
    })
    .from(candidacy)
    .innerJoin(person, eq(person.id, candidacy.personId))
    .leftJoin(staffItem, staffItemJoin)
    .where(scopedActive(context));
  return (
    row ?? { myDueToday: 0, overdue: 0, unassignedSubmitted: 0, returned: 0 }
  );
}

/** Branches and positions the caller's active records are actually in. */
export async function listWorkQueueFilterOptions(
  db: Executor,
  context: WorkQueueContext,
) {
  const base = scopedActive(context);
  const [branches, positions] = await Promise.all([
    db
      .selectDistinct({ id: branch.id, label: branch.name })
      .from(candidacy)
      .innerJoin(person, eq(person.id, candidacy.personId))
      .innerJoin(branch, eq(branch.id, candidacy.branchId))
      .where(base)
      .orderBy(asc(branch.name), asc(branch.id))
      .limit(100),
    db
      .selectDistinct({ id: position.id, label: position.internalTitle })
      .from(candidacy)
      .innerJoin(person, eq(person.id, candidacy.personId))
      .innerJoin(position, eq(position.id, candidacy.positionId))
      .where(base)
      .orderBy(asc(position.internalTitle), asc(position.id))
      .limit(100),
  ]);
  return { branches, positions };
}

/** The one open staff item on a candidacy, optionally locked. */
export async function findOpenStaffWorkItem(
  db: Executor,
  candidacyId: string,
  lock: Lock = null,
) {
  const query = db
    .select()
    .from(workItem)
    .where(
      and(
        eq(workItem.candidacyId, candidacyId),
        eq(workItem.candidateActionRequired, false),
        inArray(workItem.status, activeWorkStatuses),
      ),
    )
    .orderBy(asc(workItem.createdAt), asc(workItem.id))
    .limit(1);
  const [row] = await (locked(query, lock) as typeof query);
  return row ?? null;
}

export async function updateWorkItemDueDate(
  tx: Executor,
  id: string,
  expectedVersion: number,
  dueAt: Date | null,
  now: Date,
) {
  const [row] = await tx
    .update(workItem)
    .set({ dueAt, version: sql`${workItem.version} + 1`, updatedAt: now })
    .where(and(eq(workItem.id, id), eq(workItem.version, expectedVersion)))
    .returning();
  return row ?? null;
}

export async function insertResponsibilityHistory(
  tx: Executor,
  values: Readonly<{
    candidacyId: string;
    workItemId?: string;
    changeCode:
      | "OWNER_ASSIGNED"
      | "OWNER_REASSIGNED"
      | "OWNER_RELEASED"
      | "DUE_DATE_SET"
      | "DUE_DATE_CLEARED";
    previousOwnerAccountId?: string;
    newOwnerAccountId?: string;
    previousDueAt?: Date | null;
    newDueAt?: Date | null;
    reasonCode?: string;
    actorAccountId: string;
    occurredAt: Date;
  }>,
): Promise<void> {
  await tx.insert(workResponsibilityHistory).values(values);
}

/** Newest first; bounded. Codes and instants, with the actor's display name. */
export async function listResponsibilityHistory(
  db: Executor,
  candidacyId: string,
  limit = 20,
) {
  return db
    .select({
      id: workResponsibilityHistory.id,
      changeCode: workResponsibilityHistory.changeCode,
      reasonCode: workResponsibilityHistory.reasonCode,
      occurredAt: workResponsibilityHistory.occurredAt,
      actorName: user.name,
    })
    .from(workResponsibilityHistory)
    .innerJoin(user, eq(user.id, workResponsibilityHistory.actorAccountId))
    .where(eq(workResponsibilityHistory.candidacyId, candidacyId))
    .orderBy(
      desc(workResponsibilityHistory.occurredAt),
      desc(workResponsibilityHistory.id),
    )
    .limit(limit);
}

export async function findAccountName(db: Executor, accountId: string) {
  const [row] = await db
    .select({ name: user.name })
    .from(user)
    .where(eq(user.id, accountId));
  return row?.name ?? null;
}

/** Branch and position names for one record's summary. */
export async function findPlacementLabels(
  db: Executor,
  branchId: string,
  positionId: string,
) {
  const [row] = await db
    .select({ branch: branch.name, position: position.internalTitle })
    .from(branch)
    .innerJoin(position, eq(position.id, positionId))
    .where(eq(branch.id, branchId));
  return row ?? null;
}

/** Whether the candidate has a correction open on this record. */
export async function hasActiveCorrection(
  db: Executor,
  candidacyId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: workItem.id })
    .from(workItem)
    .where(
      and(
        eq(workItem.candidacyId, candidacyId),
        eq(workItem.workTypeCode, "CORRECT_APPLICATION"),
        inArray(workItem.status, activeWorkStatuses),
      ),
    )
    .limit(1);
  return row !== undefined;
}

// ------------------------------------------------------ M3.3 prescreen, holds

/** Finishes whatever staff work is open on a candidacy. */
export async function completeOpenStaffWork(
  db: Executor,
  candidacyId: string,
  now: Date,
): Promise<void> {
  await db
    .update(workItem)
    .set({
      status: "COMPLETED",
      completedAt: now,
      version: sql`${workItem.version} + 1`,
      updatedAt: now,
    })
    .where(
      and(
        eq(workItem.candidacyId, candidacyId),
        eq(workItem.candidateActionRequired, false),
        inArray(workItem.status, activeWorkStatuses),
      ),
    );
}

export async function openPrescreenItem(
  db: Executor,
  candidacyId: string,
): Promise<void> {
  await db
    .insert(workItem)
    .values({
      candidacyId,
      workTypeCode: "COMPLETE_PRESCREEN",
      targetRecordType: "CANDIDACY",
      targetRecordId: candidacyId,
      candidateActionRequired: false,
      sourceCode: "CANDIDACY_TRANSITION",
    })
    .onConflictDoNothing();
}

export type HoldRow = typeof candidacyHold.$inferSelect;

export async function findActiveHold(
  db: Executor,
  candidacyId: string,
  lock: Lock = null,
): Promise<HoldRow | null> {
  const query = db
    .select()
    .from(candidacyHold)
    .where(
      and(
        eq(candidacyHold.candidacyId, candidacyId),
        eq(candidacyHold.status, "ACTIVE"),
      ),
    )
    .limit(1);
  const [row] = await (locked(query, lock) as typeof query);
  return row ?? null;
}

export async function insertHold(
  tx: Executor,
  values: Readonly<{
    candidacyId: string;
    categoryCode: string;
    internalReason: string;
    reviewAt: Date;
    placedByAccountId: string;
    placedAt: Date;
  }>,
): Promise<HoldRow> {
  const [row] = await tx.insert(candidacyHold).values(values).returning();
  return row!;
}

export async function removeHold(
  tx: Executor,
  id: string,
  expectedVersion: number,
  removedByAccountId: string,
  removalReasonCode: string,
  removedAt: Date,
): Promise<HoldRow | null> {
  const [row] = await tx
    .update(candidacyHold)
    .set({
      status: "REMOVED",
      removedByAccountId,
      removedAt,
      removalReasonCode,
      version: sql`${candidacyHold.version} + 1`,
    })
    .where(
      and(eq(candidacyHold.id, id), eq(candidacyHold.version, expectedVersion)),
    )
    .returning();
  return row ?? null;
}

/** Newest first; bounded. Codes and instants only, never the reason. */
export async function listHoldEvents(db: Executor, candidacyId: string) {
  return db
    .select({
      categoryCode: candidacyHold.categoryCode,
      placedAt: candidacyHold.placedAt,
      removedAt: candidacyHold.removedAt,
    })
    .from(candidacyHold)
    .where(eq(candidacyHold.candidacyId, candidacyId))
    .orderBy(desc(candidacyHold.placedAt), desc(candidacyHold.id))
    .limit(25);
}

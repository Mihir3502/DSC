import "server-only";
import { randomBytes } from "node:crypto";
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNotNull,
  ne,
  or,
  sql,
  type AnyColumn,
  type SQL,
} from "drizzle-orm";
import type { Database } from "@/shared/database";
import type { QueryConstraint } from "@/modules/identity-access/application/authorize";
import { constraintPredicate } from "@/modules/identity-access/infrastructure/scope-predicates";
import { referenceAlphabet } from "../domain/candidacy-policy";
import {
  candidacy,
  candidacyStageHistory,
  candidateCommandReceipt,
  duplicateCandidateMatch,
  person,
  personMergeRecord,
  workItem,
} from "./candidates-schema";

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
          WHERE w.candidacy_id = c.id AND w.work_type_code = 'COMPLETE_APPLICATION'
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
          AND w2.work_type_code = 'COMPLETE_APPLICATION'
          AND NOT (c.status = 'ACTIVE' AND c.current_stage = 'APPLICATION_INCOMPLETE')
        ORDER BY w2.id
        LIMIT ${limit})
  `);
  const count = (r: unknown) => (r as { rowCount?: number }).rowCount ?? 0;
  return { opened: count(opened), canceled: count(canceled) };
}

import "server-only";
import { randomBytes } from "node:crypto";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  isNull,
  or,
  sql,
  type AnyColumn,
  type SQL,
} from "drizzle-orm";
import type { Database } from "@/shared/database";
// Infrastructure-to-infrastructure imports only (type-only for the
// contract): identity-access composes this module's scope resolver, so
// importing its public index here would create an evaluation cycle.
import type { QueryConstraint } from "@/modules/identity-access/application/authorize";
import { constraintPredicate } from "@/modules/identity-access/infrastructure/scope-predicates";
import {
  publicReferenceAlphabet,
  type CycleStatus,
  type DescriptionStatus,
  type HierarchyStatus,
  type PositionStatus,
  type WorkerPaths,
} from "../domain/values";
import {
  branch,
  hiringCycle,
  jobDescriptionVersion,
  organization,
  organizationCommandReceipt,
  position,
  team,
} from "./organization-schema";

// Organization-module repository (packet M2.1 §21–§22). Every write is a
// narrow, named statement used by exactly one kind of command; there is no
// generic update, patch, or delete. Writes compare the expected version in
// SQL as well as in the command, so a lost race changes nothing.

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

/** 12 random Crockford base32 characters (60 bits) for public URLs. */
export function newPublicReference(): string {
  const bytes = randomBytes(12);
  let out = "";
  for (const byte of bytes) out += publicReferenceAlphabet[byte & 31];
  return out;
}

// ------------------------------------------------------------ rows

export type OrganizationRow = typeof organization.$inferSelect;
export type BranchRow = typeof branch.$inferSelect;
export type TeamRow = typeof team.$inferSelect;
export type PositionRow = typeof position.$inferSelect;
export type DescriptionRow = typeof jobDescriptionVersion.$inferSelect;
export type CycleRow = typeof hiringCycle.$inferSelect;

const stamp = (actorId: string, now: Date) => ({
  updatedAt: now,
  updatedByAccountId: actorId,
});

// --------------------------------------------------------- organization

export async function insertOrganization(
  tx: Executor,
  values: Readonly<{
    code: string;
    legalName: string;
    displayName: string;
    timezone: string;
  }>,
  actorId: string,
  now: Date,
): Promise<OrganizationRow> {
  const [row] = await tx
    .insert(organization)
    .values({
      ...values,
      createdAt: now,
      createdByAccountId: actorId,
      ...stamp(actorId, now),
    })
    .returning();
  return row!;
}

export async function findOrganization(
  tx: Executor,
  id: string,
  lock: Lock,
): Promise<OrganizationRow | null> {
  const rows = await locked(
    tx.select().from(organization).where(eq(organization.id, id)),
    lock,
  );
  return (rows as OrganizationRow[])[0] ?? null;
}

export async function updateOrganization(
  tx: Executor,
  id: string,
  expectedVersion: number,
  patch: Partial<
    Pick<
      OrganizationRow,
      | "code"
      | "legalName"
      | "displayName"
      | "timezone"
      | "status"
      | "activatedAt"
      | "inactivatedAt"
    >
  >,
  actorId: string,
  now: Date,
): Promise<OrganizationRow | null> {
  const [row] = await tx
    .update(organization)
    .set({
      ...patch,
      version: sql`${organization.version} + 1`,
      ...stamp(actorId, now),
    })
    .where(
      and(eq(organization.id, id), eq(organization.version, expectedVersion)),
    )
    .returning();
  return row ?? null;
}

// --------------------------------------------------------------- branch

export async function insertBranch(
  tx: Executor,
  values: Readonly<{
    organizationId: string;
    code: string;
    name: string;
    publicLocationLabel: string;
    timezone: string;
  }>,
  actorId: string,
  now: Date,
): Promise<BranchRow> {
  const [row] = await tx
    .insert(branch)
    .values({
      ...values,
      createdAt: now,
      createdByAccountId: actorId,
      ...stamp(actorId, now),
    })
    .returning();
  return row!;
}

export async function findBranch(
  tx: Executor,
  id: string,
  lock: Lock,
): Promise<BranchRow | null> {
  const rows = await locked(
    tx.select().from(branch).where(eq(branch.id, id)),
    lock,
  );
  return (rows as BranchRow[])[0] ?? null;
}

export async function updateBranch(
  tx: Executor,
  id: string,
  expectedVersion: number,
  patch: Partial<
    Pick<
      BranchRow,
      | "code"
      | "name"
      | "publicLocationLabel"
      | "timezone"
      | "status"
      | "activatedAt"
      | "inactivatedAt"
    >
  >,
  actorId: string,
  now: Date,
): Promise<BranchRow | null> {
  const [row] = await tx
    .update(branch)
    .set({
      ...patch,
      version: sql`${branch.version} + 1`,
      ...stamp(actorId, now),
    })
    .where(and(eq(branch.id, id), eq(branch.version, expectedVersion)))
    .returning();
  return row ?? null;
}

// ----------------------------------------------------------------- team

export async function insertTeam(
  tx: Executor,
  values: Readonly<{
    organizationId: string;
    branchId: string;
    code: string;
    name: string;
  }>,
  actorId: string,
  now: Date,
): Promise<TeamRow> {
  const [row] = await tx
    .insert(team)
    .values({
      ...values,
      createdAt: now,
      createdByAccountId: actorId,
      ...stamp(actorId, now),
    })
    .returning();
  return row!;
}

export async function findTeam(
  tx: Executor,
  id: string,
  lock: Lock,
): Promise<TeamRow | null> {
  const rows = await locked(
    tx.select().from(team).where(eq(team.id, id)),
    lock,
  );
  return (rows as TeamRow[])[0] ?? null;
}

export async function updateTeam(
  tx: Executor,
  id: string,
  expectedVersion: number,
  patch: Partial<
    Pick<TeamRow, "code" | "name" | "status" | "activatedAt" | "inactivatedAt">
  >,
  actorId: string,
  now: Date,
): Promise<TeamRow | null> {
  const [row] = await tx
    .update(team)
    .set({
      ...patch,
      version: sql`${team.version} + 1`,
      ...stamp(actorId, now),
    })
    .where(and(eq(team.id, id), eq(team.version, expectedVersion)))
    .returning();
  return row ?? null;
}

// ------------------------------------------------------------- position

export async function insertPosition(
  tx: Executor,
  values: Readonly<{
    organizationId: string;
    code: string;
    internalTitle: string;
    publicTitle: string;
    workerPathsAllowed: WorkerPaths;
  }>,
  actorId: string,
  now: Date,
): Promise<PositionRow> {
  const [row] = await tx
    .insert(position)
    .values({
      ...values,
      createdAt: now,
      createdByAccountId: actorId,
      ...stamp(actorId, now),
    })
    .returning();
  return row!;
}

export async function findPosition(
  tx: Executor,
  id: string,
  lock: Lock,
): Promise<PositionRow | null> {
  const rows = await locked(
    tx.select().from(position).where(eq(position.id, id)),
    lock,
  );
  return (rows as PositionRow[])[0] ?? null;
}

export async function updatePosition(
  tx: Executor,
  id: string,
  expectedVersion: number,
  patch: Partial<
    Pick<
      PositionRow,
      | "code"
      | "internalTitle"
      | "publicTitle"
      | "workerPathsAllowed"
      | "status"
      | "activatedAt"
      | "retiredAt"
    >
  >,
  actorId: string,
  now: Date,
): Promise<PositionRow | null> {
  const [row] = await tx
    .update(position)
    .set({
      ...patch,
      version: sql`${position.version} + 1`,
      ...stamp(actorId, now),
    })
    .where(and(eq(position.id, id), eq(position.version, expectedVersion)))
    .returning();
  return row ?? null;
}

// ------------------------------------------- job-description versions

/**
 * Inserts the next draft version. The caller holds the position row FOR
 * UPDATE, which serializes allocation; the unique (position, number)
 * constraint is the backstop.
 */
export async function insertDescriptionDraft(
  tx: Executor,
  values: Readonly<{
    organizationId: string;
    positionId: string;
    publicTitle: string;
    summary: string;
    body: string;
  }>,
  actorId: string,
  now: Date,
): Promise<DescriptionRow> {
  const [row] = await tx
    .insert(jobDescriptionVersion)
    .values({
      ...values,
      versionNumber: sql`(SELECT coalesce(max(${jobDescriptionVersion.versionNumber}), 0) + 1 FROM ${jobDescriptionVersion} WHERE ${jobDescriptionVersion.positionId} = ${values.positionId})`,
      createdAt: now,
      createdByAccountId: actorId,
      ...stamp(actorId, now),
    })
    .returning();
  return row!;
}

export async function findDescription(
  tx: Executor,
  id: string,
  lock: Lock,
): Promise<DescriptionRow | null> {
  const rows = await locked(
    tx
      .select()
      .from(jobDescriptionVersion)
      .where(eq(jobDescriptionVersion.id, id)),
    lock,
  );
  return (rows as DescriptionRow[])[0] ?? null;
}

export async function findDescriptionByStatus(
  tx: Executor,
  positionId: string,
  status: DescriptionStatus,
  lock: Lock,
): Promise<DescriptionRow | null> {
  const rows = await locked(
    tx
      .select()
      .from(jobDescriptionVersion)
      .where(
        and(
          eq(jobDescriptionVersion.positionId, positionId),
          eq(jobDescriptionVersion.status, status),
        ),
      ),
    lock,
  );
  return (rows as DescriptionRow[])[0] ?? null;
}

export async function updateDescriptionDraft(
  tx: Executor,
  id: string,
  expectedVersion: number,
  patch: Readonly<{ publicTitle: string; summary: string; body: string }>,
  actorId: string,
  now: Date,
): Promise<DescriptionRow | null> {
  const [row] = await tx
    .update(jobDescriptionVersion)
    .set({
      ...patch,
      version: sql`${jobDescriptionVersion.version} + 1`,
      ...stamp(actorId, now),
    })
    .where(
      and(
        eq(jobDescriptionVersion.id, id),
        eq(jobDescriptionVersion.status, "DRAFT"),
        eq(jobDescriptionVersion.version, expectedVersion),
      ),
    )
    .returning();
  return row ?? null;
}

export async function supersedeDescription(
  tx: Executor,
  id: string,
  actorId: string,
  now: Date,
): Promise<DescriptionRow | null> {
  const [row] = await tx
    .update(jobDescriptionVersion)
    .set({
      status: "SUPERSEDED",
      supersededAt: now,
      version: sql`${jobDescriptionVersion.version} + 1`,
      ...stamp(actorId, now),
    })
    .where(
      and(
        eq(jobDescriptionVersion.id, id),
        eq(jobDescriptionVersion.status, "PUBLISHED"),
      ),
    )
    .returning();
  return row ?? null;
}

export async function publishDescriptionDraft(
  tx: Executor,
  id: string,
  expectedVersion: number,
  actorId: string,
  now: Date,
): Promise<DescriptionRow | null> {
  const [row] = await tx
    .update(jobDescriptionVersion)
    .set({
      status: "PUBLISHED",
      publishedAt: now,
      publishedByAccountId: actorId,
      version: sql`${jobDescriptionVersion.version} + 1`,
      ...stamp(actorId, now),
    })
    .where(
      and(
        eq(jobDescriptionVersion.id, id),
        eq(jobDescriptionVersion.status, "DRAFT"),
        eq(jobDescriptionVersion.version, expectedVersion),
      ),
    )
    .returning();
  return row ?? null;
}

// ---------------------------------------------------------- hiring cycle

export async function insertCycle(
  tx: Executor,
  values: Readonly<{
    publicReference: string;
    organizationId: string;
    positionId: string;
    branchId: string;
    teamId: string | null;
    code: string;
    internalLabel: string;
    publicLabel: string | null;
    opensAt: Date;
    closesAt: Date | null;
    openEnded: boolean;
    displayTimezone: string;
  }>,
  actorId: string,
  now: Date,
): Promise<CycleRow> {
  const [row] = await tx
    .insert(hiringCycle)
    .values({
      ...values,
      createdAt: now,
      createdByAccountId: actorId,
      ...stamp(actorId, now),
    })
    .returning();
  return row!;
}

export async function findCycle(
  tx: Executor,
  id: string,
  lock: Lock,
): Promise<CycleRow | null> {
  const rows = await locked(
    tx.select().from(hiringCycle).where(eq(hiringCycle.id, id)),
    lock,
  );
  return (rows as CycleRow[])[0] ?? null;
}

export async function findCycleByReference(
  tx: Executor,
  publicReference: string,
): Promise<CycleRow | null> {
  const [row] = await tx
    .select()
    .from(hiringCycle)
    .where(eq(hiringCycle.publicReference, publicReference));
  return row ?? null;
}

export type CyclePatch = Partial<
  Pick<
    CycleRow,
    | "code"
    | "internalLabel"
    | "publicLabel"
    | "opensAt"
    | "closesAt"
    | "openEnded"
    | "status"
    | "jobDescriptionVersionId"
    | "workerPathsSnapshot"
    | "publicTitleSnapshot"
    | "locationLabelSnapshot"
    | "displayTimezone"
    | "publishedAt"
    | "publishedByAccountId"
    | "openedAt"
    | "openedByAccountId"
    | "closedAt"
    | "closedByAccountId"
    | "cancelledAt"
    | "cancelledByAccountId"
    | "archivedAt"
    | "archivedByAccountId"
    | "endReasonCode"
  >
>;

export async function updateCycle(
  tx: Executor,
  id: string,
  expectedVersion: number,
  patch: CyclePatch,
  actorId: string,
  now: Date,
): Promise<CycleRow | null> {
  const [row] = await tx
    .update(hiringCycle)
    .set({
      ...patch,
      version: sql`${hiringCycle.version} + 1`,
      ...stamp(actorId, now),
    })
    .where(
      and(eq(hiringCycle.id, id), eq(hiringCycle.version, expectedVersion)),
    )
    .returning();
  return row ?? null;
}

// -------------------------------------------------------------- receipts

export type Receipt = Readonly<{
  commandName: string;
  targetId: string;
  resultVersion: number;
}>;

export async function findReceipt(
  tx: Executor,
  actorAccountId: string,
  commandKey: string,
): Promise<Receipt | null> {
  const [row] = await tx
    .select({
      commandName: organizationCommandReceipt.commandName,
      targetId: organizationCommandReceipt.targetId,
      resultVersion: organizationCommandReceipt.resultVersion,
    })
    .from(organizationCommandReceipt)
    .where(
      and(
        eq(organizationCommandReceipt.actorAccountId, actorAccountId),
        eq(organizationCommandReceipt.commandKey, commandKey),
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
    targetId: string;
    resultVersion: number;
  }>,
): Promise<void> {
  await tx.insert(organizationCommandReceipt).values(values);
}

// ------------------------------------------------- hierarchy for scopes

export type ScopeEntity =
  | Readonly<{
      type: "ORGANIZATION";
      id: string;
      active: boolean;
    }>
  | Readonly<{
      type: "BRANCH";
      id: string;
      organizationId: string;
      active: boolean;
    }>
  | Readonly<{
      type: "TEAM";
      id: string;
      organizationId: string;
      branchId: string;
      active: boolean;
    }>;

/**
 * The hierarchy entity with this ID and whether it and every ancestor is
 * ACTIVE. IDs are UUIDs, so one ID identifies at most one entity.
 */
export async function findScopeEntity(
  db: Executor,
  id: string,
): Promise<ScopeEntity | null> {
  const [org] = await db
    .select({ status: organization.status })
    .from(organization)
    .where(eq(organization.id, id));
  if (org) {
    return { type: "ORGANIZATION", id, active: org.status === "ACTIVE" };
  }
  const [br] = await db
    .select({
      organizationId: branch.organizationId,
      status: branch.status,
      orgStatus: organization.status,
    })
    .from(branch)
    .innerJoin(organization, eq(organization.id, branch.organizationId))
    .where(eq(branch.id, id));
  if (br) {
    return {
      type: "BRANCH",
      id,
      organizationId: br.organizationId,
      active: br.status === "ACTIVE" && br.orgStatus === "ACTIVE",
    };
  }
  const [tm] = await db
    .select({
      organizationId: team.organizationId,
      branchId: team.branchId,
      status: team.status,
      branchStatus: branch.status,
      orgStatus: organization.status,
    })
    .from(team)
    .innerJoin(branch, eq(branch.id, team.branchId))
    .innerJoin(organization, eq(organization.id, team.organizationId))
    .where(eq(team.id, id));
  if (tm) {
    return {
      type: "TEAM",
      id,
      organizationId: tm.organizationId,
      branchId: tm.branchId,
      active:
        tm.status === "ACTIVE" &&
        tm.branchStatus === "ACTIVE" &&
        tm.orgStatus === "ACTIVE",
    };
  }
  return null;
}

export type Placement = Readonly<{
  organizationId: string;
  branchId: string | null;
  teamId: string | null;
  recordedAt: Date;
}>;

/** Where an organization-module record sits (historical rows included). */
export async function findPlacement(
  db: Executor,
  id: string,
): Promise<Placement | null> {
  const queries: (() => Promise<Placement | undefined>)[] = [
    async () =>
      (
        await db
          .select({
            organizationId: hiringCycle.organizationId,
            branchId: hiringCycle.branchId,
            teamId: hiringCycle.teamId,
            recordedAt: hiringCycle.createdAt,
          })
          .from(hiringCycle)
          .where(eq(hiringCycle.id, id))
      )[0],
    async () =>
      (
        await db
          .select({
            organizationId: position.organizationId,
            branchId: sql<null>`NULL::uuid`,
            teamId: sql<null>`NULL::uuid`,
            recordedAt: position.createdAt,
          })
          .from(position)
          .where(eq(position.id, id))
      )[0],
    async () =>
      (
        await db
          .select({
            organizationId: jobDescriptionVersion.organizationId,
            branchId: sql<null>`NULL::uuid`,
            teamId: sql<null>`NULL::uuid`,
            recordedAt: jobDescriptionVersion.createdAt,
          })
          .from(jobDescriptionVersion)
          .where(eq(jobDescriptionVersion.id, id))
      )[0],
    async () =>
      (
        await db
          .select({
            organizationId: team.organizationId,
            branchId: team.branchId,
            teamId: team.id,
            recordedAt: team.createdAt,
          })
          .from(team)
          .where(eq(team.id, id))
      )[0],
    async () =>
      (
        await db
          .select({
            organizationId: branch.organizationId,
            branchId: branch.id,
            teamId: sql<null>`NULL::uuid`,
            recordedAt: branch.createdAt,
          })
          .from(branch)
          .where(eq(branch.id, id))
      )[0],
    async () =>
      (
        await db
          .select({
            organizationId: organization.id,
            branchId: sql<null>`NULL::uuid`,
            teamId: sql<null>`NULL::uuid`,
            recordedAt: organization.createdAt,
          })
          .from(organization)
          .where(eq(organization.id, id))
      )[0],
  ];
  for (const query of queries) {
    const found = await query();
    if (found) return found;
  }
  return null;
}

// ------------------------------------------------- staff read models

/** No organization-module row is any account's own candidate file. */
const noSubject = sql`NULL::uuid` as unknown as AnyColumn;

const positionScope = (constraint: QueryConstraint): SQL =>
  constraintPredicate(constraint, {
    organizationId: position.organizationId,
    branchId: sql`NULL::uuid` as unknown as AnyColumn,
    teamId: sql`NULL::uuid` as unknown as AnyColumn,
    subjectAccountId: noSubject,
  });

export type PositionListRow = Readonly<{
  id: string;
  code: string;
  internalTitle: string;
  publicTitle: string;
  workerPathsAllowed: WorkerPaths;
  status: PositionStatus;
  version: number;
}>;

/** Positions inside the authorized constraint, stable order, keyset page. */
export async function listPositionsInScope(
  db: Executor,
  constraint: QueryConstraint,
  query: Readonly<{
    pageSize: number;
    afterCode: string | null;
    status: PositionStatus | null;
  }>,
): Promise<readonly PositionListRow[]> {
  const rows = await db
    .select({
      id: position.id,
      code: position.code,
      internalTitle: position.internalTitle,
      publicTitle: position.publicTitle,
      workerPathsAllowed: position.workerPathsAllowed,
      status: position.status,
      version: position.version,
    })
    .from(position)
    .where(
      and(
        positionScope(constraint),
        query.status ? eq(position.status, query.status) : undefined,
        query.afterCode ? gt(position.code, query.afterCode) : undefined,
      ),
    )
    .orderBy(asc(position.code), asc(position.id))
    .limit(query.pageSize);
  return rows as PositionListRow[];
}

export async function listDescriptions(
  db: Executor,
  positionId: string,
): Promise<readonly DescriptionRow[]> {
  return db
    .select()
    .from(jobDescriptionVersion)
    .where(eq(jobDescriptionVersion.positionId, positionId))
    .orderBy(desc(jobDescriptionVersion.versionNumber))
    .limit(100);
}

/** A position's cycles inside the authorized constraint. */
export async function listCyclesInScope(
  db: Executor,
  positionId: string,
  constraint: QueryConstraint,
): Promise<readonly CycleRow[]> {
  return db
    .select()
    .from(hiringCycle)
    .where(
      and(
        eq(hiringCycle.positionId, positionId),
        constraintPredicate(constraint, {
          organizationId: hiringCycle.organizationId,
          branchId: hiringCycle.branchId,
          teamId: hiringCycle.teamId,
          subjectAccountId: noSubject,
        }),
      ),
    )
    .orderBy(desc(hiringCycle.opensAt), asc(hiringCycle.id))
    .limit(100);
}

export type HierarchyRows = Readonly<{
  organizations: readonly OrganizationRow[];
  branches: readonly BranchRow[];
  teams: readonly TeamRow[];
}>;

/** Organizations, branches, and teams inside the authorized constraint. */
export async function listHierarchyInScope(
  db: Executor,
  constraint: QueryConstraint,
): Promise<HierarchyRows> {
  const organizations = await db
    .select()
    .from(organization)
    .where(
      constraintPredicate(constraint, {
        organizationId: organization.id,
        branchId: sql`NULL::uuid` as unknown as AnyColumn,
        teamId: sql`NULL::uuid` as unknown as AnyColumn,
        subjectAccountId: noSubject,
      }),
    )
    .orderBy(asc(organization.code))
    .limit(50);
  const branches = await db
    .select()
    .from(branch)
    .where(
      constraintPredicate(constraint, {
        organizationId: branch.organizationId,
        branchId: branch.id,
        teamId: sql`NULL::uuid` as unknown as AnyColumn,
        subjectAccountId: noSubject,
      }),
    )
    .orderBy(asc(branch.code), asc(branch.id))
    .limit(200);
  const teams = await db
    .select()
    .from(team)
    .where(
      constraintPredicate(constraint, {
        organizationId: team.organizationId,
        branchId: team.branchId,
        teamId: team.id,
        subjectAccountId: noSubject,
      }),
    )
    .orderBy(asc(team.code), asc(team.id))
    .limit(500);
  return { organizations, branches, teams };
}

/** Active branches and teams of an organization (cycle placement form). */
export async function listActivePlacements(
  db: Executor,
  organizationId: string,
): Promise<
  Readonly<{ branches: readonly BranchRow[]; teams: readonly TeamRow[] }>
> {
  const branches = await db
    .select()
    .from(branch)
    .where(
      and(
        eq(branch.organizationId, organizationId),
        eq(branch.status, "ACTIVE"),
      ),
    )
    .orderBy(asc(branch.code))
    .limit(200);
  const teams = branches.length
    ? await db
        .select()
        .from(team)
        .where(
          and(
            inArray(
              team.branchId,
              branches.map((b) => b.id),
            ),
            eq(team.status, "ACTIVE"),
          ),
        )
        .orderBy(asc(team.code))
        .limit(500)
    : [];
  return { branches, teams };
}

// ---------------------------------------------- public read models

export type PublicCycleSource = Readonly<{
  publicReference: string;
  status: CycleStatus;
  opensAt: Date;
  closesAt: Date | null;
  openedAt: Date | null;
  displayTimezone: string;
  publicTitle: string;
  locationLabel: string;
  workerPaths: WorkerPaths;
  summary: string;
  body: string;
  parentsActive: boolean;
}>;

const publicColumns = {
  publicReference: hiringCycle.publicReference,
  status: hiringCycle.status,
  opensAt: hiringCycle.opensAt,
  closesAt: hiringCycle.closesAt,
  openedAt: hiringCycle.openedAt,
  displayTimezone: hiringCycle.displayTimezone,
  publicTitle: sql<string>`coalesce(${hiringCycle.publicLabel}, ${hiringCycle.publicTitleSnapshot})`,
  locationLabel: sql<string>`${hiringCycle.locationLabelSnapshot}`,
  workerPaths: sql<WorkerPaths>`${hiringCycle.workerPathsSnapshot}`,
  summary: jobDescriptionVersion.summary,
  body: jobDescriptionVersion.body,
  parentsActive: sql<boolean>`(${organization.status} = 'ACTIVE' AND ${branch.status} = 'ACTIVE' AND ${position.status} = 'ACTIVE' AND (${hiringCycle.teamId} IS NULL OR ${team.status} = 'ACTIVE'))`,
};

function publicBase(db: Executor) {
  return db
    .select(publicColumns)
    .from(hiringCycle)
    .innerJoin(
      jobDescriptionVersion,
      eq(jobDescriptionVersion.id, hiringCycle.jobDescriptionVersionId),
    )
    .innerJoin(organization, eq(organization.id, hiringCycle.organizationId))
    .innerJoin(branch, eq(branch.id, hiringCycle.branchId))
    .innerJoin(position, eq(position.id, hiringCycle.positionId))
    .leftJoin(team, eq(team.id, hiringCycle.teamId));
}

export type PublicListQuery = Readonly<{
  now: Date;
  pageSize: number;
  page: number;
  workerPaths: WorkerPaths | null;
  location: string | null;
}>;

/**
 * Currently accepting cycles only: OPEN, inside the inclusive/exclusive
 * window at the trusted instant, with every parent ACTIVE. Stable order:
 * closing soonest (open-ended last), then title, then reference.
 */
export async function listPublicCycles(
  db: Executor,
  query: PublicListQuery,
): Promise<readonly PublicCycleSource[]> {
  const rows = await publicBase(db)
    .where(
      and(
        eq(hiringCycle.status, "OPEN"),
        sql`${hiringCycle.opensAt} <= ${query.now}`,
        or(isNull(hiringCycle.closesAt), gt(hiringCycle.closesAt, query.now)),
        eq(organization.status, "ACTIVE"),
        eq(branch.status, "ACTIVE"),
        eq(position.status, "ACTIVE"),
        or(isNull(hiringCycle.teamId), eq(team.status, "ACTIVE")),
        query.workerPaths
          ? eq(hiringCycle.workerPathsSnapshot, query.workerPaths)
          : undefined,
        query.location
          ? eq(hiringCycle.locationLabelSnapshot, query.location)
          : undefined,
      ),
    )
    .orderBy(
      sql`${hiringCycle.closesAt} ASC NULLS LAST`,
      asc(
        sql`coalesce(${hiringCycle.publicLabel}, ${hiringCycle.publicTitleSnapshot})`,
      ),
      asc(hiringCycle.publicReference),
    )
    .limit(query.pageSize + 1)
    .offset((query.page - 1) * query.pageSize);
  return rows as PublicCycleSource[];
}

/** Distinct public location labels of currently accepting cycles. */
export async function listPublicLocations(
  db: Executor,
  now: Date,
): Promise<readonly string[]> {
  const rows = await db
    .selectDistinct({ label: hiringCycle.locationLabelSnapshot })
    .from(hiringCycle)
    .innerJoin(organization, eq(organization.id, hiringCycle.organizationId))
    .innerJoin(branch, eq(branch.id, hiringCycle.branchId))
    .innerJoin(position, eq(position.id, hiringCycle.positionId))
    .leftJoin(team, eq(team.id, hiringCycle.teamId))
    .where(
      and(
        eq(hiringCycle.status, "OPEN"),
        sql`${hiringCycle.opensAt} <= ${now}`,
        or(isNull(hiringCycle.closesAt), gt(hiringCycle.closesAt, now)),
        eq(organization.status, "ACTIVE"),
        eq(branch.status, "ACTIVE"),
        eq(position.status, "ACTIVE"),
        or(isNull(hiringCycle.teamId), eq(team.status, "ACTIVE")),
      ),
    )
    .orderBy(asc(hiringCycle.locationLabelSnapshot))
    .limit(100);
  return rows.map((r) => r.label).filter((l): l is string => l !== null);
}

/**
 * One cycle's public source by reference, or null when it was never
 * published (no snapshot). The caller decides public availability.
 */
export async function findPublicCycle(
  db: Executor,
  publicReference: string,
): Promise<PublicCycleSource | null> {
  const [row] = await publicBase(db).where(
    eq(hiringCycle.publicReference, publicReference),
  );
  return (row as PublicCycleSource | undefined) ?? null;
}

export function isActive(status: HierarchyStatus | PositionStatus): boolean {
  return status === "ACTIVE";
}

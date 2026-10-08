import "server-only";
import {
  authorize,
  authorizeQueryScope,
  authorizeScopedList,
  correlationOf,
  project,
  resolveCurrentStaff,
  type AuthorizationDependencies,
  type AuthorizationRequest,
  type ListQuerySpec,
  type Principal,
  type ProjectionContract,
  type QueryConstraint,
} from "@/modules/identity-access";
import {
  positionStatuses,
  isUuid,
  type CycleStatus,
  type HierarchyStatus,
} from "../domain/values";
import { formatInZone, toZonedLocal } from "../domain/zoned-time";
import {
  findBranch,
  findCycle,
  findDescription,
  findOrganization,
  findPosition,
  findTeam,
  listActivePlacements,
  listCyclesInScope,
  listDescriptions,
  listHierarchyInScope,
  listPositionsInScope,
  type Executor,
  type PositionListRow,
} from "../infrastructure/organization-repository";
import {
  configurationDependencies,
  type ConfigurationDependencies,
} from "./configuration-runtime";
import {
  cycleDetailContract,
  cycleFormContract,
  descriptionDetailContract,
  hierarchyContract,
  positionDetailContract,
  positionFormContract,
  positionListContract,
  type CycleDetailView,
  type HierarchyView,
  type PositionDetailView,
  type PositionSummaryView,
} from "../presentation/staff-views";

// Staff configuration queries (packet M2.1 §16, §23). Each query resolves
// the MFA-complete staff principal on the server, authorizes the read
// through the M1 service (lists apply the scope constraint in SQL and
// recheck every row), and returns one exact projection. Unknown,
// out-of-scope, malformed, and denied references are one NOT_FOUND.
//
// "actions" lists the configuration commands the principal's grants
// permit on the record (a step-up may still be required). It is a UI
// hint only: every command authorizes again inside its transaction.

export type StaffQueryResult<V> =
  | Readonly<{ kind: "OK"; view: V }>
  | Readonly<{ kind: "UNAUTHENTICATED" | "NOT_FOUND" }>;

const silent: AuthorizationDependencies["events"] = {
  record: async () => true,
  recordInTransaction: async () => {},
};

type Resource = AuthorizationRequest["resource"];

const principalOf = (principal: Principal) => ({
  accountId: principal.accountId,
  accountType: principal.accountType,
  sessionId: principal.sessionId,
});

function request(
  principal: Principal,
  permission: string,
  resource: Resource,
  correlationId: string | undefined,
): AuthorizationRequest {
  return {
    principal: principalOf(principal),
    permission,
    operation: permission.endsWith(".read") ? "READ" : "CONFIGURE",
    resource,
    reasonCode: "ROUTINE_CONFIGURATION",
    ...(correlationId ? { correlationId } : {}),
  };
}

async function allows(
  principal: Principal,
  permission: string,
  resource: Resource,
  deps: AuthorizationDependencies,
  correlationId: string | undefined,
): Promise<boolean> {
  const decision = await authorize(
    request(principal, permission, resource, correlationId),
    deps,
  );
  return decision.decision === "ALLOW";
}

/** Commands the grants permit on a resource (step-up may still be needed). */
async function permittedActions(
  principal: Principal,
  permissions: readonly string[],
  resource: Resource,
  deps: AuthorizationDependencies,
): Promise<string[]> {
  const probeDeps = { ...deps, events: silent };
  const actions: string[] = [];
  for (const permission of permissions) {
    const decision = await authorize(
      request(principal, permission, resource, undefined),
      probeDeps,
    );
    if (
      decision.decision === "ALLOW" ||
      decision.reasonCode === "RECENT_AUTH_REQUIRED"
    ) {
      actions.push(permission.replace(".", "_"));
    }
  }
  return actions;
}

function render<V extends object>(
  contract: ProjectionContract<V, V>,
  view: V,
  allowed: readonly string[],
  deps: AuthorizationDependencies,
): StaffQueryResult<V> {
  const projected = project(contract, view, {
    audience: "STAFF",
    purpose: contract.purpose,
    allowed: new Set(allowed),
  });
  if (projected.kind !== "PROJECTED") {
    deps.logger.error("authz.projection_refused", {
      module: "organization",
      action: contract.name,
      reasonCode: projected.reason,
    });
    return { kind: "NOT_FOUND" };
  }
  return { kind: "OK", view: projected.value };
}

type QueryContext = Readonly<{
  principal: Principal;
  deps: ConfigurationDependencies;
  correlationId: string | undefined;
}>;

async function staffContext(
  headers: Headers,
  deps: ConfigurationDependencies,
): Promise<QueryContext | null> {
  const principal = await resolveCurrentStaff(headers);
  return principal
    ? { principal, deps, correlationId: correlationOf(headers) }
    : null;
}

const db = (deps: ConfigurationDependencies) => deps.db as unknown as Executor;

const iso = (d: Date | null) => (d ? d.toISOString() : null);

function windowText(
  opensAt: Date,
  closesAt: Date | null,
  timeZone: string,
): string {
  const opens = `Opens ${formatInZone(opensAt, timeZone)} (inclusive)`;
  return closesAt
    ? `${opens} · Closes ${formatInZone(closesAt, timeZone)} (exclusive)`
    : `${opens} · No closing date (open-ended)`;
}

const workerPathLabels: Readonly<Record<string, string>> = {
  W2_ONLY: "W-2 employee only",
  CONTRACTOR_ELIGIBLE_ONLY: "Eligible for a reviewed 1099 contractor path only",
  W2_AND_CONTRACTOR_ELIGIBLE:
    "W-2 employee, or eligible for a reviewed 1099 contractor path",
};

// ------------------------------------------------------------ positions

const positionListSpec: ListQuerySpec = {
  maxPageSize: 50,
  defaultPageSize: 25,
  sorts: ["code"],
  defaultSort: "code",
  filters: {
    status: (v) =>
      typeof v === "string" &&
      (positionStatuses as readonly string[]).includes(v),
  },
  maxSearchLength: 0,
};

const toSummary = (row: PositionListRow): PositionSummaryView => ({
  id: row.id,
  code: row.code,
  internalTitle: row.internalTitle,
  publicTitle: row.publicTitle,
  workerPaths: row.workerPathsAllowed,
  status: row.status,
  version: row.version,
});

export async function queryPositionList(
  headers: Headers,
  input: Readonly<{ status?: string; after?: string }>,
  deps: ConfigurationDependencies = configurationDependencies(),
) {
  const ctx = await staffContext(headers, deps);
  if (!ctx) return { kind: "UNAUTHENTICATED" } as const;
  const listInput = {
    ...(input.status ? { filters: { status: input.status } } : {}),
    ...(input.after ? { cursor: input.after } : {}),
  };
  const listed = await authorizeScopedList(
    {
      principal: ctx.principal,
      permission: "position.read",
      sensitivity: "INTERNAL",
      input: listInput,
      ...(ctx.correlationId ? { correlationId: ctx.correlationId } : {}),
    },
    {
      async list(constraint, query) {
        const rows = await listPositionsInScope(db(deps), constraint, {
          pageSize: query.pageSize + 1,
          afterCode: query.cursor,
          status: (query.filters.status ?? null) as never,
        });
        const page = rows.slice(0, query.pageSize);
        return {
          rows: page.map((r) => ({ ...r, sensitivity: "INTERNAL" as const })),
          nextCursor:
            rows.length > query.pageSize ? page[page.length - 1]!.code : null,
        };
      },
    },
    positionListSpec,
    deps,
  );
  if (listed.kind !== "LISTED") return { kind: "NOT_FOUND" } as const;
  // position.create is a configuration permission: probe it per
  // organization scope (never through the read-only query path).
  const readScope = await organizationReadScope(ctx);
  const canCreate =
    readScope.decision === "ALLOW" &&
    (await creatableOrganizations(ctx, readScope.constraint)).length > 0;
  return render(
    positionListContract,
    {
      items: listed.rows.map((r) => toSummary(r as unknown as PositionListRow)),
      nextCursor: listed.nextCursor,
      canCreate,
    },
    ["position.read"],
    deps,
  );
}

/** The principal's organization.read scope (null when denied). */
function organizationReadScope(ctx: QueryContext) {
  return authorizeQueryScope(
    {
      principal: principalOf(ctx.principal),
      permission: "organization.read",
      operation: "READ",
      sensitivity: "INTERNAL",
    },
    { ...ctx.deps, events: silent },
  );
}

/**
 * ACTIVE organizations inside an authorized read constraint where the
 * principal may also create positions (probed per organization scope).
 */
async function creatableOrganizations(
  ctx: QueryContext,
  constraint: QueryConstraint,
) {
  const { organizations } = await listHierarchyInScope(
    db(ctx.deps),
    constraint,
  );
  const usable = [];
  for (const org of organizations) {
    if (org.status !== "ACTIVE") continue;
    if (
      await allows(
        ctx.principal,
        "position.create",
        {
          kind: "SCOPE",
          scopeType: "ORGANIZATION",
          id: org.id,
          sensitivity: "INTERNAL",
        },
        { ...ctx.deps, events: silent },
        ctx.correlationId,
      )
    ) {
      usable.push({ id: org.id, code: org.code, name: org.displayName });
    }
  }
  return usable;
}

export async function queryPositionForm(
  headers: Headers,
  deps: ConfigurationDependencies = configurationDependencies(),
) {
  const ctx = await staffContext(headers, deps);
  if (!ctx) return { kind: "UNAUTHENTICATED" } as const;
  const scope = await authorizeQueryScope(
    {
      principal: principalOf(ctx.principal),
      permission: "organization.read",
      operation: "READ",
      sensitivity: "INTERNAL",
    },
    deps,
  );
  if (scope.decision !== "ALLOW") return { kind: "NOT_FOUND" } as const;
  const usable = await creatableOrganizations(ctx, scope.constraint);
  if (usable.length === 0) return { kind: "NOT_FOUND" } as const;
  return render(
    positionFormContract,
    { organizations: usable },
    ["position.create"],
    deps,
  );
}

export async function queryPositionDetail(
  headers: Headers,
  positionId: string,
  deps: ConfigurationDependencies = configurationDependencies(),
): Promise<StaffQueryResult<PositionDetailView>> {
  const ctx = await staffContext(headers, deps);
  if (!ctx) return { kind: "UNAUTHENTICATED" };
  if (!isUuid(positionId)) return { kind: "NOT_FOUND" };
  const record: Resource = {
    kind: "RECORD",
    id: positionId,
    sensitivity: "INTERNAL",
  };
  if (
    !(await allows(
      ctx.principal,
      "position.read",
      record,
      deps,
      ctx.correlationId,
    ))
  ) {
    return { kind: "NOT_FOUND" };
  }
  const row = await findPosition(db(deps), positionId, null);
  if (!row) return { kind: "NOT_FOUND" };
  const org = await findOrganization(db(deps), row.organizationId, null);
  const canReadDescriptions = await allows(
    ctx.principal,
    "job_description.read",
    record,
    { ...deps, events: silent },
    ctx.correlationId,
  );
  const descriptions = canReadDescriptions
    ? await listDescriptions(db(deps), positionId)
    : [];
  const cycleScope = await authorizeQueryScope(
    {
      principal: principalOf(ctx.principal),
      permission: "hiring_cycle.read",
      operation: "READ",
      sensitivity: "INTERNAL",
    },
    { ...deps, events: silent },
  );
  const cycles =
    cycleScope.decision === "ALLOW"
      ? await listCyclesInScope(db(deps), positionId, cycleScope.constraint)
      : [];
  const placements = new Map<string, string>();
  for (const cycle of cycles) {
    const branch = await findBranch(db(deps), cycle.branchId, null);
    const team = cycle.teamId
      ? await findTeam(db(deps), cycle.teamId, null)
      : null;
    placements.set(
      cycle.id,
      team ? `${branch?.name ?? ""} · ${team.name}` : (branch?.name ?? ""),
    );
  }
  const actions = await permittedActions(
    ctx.principal,
    [
      "position.edit",
      "position.activate",
      "position.retire",
      "job_description.edit",
    ],
    record,
    deps,
  );
  return render(
    positionDetailContract,
    {
      position: toSummary(row as unknown as PositionListRow),
      organizationName: org?.displayName ?? "",
      descriptions: descriptions.map((d) => ({
        id: d.id,
        versionNumber: d.versionNumber,
        publicTitle: d.publicTitle,
        status: d.status as never,
        publishedAt: iso(d.publishedAt),
      })),
      cycles: cycles.map((c) => ({
        id: c.id,
        code: c.code,
        internalLabel: c.internalLabel,
        status: c.status as CycleStatus,
        window: windowText(c.opensAt, c.closesAt, c.displayTimezone),
        placement: placements.get(c.id) ?? "",
      })),
      actions,
    },
    ["position.read"],
    deps,
  );
}

// ------------------------------------------------- job-description version

export async function queryDescriptionDetail(
  headers: Headers,
  positionId: string,
  descriptionId: string,
  deps: ConfigurationDependencies = configurationDependencies(),
) {
  const ctx = await staffContext(headers, deps);
  if (!ctx) return { kind: "UNAUTHENTICATED" } as const;
  if (!isUuid(positionId) || !isUuid(descriptionId))
    return { kind: "NOT_FOUND" } as const;
  const record: Resource = {
    kind: "RECORD",
    id: descriptionId,
    sensitivity: "INTERNAL",
  };
  if (
    !(await allows(
      ctx.principal,
      "job_description.read",
      record,
      deps,
      ctx.correlationId,
    ))
  ) {
    return { kind: "NOT_FOUND" } as const;
  }
  const row = await findDescription(db(deps), descriptionId, null);
  if (!row || row.positionId !== positionId)
    return { kind: "NOT_FOUND" } as const;
  const position = await findPosition(db(deps), positionId, null);
  const actions = await permittedActions(
    ctx.principal,
    ["job_description.edit", "job_description.publish"],
    record,
    deps,
  );
  return render(
    descriptionDetailContract,
    {
      id: row.id,
      positionId,
      positionTitle: position?.internalTitle ?? "",
      versionNumber: row.versionNumber,
      publicTitle: row.publicTitle,
      summary: row.summary,
      body: row.body,
      status: row.status as never,
      publishedAt: iso(row.publishedAt),
      version: row.version,
      actions,
    },
    ["job_description.read"],
    deps,
  );
}

// ------------------------------------------------------------ hiring cycle

export async function queryCycleDetail(
  headers: Headers,
  positionId: string,
  cycleId: string,
  deps: ConfigurationDependencies = configurationDependencies(),
): Promise<StaffQueryResult<CycleDetailView>> {
  const ctx = await staffContext(headers, deps);
  if (!ctx) return { kind: "UNAUTHENTICATED" };
  if (!isUuid(positionId) || !isUuid(cycleId)) return { kind: "NOT_FOUND" };
  const record: Resource = {
    kind: "RECORD",
    id: cycleId,
    sensitivity: "INTERNAL",
  };
  if (
    !(await allows(
      ctx.principal,
      "hiring_cycle.read",
      record,
      deps,
      ctx.correlationId,
    ))
  ) {
    return { kind: "NOT_FOUND" };
  }
  const row = await findCycle(db(deps), cycleId, null);
  if (!row || row.positionId !== positionId) return { kind: "NOT_FOUND" };
  const [position, branch, team, description] = await Promise.all([
    findPosition(db(deps), positionId, null),
    findBranch(db(deps), row.branchId, null),
    row.teamId ? findTeam(db(deps), row.teamId, null) : Promise.resolve(null),
    row.jobDescriptionVersionId
      ? findDescription(db(deps), row.jobDescriptionVersionId, null)
      : Promise.resolve(null),
  ]);
  const actions = await permittedActions(
    ctx.principal,
    [
      "hiring_cycle.edit",
      "hiring_cycle.publish",
      "hiring_cycle.open",
      "hiring_cycle.close",
      "hiring_cycle.cancel",
      "hiring_cycle.archive",
    ],
    record,
    deps,
  );
  const tz = row.displayTimezone;
  return render(
    cycleDetailContract,
    {
      id: row.id,
      positionId,
      positionTitle: position?.internalTitle ?? "",
      publicReference: row.publicReference,
      code: row.code,
      internalLabel: row.internalLabel,
      publicLabel: row.publicLabel,
      status: row.status as CycleStatus,
      branchName: branch?.name ?? "",
      teamName: team?.name ?? null,
      timezone: tz,
      opensAt: formatInZone(row.opensAt, tz),
      closesAt: row.closesAt ? formatInZone(row.closesAt, tz) : null,
      opensAtLocal: toZonedLocal(row.opensAt, tz),
      closesAtLocal: row.closesAt ? toZonedLocal(row.closesAt, tz) : null,
      openEnded: row.openEnded,
      snapshot:
        row.publishedAt && description
          ? {
              descriptionVersion: description.versionNumber,
              publicTitle: row.publicTitleSnapshot ?? "",
              locationLabel: row.locationLabelSnapshot ?? "",
              workerPaths:
                workerPathLabels[row.workerPathsSnapshot ?? ""] ?? "",
              publishedAt: formatInZone(row.publishedAt, tz),
            }
          : null,
      endReason: row.endReasonCode,
      version: row.version,
      actions,
    },
    ["hiring_cycle.read"],
    deps,
  );
}

export async function queryCycleForm(
  headers: Headers,
  positionId: string,
  deps: ConfigurationDependencies = configurationDependencies(),
) {
  const ctx = await staffContext(headers, deps);
  if (!ctx) return { kind: "UNAUTHENTICATED" } as const;
  if (!isUuid(positionId)) return { kind: "NOT_FOUND" } as const;
  const record: Resource = {
    kind: "RECORD",
    id: positionId,
    sensitivity: "INTERNAL",
  };
  if (
    !(await allows(
      ctx.principal,
      "position.read",
      record,
      deps,
      ctx.correlationId,
    ))
  ) {
    return { kind: "NOT_FOUND" } as const;
  }
  const position = await findPosition(db(deps), positionId, null);
  if (!position || position.status !== "ACTIVE")
    return { kind: "NOT_FOUND" } as const;
  const { branches, teams } = await listActivePlacements(
    db(deps),
    position.organizationId,
  );
  const probe = { ...deps, events: silent };
  const options = [];
  for (const branch of branches) {
    const branchAllowed = await allows(
      ctx.principal,
      "hiring_cycle.create",
      {
        kind: "SCOPE",
        scopeType: "BRANCH",
        id: branch.id,
        sensitivity: "INTERNAL",
      },
      probe,
      undefined,
    );
    const branchTeams = [];
    for (const team of teams.filter((t) => t.branchId === branch.id)) {
      if (
        await allows(
          ctx.principal,
          "hiring_cycle.create",
          {
            kind: "SCOPE",
            scopeType: "TEAM",
            id: team.id,
            sensitivity: "INTERNAL",
          },
          probe,
          undefined,
        )
      ) {
        branchTeams.push({ id: team.id, code: team.code, name: team.name });
      }
    }
    if (branchAllowed || branchTeams.length > 0) {
      options.push({
        id: branch.id,
        code: branch.code,
        name: branch.name,
        timezone: branch.timezone,
        teams: branchTeams,
      });
    }
  }
  if (options.length === 0) return { kind: "NOT_FOUND" } as const;
  return render(
    cycleFormContract,
    { positionId, positionTitle: position.internalTitle, branches: options },
    ["position.read"],
    deps,
  );
}

// --------------------------------------------------------------- hierarchy

export async function queryHierarchy(
  headers: Headers,
  deps: ConfigurationDependencies = configurationDependencies(),
): Promise<StaffQueryResult<HierarchyView>> {
  const ctx = await staffContext(headers, deps);
  if (!ctx) return { kind: "UNAUTHENTICATED" };
  const scope = await authorizeQueryScope(
    {
      principal: principalOf(ctx.principal),
      permission: "organization.read",
      operation: "READ",
      sensitivity: "INTERNAL",
      ...(ctx.correlationId ? { correlationId: ctx.correlationId } : {}),
    },
    deps,
  );
  if (scope.decision !== "ALLOW") return { kind: "NOT_FOUND" };
  const rows = await listHierarchyInScope(db(deps), scope.constraint);
  const organizations = [];
  for (const org of rows.organizations) {
    const actions = await permittedActions(
      ctx.principal,
      [
        "organization.configure",
        "organization.status_change",
        "branch.configure",
        "branch.status_change",
        "team.configure",
        "team.status_change",
      ],
      {
        kind: "SCOPE",
        scopeType: "ORGANIZATION",
        id: org.id,
        sensitivity: "INTERNAL",
      },
      deps,
    );
    organizations.push({
      id: org.id,
      code: org.code,
      name: org.displayName,
      legalName: org.legalName,
      timezone: org.timezone,
      status: org.status as HierarchyStatus,
      version: org.version,
      actions,
      branches: rows.branches
        .filter((b) => b.organizationId === org.id)
        .map((b) => ({
          id: b.id,
          code: b.code,
          name: b.name,
          status: b.status as HierarchyStatus,
          version: b.version,
          publicLocationLabel: b.publicLocationLabel,
          timezone: b.timezone,
          teams: rows.teams
            .filter((t) => t.branchId === b.id)
            .map((t) => ({
              id: t.id,
              code: t.code,
              name: t.name,
              status: t.status as HierarchyStatus,
              version: t.version,
            })),
        })),
    });
  }
  return render(
    hierarchyContract,
    { organizations },
    ["organization.read"],
    deps,
  );
}

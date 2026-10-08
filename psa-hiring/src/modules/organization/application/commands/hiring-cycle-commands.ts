import "server-only";
import {
  cancelReasons,
  changeReasons,
  closeReasons,
  cycleEditable,
  cycleTransition,
  isMember,
  windowCoherent,
  withinWindow,
  type CycleCommand,
  type CycleWindow,
} from "../../domain/lifecycle";
import {
  isUuid,
  type CycleStatus,
  type WorkerPaths,
} from "../../domain/values";
import { parseZonedLocal } from "../../domain/zoned-time";
import {
  findBranch,
  findCycle,
  findDescriptionByStatus,
  findOrganization,
  findPosition,
  findTeam,
  insertCycle,
  newPublicReference,
  updateCycle,
  type CyclePatch,
  type CycleRow,
  type Executor,
} from "../../infrastructure/organization-repository";
import {
  PUBLIC_POSITIONS_TAG,
  publicPositionTag,
} from "../../infrastructure/public-position-cache";
import {
  authorizeConfiguration,
  configurationDependencies,
  refuse,
  runConfigurationCommand,
  type ConfigurationActor,
  type ConfigurationDependencies,
} from "../configuration-runtime";
import { expectedVersion, FieldCollector } from "../input";
import { validated, type ConfigurationResult } from "./result";
import type { StatusInput } from "./hierarchy-commands";

// Hiring-cycle commands (packet M2.1 §12–§13, §15, §21). A hiring cycle is
// one opening of a reusable position at one branch and optional team.
//
// - Placement (organization, position, branch, team) is fixed at
//   creation and taken from stored rows; the organization is always the
//   position's, never a request value. Composite foreign keys refuse any
//   cross-organization or cross-branch combination.
// - Drafts are editable. Publication freezes the snapshot: the position's
//   current published description version, its worker paths, the public
//   title, the branch's public location label, and the display timezone.
//   Later edits to any source never change a published cycle.
// - Publish and open recheck every parent inside the transaction (parents
//   are read FOR SHARE after the cycle is locked), so a racing parent
//   inactivation either commits first and refuses this command, or waits.
// - Opening needs opens_at ≤ now < closes_at at the trusted server clock.
// - Closed, cancelled, and archived cycles never return; reopening needs
//   a new cycle.

const label = { max: 120 } as const;

export type CycleInput = Readonly<{
  commandKey?: string;
  positionId?: string;
  cycleId?: string;
  branchId?: string;
  teamId?: string;
  expectedVersion?: string;
  code?: string;
  internalLabel?: string;
  publicLabel?: string;
  opensAt?: string;
  closesAt?: string;
  openEnded?: string;
}>;

type CycleFields = Readonly<{
  code: string;
  internalLabel: string;
  publicLabel: string | null;
  window: CycleWindow;
}>;

/** Validates editable fields; times are wall-clock in the branch timezone. */
function cycleFields(input: CycleInput, timeZone: string): CycleFields {
  const f = new FieldCollector();
  const code = f.code("code", input.code);
  const internalLabel =
    f.text("internalLabel", input.internalLabel, label) ?? "";
  const publicLabel = f.text("publicLabel", input.publicLabel, {
    ...label,
    optional: true,
  });
  const openEnded = input.openEnded === "yes";
  if (input.openEnded !== undefined && input.openEnded !== "yes") {
    f.add("openEnded", "INVALID_CHOICE");
  }
  const opens = parseZonedLocal(input.opensAt, timeZone);
  if (!opens.ok) f.add("opensAt", opens.problem);
  let closesAt: Date | null = null;
  if (openEnded) {
    if (input.closesAt) f.add("closesAt", "MUST_BE_EMPTY_WHEN_OPEN_ENDED");
  } else {
    const closes = parseZonedLocal(input.closesAt, timeZone);
    if (!closes.ok) f.add("closesAt", closes.problem);
    else closesAt = closes.instant;
  }
  const window = {
    opensAt: opens.ok ? opens.instant : new Date(Number.NaN),
    closesAt,
    openEnded,
  };
  if (opens.ok && (openEnded || closesAt) && !windowCoherent(window)) {
    f.add("closesAt", "MUST_BE_AFTER_OPENS");
  }
  f.finish();
  return { code, internalLabel, publicLabel, window };
}

function inputTimes(input: CycleInput): boolean {
  return typeof input.opensAt === "string";
}

const tagsFor = (row: CycleRow) => [
  PUBLIC_POSITIONS_TAG,
  publicPositionTag(row.publicReference),
];

/** Organization, branch, optional team, and position are all ACTIVE now. */
async function parentsActive(tx: Executor, row: CycleRow): Promise<boolean> {
  const [org, branch, team, position] = await Promise.all([
    findOrganization(tx, row.organizationId, "share"),
    findBranch(tx, row.branchId, "share"),
    row.teamId ? findTeam(tx, row.teamId, "share") : Promise.resolve(null),
    findPosition(tx, row.positionId, "share"),
  ]);
  return (
    org?.status === "ACTIVE" &&
    branch?.status === "ACTIVE" &&
    (row.teamId === null || team?.status === "ACTIVE") &&
    position?.status === "ACTIVE"
  );
}

export function createHiringCycle(
  input: CycleInput,
  actor: ConfigurationActor,
  deps: ConfigurationDependencies = configurationDependencies(),
): Promise<ConfigurationResult> {
  return validated(async () => {
    if (!isUuid(input.positionId) || !isUuid(input.branchId))
      refuse("NOT_FOUND");
    const teamId = input.teamId ? input.teamId : null;
    if (teamId !== null && !isUuid(teamId)) refuse("INVALID_INPUT");
    if (!inputTimes(input)) refuse("INVALID_INPUT");
    const positionId = input.positionId!;
    const branchId = input.branchId!;
    return runConfigurationCommand(
      deps,
      actor,
      { name: "create_hiring_cycle", commandKey: input.commandKey },
      async (ctx) => {
        // The placement scope is resolved from stored rows by the M1
        // service: a TEAM scope when a team is chosen, otherwise BRANCH.
        await authorizeConfiguration(
          ctx,
          actor,
          deps,
          "hiring_cycle.create",
          teamId
            ? {
                kind: "SCOPE",
                scopeType: "TEAM",
                id: teamId,
                sensitivity: "INTERNAL",
              }
            : {
                kind: "SCOPE",
                scopeType: "BRANCH",
                id: branchId,
                sensitivity: "INTERNAL",
              },
        );
        const position =
          (await findPosition(ctx.tx, positionId, "share")) ??
          refuse("NOT_FOUND");
        const branch =
          (await findBranch(ctx.tx, branchId, "share")) ?? refuse("NOT_FOUND");
        const team = teamId ? await findTeam(ctx.tx, teamId, "share") : null;
        if (teamId && !team) refuse("NOT_FOUND");
        // Cross-organization or cross-branch placement is refused here and,
        // as a backstop, by the composite foreign keys.
        if (branch.organizationId !== position.organizationId)
          refuse("INVALID_INPUT");
        if (team && team.branchId !== branch.id) refuse("INVALID_INPUT");
        const org = await findOrganization(
          ctx.tx,
          position.organizationId,
          "share",
        );
        if (
          position.status !== "ACTIVE" ||
          branch.status !== "ACTIVE" ||
          (team && team.status !== "ACTIVE") ||
          org?.status !== "ACTIVE"
        ) {
          refuse("PARENT_NOT_ACTIVE");
        }
        const fields = cycleFields(input, branch.timezone);
        const row = await insertCycle(
          ctx.tx,
          {
            publicReference: newPublicReference(),
            organizationId: position.organizationId,
            positionId,
            branchId,
            teamId,
            code: fields.code,
            internalLabel: fields.internalLabel,
            publicLabel: fields.publicLabel,
            opensAt: fields.window.opensAt,
            closesAt: fields.window.closesAt,
            openEnded: fields.window.openEnded,
            displayTimezone: branch.timezone,
          },
          ctx.actorId,
          ctx.now,
        );
        ctx.events.push({
          code: "hiring_cycle.created",
          recordRef: row.id,
          organizationRef: row.organizationId,
          newVersion: row.version,
          changeCodes: ["CODE", "LABEL", "PLACEMENT", "WINDOW"],
        });
        return { targetId: row.id, version: row.version };
      },
    );
  });
}

export function updateHiringCycleDraft(
  input: CycleInput,
  actor: ConfigurationActor,
  deps: ConfigurationDependencies = configurationDependencies(),
): Promise<ConfigurationResult> {
  return validated(async () => {
    if (!isUuid(input.cycleId)) refuse("NOT_FOUND");
    if (!inputTimes(input)) refuse("INVALID_INPUT");
    const version = expectedVersion(input.expectedVersion);
    const id = input.cycleId!;
    return runConfigurationCommand(
      deps,
      actor,
      { name: "update_hiring_cycle", commandKey: input.commandKey },
      async (ctx) => {
        await authorizeConfiguration(ctx, actor, deps, "hiring_cycle.edit", {
          kind: "RECORD",
          id,
          sensitivity: "INTERNAL",
        });
        const row =
          (await findCycle(ctx.tx, id, "update")) ?? refuse("NOT_FOUND");
        if (row.version !== version) refuse("STALE_VERSION");
        if (!cycleEditable(row.status as CycleStatus))
          refuse("INVALID_TRANSITION");
        const fields = cycleFields(input, row.displayTimezone);
        const changes = [
          fields.code !== row.code ? "CODE" : null,
          fields.internalLabel !== row.internalLabel ||
          fields.publicLabel !== row.publicLabel
            ? "LABEL"
            : null,
          fields.window.opensAt.getTime() !== row.opensAt.getTime() ||
          (fields.window.closesAt?.getTime() ?? null) !==
            (row.closesAt?.getTime() ?? null) ||
          fields.window.openEnded !== row.openEnded
            ? "WINDOW"
            : null,
        ].filter((c): c is string => c !== null);
        if (changes.length === 0) return { targetId: id, version: row.version };
        const updated =
          (await updateCycle(
            ctx.tx,
            id,
            version,
            {
              code: fields.code,
              internalLabel: fields.internalLabel,
              publicLabel: fields.publicLabel,
              opensAt: fields.window.opensAt,
              closesAt: fields.window.closesAt,
              openEnded: fields.window.openEnded,
            },
            ctx.actorId,
            ctx.now,
          )) ?? refuse("STALE_VERSION");
        ctx.events.push({
          code: "hiring_cycle.updated",
          recordRef: id,
          organizationRef: row.organizationId,
          previousVersion: row.version,
          newVersion: updated.version,
          changeCodes: changes,
        });
        return { targetId: id, version: updated.version };
      },
    );
  });
}

const cyclePermission: Readonly<Record<CycleCommand, string>> = {
  publish: "hiring_cycle.publish",
  open: "hiring_cycle.open",
  close: "hiring_cycle.close",
  cancel: "hiring_cycle.cancel",
  archive: "hiring_cycle.archive",
};

const cycleEvent = {
  publish: "hiring_cycle.published",
  open: "hiring_cycle.opened",
  close: "hiring_cycle.closed",
  cancel: "hiring_cycle.cancelled",
  archive: "hiring_cycle.archived",
} as const;

function reasonFor(command: CycleCommand, value: unknown): string {
  const allowed =
    command === "close"
      ? closeReasons
      : command === "cancel"
        ? cancelReasons
        : changeReasons;
  return isMember(allowed as readonly string[], value)
    ? (value as string)
    : refuse("INVALID_INPUT");
}

/** publish / open / close / cancel / archive a hiring cycle. */
export function transitionHiringCycle(
  command: CycleCommand,
  input: StatusInput,
  actor: ConfigurationActor,
  deps: ConfigurationDependencies = configurationDependencies(),
): Promise<ConfigurationResult> {
  return validated(async () => {
    if (!isUuid(input.targetId)) refuse("NOT_FOUND");
    const version = expectedVersion(input.expectedVersion);
    const reason = reasonFor(command, input.reasonCode);
    const id = input.targetId!;
    return runConfigurationCommand(
      deps,
      actor,
      { name: `${command}_hiring_cycle`, commandKey: input.commandKey },
      async (ctx) => {
        await authorizeConfiguration(
          ctx,
          actor,
          deps,
          cyclePermission[command],
          { kind: "RECORD", id, sensitivity: "INTERNAL" },
          reason,
        );
        const row =
          (await findCycle(ctx.tx, id, "update")) ?? refuse("NOT_FOUND");
        if (row.version !== version) refuse("STALE_VERSION");
        const to =
          cycleTransition(command, row.status as CycleStatus) ??
          refuse("INVALID_TRANSITION");
        const window: CycleWindow = {
          opensAt: row.opensAt,
          closesAt: row.closesAt,
          openEnded: row.openEnded,
        };
        let patch: CyclePatch = { status: to };
        switch (command) {
          case "publish": {
            if (!(await parentsActive(ctx.tx, row)))
              refuse("PARENT_NOT_ACTIVE");
            if (!windowCoherent(window)) refuse("WINDOW_INVALID");
            if (row.closesAt && row.closesAt.getTime() <= ctx.now.getTime()) {
              refuse("WINDOW_INVALID");
            }
            const description = await findDescriptionByStatus(
              ctx.tx,
              row.positionId,
              "PUBLISHED",
              "share",
            );
            if (!description) refuse("DESCRIPTION_NOT_PUBLISHED");
            const position = (await findPosition(
              ctx.tx,
              row.positionId,
              "share",
            ))!;
            const branch = (await findBranch(ctx.tx, row.branchId, "share"))!;
            patch = {
              status: to,
              jobDescriptionVersionId: description!.id,
              workerPathsSnapshot: position.workerPathsAllowed as WorkerPaths,
              publicTitleSnapshot: description!.publicTitle,
              locationLabelSnapshot: branch.publicLocationLabel,
              displayTimezone: branch.timezone,
              publishedAt: ctx.now,
              publishedByAccountId: ctx.actorId,
            };
            break;
          }
          case "open":
            if (!(await parentsActive(ctx.tx, row)))
              refuse("PARENT_NOT_ACTIVE");
            if (!withinWindow(window, ctx.now)) refuse("WINDOW_NOT_OPEN");
            patch = {
              status: to,
              openedAt: ctx.now,
              openedByAccountId: ctx.actorId,
            };
            break;
          case "close":
            patch = {
              status: to,
              closedAt: ctx.now,
              closedByAccountId: ctx.actorId,
              endReasonCode: reason,
            };
            break;
          case "cancel":
            patch = {
              status: to,
              cancelledAt: ctx.now,
              cancelledByAccountId: ctx.actorId,
              endReasonCode: reason,
            };
            break;
          case "archive":
            patch = {
              status: to,
              archivedAt: ctx.now,
              archivedByAccountId: ctx.actorId,
            };
            break;
        }
        const updated =
          (await updateCycle(
            ctx.tx,
            id,
            version,
            patch,
            ctx.actorId,
            ctx.now,
          )) ?? refuse("STALE_VERSION");
        ctx.events.push({
          code: cycleEvent[command],
          recordRef: id,
          organizationRef: row.organizationId,
          previousVersion: row.version,
          newVersion: updated.version,
          reasonCode: reason,
        });
        for (const tag of tagsFor(row)) ctx.tags.add(tag);
        return { targetId: id, version: updated.version };
      },
    );
  });
}

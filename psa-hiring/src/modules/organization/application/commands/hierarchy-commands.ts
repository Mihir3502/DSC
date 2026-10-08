import "server-only";
import {
  changeReasons,
  hierarchyEditable,
  hierarchyTransition,
  isMember,
  type HierarchyCommand,
} from "../../domain/lifecycle";
import { isTimezone, isUuid, type HierarchyStatus } from "../../domain/values";
import {
  findBranch,
  findOrganization,
  findTeam,
  insertBranch,
  insertOrganization,
  insertTeam,
  updateBranch,
  updateOrganization,
  updateTeam,
} from "../../infrastructure/organization-repository";
import { PUBLIC_POSITIONS_TAG } from "../../infrastructure/public-position-cache";
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

// Organization, branch, and team commands (packet M2.1 §7–§8, §15).
//
// - Organizations are provisioned (created and first activated) only
//   through the nonproduction bootstrap actor in M2.1; no account can
//   create an organization, because no scope exists before it does. A
//   production provisioning procedure is an open decision (DATA_MODEL §28).
// - Every hierarchy change is authorized against the organization-wide
//   scope (ROLE_PERMISSION_MATRIX §14 "Organization hierarchy": PSA
//   Manager only), so a branch- or team-scoped role never reshapes the
//   hierarchy. Status changes need recent authentication and a reason.
// - Parents never change (no reparenting command; triggers refuse it).
// - Activation requires every ancestor to be ACTIVE.
// Every status change also invalidates the public position cache: a
// parent's status decides whether its openings are public.

const name = { max: 120 } as const;
const legalName = { max: 200 } as const;

function timezone(fields: FieldCollector, field: string, value: unknown) {
  if (!isTimezone(value)) {
    fields.add(field, "INVALID_TIMEZONE");
    return "";
  }
  return value as string;
}

function statusReason(value: unknown) {
  return isMember(changeReasons, value) ? value : refuse("INVALID_INPUT");
}

function transition(command: HierarchyCommand, from: HierarchyStatus) {
  return hierarchyTransition(command, from) ?? refuse("INVALID_TRANSITION");
}

const statusPatch = (
  command: HierarchyCommand,
  to: HierarchyStatus,
  now: Date,
  activatedAt: Date | null,
) =>
  command === "activate"
    ? { status: to, activatedAt: activatedAt ?? now, inactivatedAt: null }
    : { status: to, inactivatedAt: now };

const statusEvent = {
  organization: {
    activate: "organization.activated",
    inactivate: "organization.inactivated",
  },
  branch: { activate: "branch.activated", inactivate: "branch.inactivated" },
  team: { activate: "team.activated", inactivate: "team.inactivated" },
} as const;

// ------------------------------------------------------------ organization

export type CreateOrganizationInput = Readonly<{
  commandKey?: string;
  code?: string;
  legalName?: string;
  displayName?: string;
  timezone?: string;
}>;

export function createOrganization(
  input: CreateOrganizationInput,
  actor: ConfigurationActor,
  deps: ConfigurationDependencies = configurationDependencies(),
): Promise<ConfigurationResult> {
  return validated(async () => {
    const f = new FieldCollector();
    const values = {
      code: f.code("code", input.code),
      legalName: f.text("legalName", input.legalName, legalName) ?? "",
      displayName: f.text("displayName", input.displayName, name) ?? "",
      timezone: timezone(f, "timezone", input.timezone),
    };
    f.finish();
    return runConfigurationCommand(
      deps,
      actor,
      { name: "create_organization", commandKey: input.commandKey },
      async (ctx) => {
        // No account holds a scope over an organization that does not
        // exist yet: creation is the provisioning (bootstrap) step.
        if (actor.kind !== "BOOTSTRAP") refuse("NOT_AUTHORIZED");
        await authorizeConfiguration(
          ctx,
          actor,
          deps,
          "organization.configure",
          {
            kind: "SCOPE",
            scopeType: "ORGANIZATION",
            id: ctx.actorId,
            sensitivity: "INTERNAL",
          },
        );
        const row = await insertOrganization(
          ctx.tx,
          values,
          ctx.actorId,
          ctx.now,
        );
        ctx.events.push({
          code: "organization.created",
          recordRef: row.id,
          organizationRef: row.id,
          newVersion: row.version,
          changeCodes: ["CODE", "NAME", "TIMEZONE"],
        });
        return { targetId: row.id, version: row.version };
      },
    );
  });
}

export type UpdateOrganizationInput = CreateOrganizationInput &
  Readonly<{ organizationId?: string; expectedVersion?: string }>;

export function updateOrganizationDetails(
  input: UpdateOrganizationInput,
  actor: ConfigurationActor,
  deps: ConfigurationDependencies = configurationDependencies(),
): Promise<ConfigurationResult> {
  return validated(async () => {
    if (!isUuid(input.organizationId)) refuse("NOT_FOUND");
    const version = expectedVersion(input.expectedVersion);
    const f = new FieldCollector();
    const values = {
      code: f.code("code", input.code),
      legalName: f.text("legalName", input.legalName, legalName) ?? "",
      displayName: f.text("displayName", input.displayName, name) ?? "",
      timezone: timezone(f, "timezone", input.timezone),
    };
    f.finish();
    const id = input.organizationId!;
    return runConfigurationCommand(
      deps,
      actor,
      { name: "update_organization", commandKey: input.commandKey },
      async (ctx) => {
        await authorizeConfiguration(
          ctx,
          actor,
          deps,
          "organization.configure",
          {
            kind: "SCOPE",
            scopeType: "ORGANIZATION",
            id,
            sensitivity: "INTERNAL",
          },
        );
        const row =
          (await findOrganization(ctx.tx, id, "update")) ?? refuse("NOT_FOUND");
        if (row.version !== version) refuse("STALE_VERSION");
        if (!hierarchyEditable(row.status as HierarchyStatus))
          refuse("INVALID_TRANSITION");
        if (values.code !== row.code && row.status !== "DRAFT")
          refuse("INVALID_TRANSITION");
        const changes = [
          values.code !== row.code ? "CODE" : null,
          values.legalName !== row.legalName ||
          values.displayName !== row.displayName
            ? "NAME"
            : null,
          values.timezone !== row.timezone ? "TIMEZONE" : null,
        ].filter((c): c is string => c !== null);
        if (changes.length === 0)
          return { targetId: row.id, version: row.version };
        const updated =
          (await updateOrganization(
            ctx.tx,
            id,
            version,
            values,
            ctx.actorId,
            ctx.now,
          )) ?? refuse("STALE_VERSION");
        ctx.events.push({
          code: "organization.updated",
          recordRef: id,
          organizationRef: id,
          previousVersion: row.version,
          newVersion: updated.version,
          changeCodes: changes,
        });
        return { targetId: id, version: updated.version };
      },
    );
  });
}

export type StatusInput = Readonly<{
  commandKey?: string;
  targetId?: string;
  expectedVersion?: string;
  reasonCode?: string;
}>;

export function changeOrganizationStatus(
  command: HierarchyCommand,
  input: StatusInput,
  actor: ConfigurationActor,
  deps: ConfigurationDependencies = configurationDependencies(),
): Promise<ConfigurationResult> {
  return validated(async () => {
    if (!isUuid(input.targetId)) refuse("NOT_FOUND");
    const version = expectedVersion(input.expectedVersion);
    const reason = statusReason(input.reasonCode);
    const id = input.targetId!;
    return runConfigurationCommand(
      deps,
      actor,
      { name: `${command}_organization`, commandKey: input.commandKey },
      async (ctx) => {
        await authorizeConfiguration(
          ctx,
          actor,
          deps,
          "organization.status_change",
          {
            kind: "SCOPE",
            scopeType: "ORGANIZATION",
            id,
            sensitivity: "INTERNAL",
          },
          reason,
        );
        const row =
          (await findOrganization(ctx.tx, id, "update")) ?? refuse("NOT_FOUND");
        if (row.version !== version) refuse("STALE_VERSION");
        const to = transition(command, row.status as HierarchyStatus);
        const updated =
          (await updateOrganization(
            ctx.tx,
            id,
            version,
            statusPatch(command, to, ctx.now, row.activatedAt),
            ctx.actorId,
            ctx.now,
          )) ?? refuse("STALE_VERSION");
        ctx.events.push({
          code: statusEvent.organization[command],
          recordRef: id,
          organizationRef: id,
          previousVersion: row.version,
          newVersion: updated.version,
          reasonCode: reason,
        });
        ctx.tags.add(PUBLIC_POSITIONS_TAG);
        return { targetId: id, version: updated.version };
      },
    );
  });
}

// ------------------------------------------------------------------ branch

export type BranchInput = Readonly<{
  commandKey?: string;
  organizationId?: string;
  branchId?: string;
  expectedVersion?: string;
  code?: string;
  name?: string;
  publicLocationLabel?: string;
  timezone?: string;
}>;

function branchValues(input: BranchInput) {
  const f = new FieldCollector();
  const values = {
    code: f.code("code", input.code),
    name: f.text("name", input.name, name) ?? "",
    publicLocationLabel:
      f.text("publicLocationLabel", input.publicLocationLabel, name) ?? "",
    timezone: timezone(f, "timezone", input.timezone),
  };
  f.finish();
  return values;
}

export function createBranch(
  input: BranchInput,
  actor: ConfigurationActor,
  deps: ConfigurationDependencies = configurationDependencies(),
): Promise<ConfigurationResult> {
  return validated(async () => {
    if (!isUuid(input.organizationId)) refuse("NOT_FOUND");
    const values = branchValues(input);
    const organizationId = input.organizationId!;
    return runConfigurationCommand(
      deps,
      actor,
      { name: "create_branch", commandKey: input.commandKey },
      async (ctx) => {
        await authorizeConfiguration(ctx, actor, deps, "branch.configure", {
          kind: "SCOPE",
          scopeType: "ORGANIZATION",
          id: organizationId,
          sensitivity: "INTERNAL",
        });
        const parent =
          (await findOrganization(ctx.tx, organizationId, "share")) ??
          refuse("NOT_FOUND");
        if (!hierarchyEditable(parent.status as HierarchyStatus)) {
          refuse("PARENT_NOT_ACTIVE");
        }
        const row = await insertBranch(
          ctx.tx,
          { organizationId, ...values },
          ctx.actorId,
          ctx.now,
        );
        ctx.events.push({
          code: "branch.created",
          recordRef: row.id,
          organizationRef: organizationId,
          newVersion: row.version,
          changeCodes: ["CODE", "NAME", "LOCATION_LABEL", "TIMEZONE"],
        });
        return { targetId: row.id, version: row.version };
      },
    );
  });
}

export function updateBranchDetails(
  input: BranchInput,
  actor: ConfigurationActor,
  deps: ConfigurationDependencies = configurationDependencies(),
): Promise<ConfigurationResult> {
  return validated(async () => {
    if (!isUuid(input.branchId)) refuse("NOT_FOUND");
    const version = expectedVersion(input.expectedVersion);
    const values = branchValues(input);
    const id = input.branchId!;
    return runConfigurationCommand(
      deps,
      actor,
      { name: "update_branch", commandKey: input.commandKey },
      async (ctx) => {
        const row =
          (await findBranch(ctx.tx, id, "update")) ?? refuse("NOT_FOUND");
        await authorizeConfiguration(ctx, actor, deps, "branch.configure", {
          kind: "SCOPE",
          scopeType: "ORGANIZATION",
          id: row.organizationId,
          sensitivity: "INTERNAL",
        });
        if (row.version !== version) refuse("STALE_VERSION");
        if (!hierarchyEditable(row.status as HierarchyStatus))
          refuse("INVALID_TRANSITION");
        if (values.code !== row.code && row.status !== "DRAFT")
          refuse("INVALID_TRANSITION");
        const changes = [
          values.code !== row.code ? "CODE" : null,
          values.name !== row.name ? "NAME" : null,
          values.publicLocationLabel !== row.publicLocationLabel
            ? "LOCATION_LABEL"
            : null,
          values.timezone !== row.timezone ? "TIMEZONE" : null,
        ].filter((c): c is string => c !== null);
        if (changes.length === 0) return { targetId: id, version: row.version };
        const updated =
          (await updateBranch(
            ctx.tx,
            id,
            version,
            values,
            ctx.actorId,
            ctx.now,
          )) ?? refuse("STALE_VERSION");
        ctx.events.push({
          code: "branch.updated",
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

export function changeBranchStatus(
  command: HierarchyCommand,
  input: StatusInput,
  actor: ConfigurationActor,
  deps: ConfigurationDependencies = configurationDependencies(),
): Promise<ConfigurationResult> {
  return validated(async () => {
    if (!isUuid(input.targetId)) refuse("NOT_FOUND");
    const version = expectedVersion(input.expectedVersion);
    const reason = statusReason(input.reasonCode);
    const id = input.targetId!;
    return runConfigurationCommand(
      deps,
      actor,
      { name: `${command}_branch`, commandKey: input.commandKey },
      async (ctx) => {
        const row =
          (await findBranch(ctx.tx, id, "update")) ?? refuse("NOT_FOUND");
        await authorizeConfiguration(
          ctx,
          actor,
          deps,
          "branch.status_change",
          {
            kind: "SCOPE",
            scopeType: "ORGANIZATION",
            id: row.organizationId,
            sensitivity: "INTERNAL",
          },
          reason,
        );
        if (row.version !== version) refuse("STALE_VERSION");
        const to = transition(command, row.status as HierarchyStatus);
        if (command === "activate") {
          const parent = await findOrganization(
            ctx.tx,
            row.organizationId,
            "share",
          );
          if (parent?.status !== "ACTIVE") refuse("PARENT_NOT_ACTIVE");
        }
        const updated =
          (await updateBranch(
            ctx.tx,
            id,
            version,
            statusPatch(command, to, ctx.now, row.activatedAt),
            ctx.actorId,
            ctx.now,
          )) ?? refuse("STALE_VERSION");
        ctx.events.push({
          code: statusEvent.branch[command],
          recordRef: id,
          organizationRef: row.organizationId,
          previousVersion: row.version,
          newVersion: updated.version,
          reasonCode: reason,
        });
        ctx.tags.add(PUBLIC_POSITIONS_TAG);
        return { targetId: id, version: updated.version };
      },
    );
  });
}

// -------------------------------------------------------------------- team

export type TeamInput = Readonly<{
  commandKey?: string;
  branchId?: string;
  teamId?: string;
  expectedVersion?: string;
  code?: string;
  name?: string;
}>;

function teamValues(input: TeamInput) {
  const f = new FieldCollector();
  const values = {
    code: f.code("code", input.code),
    name: f.text("name", input.name, name) ?? "",
  };
  f.finish();
  return values;
}

export function createTeam(
  input: TeamInput,
  actor: ConfigurationActor,
  deps: ConfigurationDependencies = configurationDependencies(),
): Promise<ConfigurationResult> {
  return validated(async () => {
    if (!isUuid(input.branchId)) refuse("NOT_FOUND");
    const values = teamValues(input);
    const branchId = input.branchId!;
    return runConfigurationCommand(
      deps,
      actor,
      { name: "create_team", commandKey: input.commandKey },
      async (ctx) => {
        // Ancestry comes from the stored branch, never from the request.
        const parent =
          (await findBranch(ctx.tx, branchId, "share")) ?? refuse("NOT_FOUND");
        await authorizeConfiguration(ctx, actor, deps, "team.configure", {
          kind: "SCOPE",
          scopeType: "ORGANIZATION",
          id: parent.organizationId,
          sensitivity: "INTERNAL",
        });
        if (!hierarchyEditable(parent.status as HierarchyStatus)) {
          refuse("PARENT_NOT_ACTIVE");
        }
        const row = await insertTeam(
          ctx.tx,
          { organizationId: parent.organizationId, branchId, ...values },
          ctx.actorId,
          ctx.now,
        );
        ctx.events.push({
          code: "team.created",
          recordRef: row.id,
          organizationRef: parent.organizationId,
          newVersion: row.version,
          changeCodes: ["CODE", "NAME"],
        });
        return { targetId: row.id, version: row.version };
      },
    );
  });
}

export function updateTeamDetails(
  input: TeamInput,
  actor: ConfigurationActor,
  deps: ConfigurationDependencies = configurationDependencies(),
): Promise<ConfigurationResult> {
  return validated(async () => {
    if (!isUuid(input.teamId)) refuse("NOT_FOUND");
    const version = expectedVersion(input.expectedVersion);
    const values = teamValues(input);
    const id = input.teamId!;
    return runConfigurationCommand(
      deps,
      actor,
      { name: "update_team", commandKey: input.commandKey },
      async (ctx) => {
        const row =
          (await findTeam(ctx.tx, id, "update")) ?? refuse("NOT_FOUND");
        await authorizeConfiguration(ctx, actor, deps, "team.configure", {
          kind: "SCOPE",
          scopeType: "ORGANIZATION",
          id: row.organizationId,
          sensitivity: "INTERNAL",
        });
        if (row.version !== version) refuse("STALE_VERSION");
        if (!hierarchyEditable(row.status as HierarchyStatus))
          refuse("INVALID_TRANSITION");
        if (values.code !== row.code && row.status !== "DRAFT")
          refuse("INVALID_TRANSITION");
        const changes = [
          values.code !== row.code ? "CODE" : null,
          values.name !== row.name ? "NAME" : null,
        ].filter((c): c is string => c !== null);
        if (changes.length === 0) return { targetId: id, version: row.version };
        const updated =
          (await updateTeam(
            ctx.tx,
            id,
            version,
            values,
            ctx.actorId,
            ctx.now,
          )) ?? refuse("STALE_VERSION");
        ctx.events.push({
          code: "team.updated",
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

export function changeTeamStatus(
  command: HierarchyCommand,
  input: StatusInput,
  actor: ConfigurationActor,
  deps: ConfigurationDependencies = configurationDependencies(),
): Promise<ConfigurationResult> {
  return validated(async () => {
    if (!isUuid(input.targetId)) refuse("NOT_FOUND");
    const version = expectedVersion(input.expectedVersion);
    const reason = statusReason(input.reasonCode);
    const id = input.targetId!;
    return runConfigurationCommand(
      deps,
      actor,
      { name: `${command}_team`, commandKey: input.commandKey },
      async (ctx) => {
        const row =
          (await findTeam(ctx.tx, id, "update")) ?? refuse("NOT_FOUND");
        await authorizeConfiguration(
          ctx,
          actor,
          deps,
          "team.status_change",
          {
            kind: "SCOPE",
            scopeType: "ORGANIZATION",
            id: row.organizationId,
            sensitivity: "INTERNAL",
          },
          reason,
        );
        if (row.version !== version) refuse("STALE_VERSION");
        const to = transition(command, row.status as HierarchyStatus);
        if (command === "activate") {
          const parent = await findBranch(ctx.tx, row.branchId, "share");
          const org = await findOrganization(
            ctx.tx,
            row.organizationId,
            "share",
          );
          if (parent?.status !== "ACTIVE" || org?.status !== "ACTIVE") {
            refuse("PARENT_NOT_ACTIVE");
          }
        }
        const updated =
          (await updateTeam(
            ctx.tx,
            id,
            version,
            statusPatch(command, to, ctx.now, row.activatedAt),
            ctx.actorId,
            ctx.now,
          )) ?? refuse("STALE_VERSION");
        ctx.events.push({
          code: statusEvent.team[command],
          recordRef: id,
          organizationRef: row.organizationId,
          previousVersion: row.version,
          newVersion: updated.version,
          reasonCode: reason,
        });
        ctx.tags.add(PUBLIC_POSITIONS_TAG);
        return { targetId: id, version: updated.version };
      },
    );
  });
}

import "server-only";
import {
  changeReasons,
  descriptionEditable,
  isMember,
  positionEditable,
  positionTransition,
  type PositionCommand,
} from "../../domain/lifecycle";
import {
  isUuid,
  isWorkerPaths,
  type DescriptionStatus,
  type PositionStatus,
  type WorkerPaths,
} from "../../domain/values";
import {
  findDescription,
  findDescriptionByStatus,
  findOrganization,
  findPosition,
  insertDescriptionDraft,
  insertPosition,
  publishDescriptionDraft,
  supersedeDescription,
  updateDescriptionDraft,
  updatePosition,
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
import type { StatusInput } from "./hierarchy-commands";

// Reusable position and immutable job-description commands (packet M2.1
// §10–§11, §15).
//
// - A position is organization-level configuration: its scope is the
//   organization, so only organization-scoped roles reach it.
// - Worker paths describe what the position may support; nothing here
//   classifies a person or approves a 1099 path.
// - Description drafts are editable; publication freezes the content and
//   supersedes the previous published version in the same transaction.
//   Version numbers are allocated under the position row lock. Published
//   cycles keep the version they captured, so nothing here alters them.

const titles = { max: 120 } as const;

// -------------------------------------------------------------- position

export type PositionInput = Readonly<{
  commandKey?: string;
  organizationId?: string;
  positionId?: string;
  expectedVersion?: string;
  code?: string;
  internalTitle?: string;
  publicTitle?: string;
  workerPathsAllowed?: string;
}>;

function positionValues(input: PositionInput) {
  const f = new FieldCollector();
  const values = {
    code: f.code("code", input.code),
    internalTitle: f.text("internalTitle", input.internalTitle, titles) ?? "",
    publicTitle: f.text("publicTitle", input.publicTitle, titles) ?? "",
    workerPathsAllowed: (isWorkerPaths(input.workerPathsAllowed)
      ? input.workerPathsAllowed
      : (f.add("workerPathsAllowed", "INVALID_CHOICE"),
        "W2_ONLY")) as WorkerPaths,
  };
  f.finish();
  return values;
}

export function createPosition(
  input: PositionInput,
  actor: ConfigurationActor,
  deps: ConfigurationDependencies = configurationDependencies(),
): Promise<ConfigurationResult> {
  return validated(async () => {
    if (!isUuid(input.organizationId)) refuse("NOT_FOUND");
    const values = positionValues(input);
    const organizationId = input.organizationId!;
    return runConfigurationCommand(
      deps,
      actor,
      { name: "create_position", commandKey: input.commandKey },
      async (ctx) => {
        await authorizeConfiguration(ctx, actor, deps, "position.create", {
          kind: "SCOPE",
          scopeType: "ORGANIZATION",
          id: organizationId,
          sensitivity: "INTERNAL",
        });
        const org =
          (await findOrganization(ctx.tx, organizationId, "share")) ??
          refuse("NOT_FOUND");
        if (org.status === "ARCHIVED") refuse("PARENT_NOT_ACTIVE");
        const row = await insertPosition(
          ctx.tx,
          { organizationId, ...values },
          ctx.actorId,
          ctx.now,
        );
        ctx.events.push({
          code: "position.created",
          recordRef: row.id,
          organizationRef: organizationId,
          newVersion: row.version,
          changeCodes: ["CODE", "TITLE", "WORKER_PATHS"],
        });
        return { targetId: row.id, version: row.version };
      },
    );
  });
}

export function updatePositionDetails(
  input: PositionInput,
  actor: ConfigurationActor,
  deps: ConfigurationDependencies = configurationDependencies(),
): Promise<ConfigurationResult> {
  return validated(async () => {
    if (!isUuid(input.positionId)) refuse("NOT_FOUND");
    const version = expectedVersion(input.expectedVersion);
    const values = positionValues(input);
    const id = input.positionId!;
    return runConfigurationCommand(
      deps,
      actor,
      { name: "update_position", commandKey: input.commandKey },
      async (ctx) => {
        await authorizeConfiguration(ctx, actor, deps, "position.edit", {
          kind: "RECORD",
          id,
          sensitivity: "INTERNAL",
        });
        const row =
          (await findPosition(ctx.tx, id, "update")) ?? refuse("NOT_FOUND");
        if (row.version !== version) refuse("STALE_VERSION");
        if (!positionEditable(row.status as PositionStatus))
          refuse("INVALID_TRANSITION");
        if (values.code !== row.code && row.status !== "DRAFT")
          refuse("INVALID_TRANSITION");
        const changes = [
          values.code !== row.code ? "CODE" : null,
          values.internalTitle !== row.internalTitle ||
          values.publicTitle !== row.publicTitle
            ? "TITLE"
            : null,
          values.workerPathsAllowed !== row.workerPathsAllowed
            ? "WORKER_PATHS"
            : null,
        ].filter((c): c is string => c !== null);
        if (changes.length === 0) return { targetId: id, version: row.version };
        const updated =
          (await updatePosition(
            ctx.tx,
            id,
            version,
            values,
            ctx.actorId,
            ctx.now,
          )) ?? refuse("STALE_VERSION");
        ctx.events.push({
          code: "position.updated",
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

const positionEvent = {
  activate: "position.activated",
  inactivate: "position.inactivated",
  retire: "position.retired",
} as const;

export function changePositionStatus(
  command: PositionCommand,
  input: StatusInput,
  actor: ConfigurationActor,
  deps: ConfigurationDependencies = configurationDependencies(),
): Promise<ConfigurationResult> {
  return validated(async () => {
    if (!isUuid(input.targetId)) refuse("NOT_FOUND");
    const version = expectedVersion(input.expectedVersion);
    const reason = isMember(changeReasons, input.reasonCode)
      ? input.reasonCode
      : refuse("INVALID_INPUT");
    const id = input.targetId!;
    return runConfigurationCommand(
      deps,
      actor,
      { name: `${command}_position`, commandKey: input.commandKey },
      async (ctx) => {
        await authorizeConfiguration(
          ctx,
          actor,
          deps,
          command === "retire" ? "position.retire" : "position.activate",
          { kind: "RECORD", id, sensitivity: "INTERNAL" },
          reason,
        );
        const row =
          (await findPosition(ctx.tx, id, "update")) ?? refuse("NOT_FOUND");
        if (row.version !== version) refuse("STALE_VERSION");
        const to =
          positionTransition(command, row.status as PositionStatus) ??
          refuse("INVALID_TRANSITION");
        if (command === "activate") {
          const org = await findOrganization(
            ctx.tx,
            row.organizationId,
            "share",
          );
          if (org?.status !== "ACTIVE") refuse("PARENT_NOT_ACTIVE");
        }
        const patch =
          command === "activate"
            ? { status: to, activatedAt: row.activatedAt ?? ctx.now }
            : command === "retire"
              ? { status: to, retiredAt: ctx.now }
              : { status: to };
        const updated =
          (await updatePosition(
            ctx.tx,
            id,
            version,
            patch,
            ctx.actorId,
            ctx.now,
          )) ?? refuse("STALE_VERSION");
        ctx.events.push({
          code: positionEvent[command],
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

// ------------------------------------------------- job-description versions

export type DescriptionInput = Readonly<{
  commandKey?: string;
  positionId?: string;
  descriptionId?: string;
  expectedVersion?: string;
  publicTitle?: string;
  summary?: string;
  body?: string;
}>;

function descriptionValues(input: DescriptionInput) {
  const f = new FieldCollector();
  const values = {
    publicTitle: f.text("publicTitle", input.publicTitle, titles) ?? "",
    summary: f.text("summary", input.summary, { max: 500 }) ?? "",
    body: f.text("body", input.body, { max: 8000, multiline: true }) ?? "",
  };
  f.finish();
  return values;
}

export function createDescriptionDraft(
  input: DescriptionInput,
  actor: ConfigurationActor,
  deps: ConfigurationDependencies = configurationDependencies(),
): Promise<ConfigurationResult> {
  return validated(async () => {
    if (!isUuid(input.positionId)) refuse("NOT_FOUND");
    const values = descriptionValues(input);
    const positionId = input.positionId!;
    return runConfigurationCommand(
      deps,
      actor,
      { name: "create_job_description_draft", commandKey: input.commandKey },
      async (ctx) => {
        await authorizeConfiguration(ctx, actor, deps, "job_description.edit", {
          kind: "RECORD",
          id: positionId,
          sensitivity: "INTERNAL",
        });
        // The position lock serializes version-number allocation.
        const parent =
          (await findPosition(ctx.tx, positionId, "update")) ??
          refuse("NOT_FOUND");
        if (!positionEditable(parent.status as PositionStatus))
          refuse("PARENT_NOT_ACTIVE");
        if (await findDescriptionByStatus(ctx.tx, positionId, "DRAFT", null)) {
          refuse("INVALID_TRANSITION");
        }
        const row = await insertDescriptionDraft(
          ctx.tx,
          { organizationId: parent.organizationId, positionId, ...values },
          ctx.actorId,
          ctx.now,
        );
        ctx.events.push({
          code: "job_description.draft_created",
          recordRef: row.id,
          organizationRef: parent.organizationId,
          newVersion: row.version,
          changeCodes: ["CONTENT"],
        });
        return { targetId: row.id, version: row.version };
      },
    );
  });
}

export function updateDescriptionDraftContent(
  input: DescriptionInput,
  actor: ConfigurationActor,
  deps: ConfigurationDependencies = configurationDependencies(),
): Promise<ConfigurationResult> {
  return validated(async () => {
    if (!isUuid(input.descriptionId)) refuse("NOT_FOUND");
    const version = expectedVersion(input.expectedVersion);
    const values = descriptionValues(input);
    const id = input.descriptionId!;
    return runConfigurationCommand(
      deps,
      actor,
      { name: "update_job_description", commandKey: input.commandKey },
      async (ctx) => {
        await authorizeConfiguration(ctx, actor, deps, "job_description.edit", {
          kind: "RECORD",
          id,
          sensitivity: "INTERNAL",
        });
        const row =
          (await findDescription(ctx.tx, id, "update")) ?? refuse("NOT_FOUND");
        if (row.version !== version) refuse("STALE_VERSION");
        // Published wording is immutable: edit a new draft instead.
        if (!descriptionEditable(row.status as DescriptionStatus))
          refuse("INVALID_TRANSITION");
        const changed =
          values.publicTitle !== row.publicTitle ||
          values.summary !== row.summary ||
          values.body !== row.body;
        if (!changed) return { targetId: id, version: row.version };
        const updated =
          (await updateDescriptionDraft(
            ctx.tx,
            id,
            version,
            values,
            ctx.actorId,
            ctx.now,
          )) ?? refuse("STALE_VERSION");
        ctx.events.push({
          code: "job_description.updated",
          recordRef: id,
          organizationRef: row.organizationId,
          previousVersion: row.version,
          newVersion: updated.version,
          changeCodes: ["CONTENT"],
        });
        return { targetId: id, version: updated.version };
      },
    );
  });
}

export function publishDescription(
  input: StatusInput,
  actor: ConfigurationActor,
  deps: ConfigurationDependencies = configurationDependencies(),
): Promise<ConfigurationResult> {
  return validated(async () => {
    if (!isUuid(input.targetId)) refuse("NOT_FOUND");
    const version = expectedVersion(input.expectedVersion);
    const reason = isMember(changeReasons, input.reasonCode)
      ? input.reasonCode
      : refuse("INVALID_INPUT");
    const id = input.targetId!;
    return runConfigurationCommand(
      deps,
      actor,
      { name: "publish_job_description", commandKey: input.commandKey },
      async (ctx) => {
        await authorizeConfiguration(
          ctx,
          actor,
          deps,
          "job_description.publish",
          { kind: "RECORD", id, sensitivity: "INTERNAL" },
          reason,
        );
        const draft =
          (await findDescription(ctx.tx, id, null)) ?? refuse("NOT_FOUND");
        // Lock order: position, then its description versions.
        const parent =
          (await findPosition(ctx.tx, draft.positionId, "update")) ??
          refuse("NOT_FOUND");
        if (!positionEditable(parent.status as PositionStatus))
          refuse("PARENT_NOT_ACTIVE");
        const locked =
          (await findDescription(ctx.tx, id, "update")) ?? refuse("NOT_FOUND");
        if (locked.version !== version) refuse("STALE_VERSION");
        if (locked.status !== "DRAFT") refuse("INVALID_TRANSITION");
        const current = await findDescriptionByStatus(
          ctx.tx,
          draft.positionId,
          "PUBLISHED",
          "update",
        );
        if (current) {
          const superseded =
            (await supersedeDescription(
              ctx.tx,
              current.id,
              ctx.actorId,
              ctx.now,
            )) ?? refuse("STALE_VERSION");
          ctx.events.push({
            code: "job_description.superseded",
            recordRef: current.id,
            organizationRef: current.organizationId,
            previousVersion: current.version,
            newVersion: superseded.version,
            reasonCode: reason,
          });
        }
        const published =
          (await publishDescriptionDraft(
            ctx.tx,
            id,
            version,
            ctx.actorId,
            ctx.now,
          )) ?? refuse("STALE_VERSION");
        ctx.events.push({
          code: "job_description.published",
          recordRef: id,
          organizationRef: locked.organizationId,
          previousVersion: locked.version,
          newVersion: published.version,
          reasonCode: reason,
        });
        return { targetId: id, version: published.version };
      },
    );
  });
}

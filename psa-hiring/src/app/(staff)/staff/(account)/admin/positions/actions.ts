"use server";

import { headers } from "next/headers";
import {
  changeBranchStatus,
  changeOrganizationStatus,
  changePositionStatus,
  changeTeamStatus,
  createBranch,
  createDescriptionDraft,
  createHiringCycle,
  createPosition,
  createTeam,
  publishDescription,
  staffActor,
  transitionHiringCycle,
  updateBranchDetails,
  updateDescriptionDraftContent,
  updateHiringCycleDraft,
  updateOrganizationDetails,
  updatePositionDetails,
  updateTeamDetails,
  type ConfigurationActor,
  type ConfigurationResult,
} from "@/modules/organization";
import { refuseConfigurationAccess } from "@/modules/identity-access/delivery/route-authorization";
import type { ConfigFormState } from "@/modules/organization/ui/config-form-state";
import { parseFormInput } from "@/shared/validation/form-input";
import { formSchemas } from "@/app/_auth/form-schemas";

// Same-origin Server Actions for /staff/admin/positions (packet M2.1 §15–§16;
// M1.5 §9, §13). Thin adapters: exact input (unknown fields reject), one
// named application command, a typed outcome → form state, step-up, or
// safe not-found. Each command resolves the staff principal again,
// authorizes inside its own transaction, and audits atomically; nothing
// here trusts a client-supplied status, ancestry, actor, time, or scope.

const fieldLabels: Readonly<Record<string, string>> = {
  code: "Code",
  legalName: "Legal name",
  displayName: "Display name",
  name: "Name",
  timezone: "Timezone",
  publicLocationLabel: "Public location label",
  internalTitle: "Internal title",
  publicTitle: "Public title",
  workerPathsAllowed: "Worker paths",
  summary: "Summary",
  body: "Description",
  internalLabel: "Internal label",
  publicLabel: "Public label",
  opensAt: "Opens at",
  closesAt: "Closes at",
  openEnded: "Open-ended",
};

const problemText: Readonly<Record<string, string>> = {
  REQUIRED: "enter a value.",
  TOO_LONG: "shorten this value.",
  UNSAFE_CONTENT:
    "use plain text only — remove markup, links, template symbols, and control characters.",
  INVALID_CODE: "use 2–32 letters, numbers, hyphens, or underscores.",
  INVALID_TIMEZONE: "choose a valid timezone, such as America/New_York.",
  INVALID_CHOICE: "choose one of the listed options.",
  INVALID: "enter a date and time.",
  NONEXISTENT_LOCAL_TIME:
    "that time does not exist in this timezone (clocks move forward); choose another time.",
  AMBIGUOUS_LOCAL_TIME:
    "that time occurs twice in this timezone (clocks move back); choose another time.",
  MUST_BE_AFTER_OPENS: "must be after the opening time.",
  MUST_BE_EMPTY_WHEN_OPEN_ENDED: "leave empty for an open-ended window.",
};

const refusalText: Readonly<Record<string, string>> = {
  STALE_VERSION:
    "This record changed after you opened it. Your entries are kept; reload the page to see the current version, then try again.",
  INVALID_TRANSITION:
    "This action is not available for the record's current status. Reload the page to see the current status.",
  PARENT_NOT_ACTIVE:
    "A parent organization, branch, team, or position is not active, so this cannot be done now.",
  DUPLICATE_CODE: "That code is already used here. Choose a different code.",
  DESCRIPTION_NOT_PUBLISHED:
    "Publish a job description for this position before publishing the hiring cycle.",
  WINDOW_INVALID:
    "The application window cannot be published: it must be coherent and close in the future.",
  WINDOW_NOT_OPEN:
    "The application window is not open now. A cycle can open only between its opening time (inclusive) and closing time (exclusive).",
  COMMAND_KEY_CONFLICT:
    "This form was already used for a different action. Reload the page and try again.",
  INVALID_INPUT: "Check the form and try again.",
};

const hiddenFields = new Set([
  "commandKey",
  "targetId",
  "expectedVersion",
  "organizationId",
  "branchId",
  "teamId",
  "positionId",
  "descriptionId",
  "cycleId",
]);

/** The values this user just typed (never hidden references). */
function echo(values: Readonly<Record<string, string | undefined>>) {
  return Object.fromEntries(
    Object.entries(values).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && !hiddenFields.has(entry[0]),
    ),
  );
}

async function actorOrRefuse(): Promise<ConfigurationActor> {
  const actor = await staffActor(await headers());
  if (!actor) return refuseConfigurationAccess("UNAUTHENTICATED");
  return actor;
}

function rejected(previous: ConfigFormState): ConfigFormState {
  return {
    status: "error",
    message: "The form could not be submitted. Reload the page and try again.",
    attempt: (previous.attempt ?? 0) + 1,
  };
}

function outcome(
  previous: ConfigFormState,
  result: ConfigurationResult,
  values: Readonly<Record<string, string | undefined>>,
  success: Readonly<{ message: string; next?: (targetId: string) => string }>,
): ConfigFormState {
  const attempt = (previous.attempt ?? 0) + 1;
  switch (result.kind) {
    case "DONE":
      return {
        status: "success",
        message: success.message,
        ...(success.next ? { next: success.next(result.targetId) } : {}),
        attempt,
      };
    case "INVALID_INPUT":
      return {
        status: "error",
        message: "Fix the highlighted fields and try again.",
        fieldErrors: Object.fromEntries(
          Object.entries(result.fields).map(([field, problem]) => [
            field,
            `${fieldLabels[field] ?? "Value"}: ${problemText[problem] ?? "check this value."}`,
          ]),
        ),
        values: echo(values),
        attempt,
      };
    case "REFUSED":
      switch (result.reason) {
        case "UNAUTHENTICATED":
          return refuseConfigurationAccess("UNAUTHENTICATED");
        case "REAUTHENTICATION_REQUIRED":
          return refuseConfigurationAccess("REAUTHENTICATION_REQUIRED");
        // Unknown, out-of-scope, and unauthorized records are one result.
        case "NOT_FOUND":
        case "NOT_AUTHORIZED":
          return refuseConfigurationAccess("NOT_FOUND");
        default:
          return {
            status: "error",
            message: refusalText[result.reason] ?? refusalText.INVALID_INPUT,
            values: echo(values),
            attempt,
          };
      }
  }
}

const base = "/staff/admin/positions";

// -------------------------------------------------------------- hierarchy

export async function updateOrganizationAction(
  previous: ConfigFormState,
  formData: FormData,
): Promise<ConfigFormState> {
  const input = parseFormInput(formData, formSchemas.organizationUpdate);
  if (input.kind === "REJECTED") return rejected(previous);
  const result = await updateOrganizationDetails(
    input.values,
    await actorOrRefuse(),
  );
  return outcome(previous, result, input.values, {
    message: "Organization saved.",
  });
}

export async function activateOrganizationAction(
  previous: ConfigFormState,
  formData: FormData,
): Promise<ConfigFormState> {
  const input = parseFormInput(formData, formSchemas.configurationStatus);
  if (input.kind === "REJECTED") return rejected(previous);
  const result = await changeOrganizationStatus(
    "activate",
    input.values,
    await actorOrRefuse(),
  );
  return outcome(previous, result, input.values, {
    message: "Organization activated.",
  });
}

export async function inactivateOrganizationAction(
  previous: ConfigFormState,
  formData: FormData,
): Promise<ConfigFormState> {
  const input = parseFormInput(formData, formSchemas.configurationStatus);
  if (input.kind === "REJECTED") return rejected(previous);
  const result = await changeOrganizationStatus(
    "inactivate",
    input.values,
    await actorOrRefuse(),
  );
  return outcome(previous, result, input.values, {
    message: "Organization inactivated.",
  });
}

export async function createBranchAction(
  previous: ConfigFormState,
  formData: FormData,
): Promise<ConfigFormState> {
  const input = parseFormInput(formData, formSchemas.branchCreate);
  if (input.kind === "REJECTED") return rejected(previous);
  const result = await createBranch(input.values, await actorOrRefuse());
  return outcome(previous, result, input.values, {
    message: "Draft branch created.",
  });
}

export async function updateBranchAction(
  previous: ConfigFormState,
  formData: FormData,
): Promise<ConfigFormState> {
  const input = parseFormInput(formData, formSchemas.branchUpdate);
  if (input.kind === "REJECTED") return rejected(previous);
  const result = await updateBranchDetails(input.values, await actorOrRefuse());
  return outcome(previous, result, input.values, {
    message: "Branch saved.",
  });
}

export async function activateBranchAction(
  previous: ConfigFormState,
  formData: FormData,
): Promise<ConfigFormState> {
  const input = parseFormInput(formData, formSchemas.configurationStatus);
  if (input.kind === "REJECTED") return rejected(previous);
  const result = await changeBranchStatus(
    "activate",
    input.values,
    await actorOrRefuse(),
  );
  return outcome(previous, result, input.values, {
    message: "Branch activated.",
  });
}

export async function inactivateBranchAction(
  previous: ConfigFormState,
  formData: FormData,
): Promise<ConfigFormState> {
  const input = parseFormInput(formData, formSchemas.configurationStatus);
  if (input.kind === "REJECTED") return rejected(previous);
  const result = await changeBranchStatus(
    "inactivate",
    input.values,
    await actorOrRefuse(),
  );
  return outcome(previous, result, input.values, {
    message: "Branch inactivated.",
  });
}

export async function createTeamAction(
  previous: ConfigFormState,
  formData: FormData,
): Promise<ConfigFormState> {
  const input = parseFormInput(formData, formSchemas.teamCreate);
  if (input.kind === "REJECTED") return rejected(previous);
  const result = await createTeam(input.values, await actorOrRefuse());
  return outcome(previous, result, input.values, {
    message: "Draft team created.",
  });
}

export async function updateTeamAction(
  previous: ConfigFormState,
  formData: FormData,
): Promise<ConfigFormState> {
  const input = parseFormInput(formData, formSchemas.teamUpdate);
  if (input.kind === "REJECTED") return rejected(previous);
  const result = await updateTeamDetails(input.values, await actorOrRefuse());
  return outcome(previous, result, input.values, { message: "Team saved." });
}

export async function activateTeamAction(
  previous: ConfigFormState,
  formData: FormData,
): Promise<ConfigFormState> {
  const input = parseFormInput(formData, formSchemas.configurationStatus);
  if (input.kind === "REJECTED") return rejected(previous);
  const result = await changeTeamStatus(
    "activate",
    input.values,
    await actorOrRefuse(),
  );
  return outcome(previous, result, input.values, {
    message: "Team activated.",
  });
}

export async function inactivateTeamAction(
  previous: ConfigFormState,
  formData: FormData,
): Promise<ConfigFormState> {
  const input = parseFormInput(formData, formSchemas.configurationStatus);
  if (input.kind === "REJECTED") return rejected(previous);
  const result = await changeTeamStatus(
    "inactivate",
    input.values,
    await actorOrRefuse(),
  );
  return outcome(previous, result, input.values, {
    message: "Team inactivated.",
  });
}

// --------------------------------------------------------------- positions

export async function createPositionAction(
  previous: ConfigFormState,
  formData: FormData,
): Promise<ConfigFormState> {
  const input = parseFormInput(formData, formSchemas.positionCreate);
  if (input.kind === "REJECTED") return rejected(previous);
  const result = await createPosition(input.values, await actorOrRefuse());
  return outcome(previous, result, input.values, {
    message: "Draft position created.",
    next: (id) => `${base}/${id}`,
  });
}

export async function updatePositionAction(
  previous: ConfigFormState,
  formData: FormData,
): Promise<ConfigFormState> {
  const input = parseFormInput(formData, formSchemas.positionUpdate);
  if (input.kind === "REJECTED") return rejected(previous);
  const result = await updatePositionDetails(
    input.values,
    await actorOrRefuse(),
  );
  return outcome(previous, result, input.values, {
    message: "Position saved.",
  });
}

export async function activatePositionAction(
  previous: ConfigFormState,
  formData: FormData,
): Promise<ConfigFormState> {
  const input = parseFormInput(formData, formSchemas.configurationStatus);
  if (input.kind === "REJECTED") return rejected(previous);
  const result = await changePositionStatus(
    "activate",
    input.values,
    await actorOrRefuse(),
  );
  return outcome(previous, result, input.values, {
    message: "Position activated.",
  });
}

export async function inactivatePositionAction(
  previous: ConfigFormState,
  formData: FormData,
): Promise<ConfigFormState> {
  const input = parseFormInput(formData, formSchemas.configurationStatus);
  if (input.kind === "REJECTED") return rejected(previous);
  const result = await changePositionStatus(
    "inactivate",
    input.values,
    await actorOrRefuse(),
  );
  return outcome(previous, result, input.values, {
    message: "Position inactivated.",
  });
}

export async function retirePositionAction(
  previous: ConfigFormState,
  formData: FormData,
): Promise<ConfigFormState> {
  const input = parseFormInput(formData, formSchemas.configurationStatus);
  if (input.kind === "REJECTED") return rejected(previous);
  const result = await changePositionStatus(
    "retire",
    input.values,
    await actorOrRefuse(),
  );
  return outcome(previous, result, input.values, {
    message: "Position retired.",
  });
}

// ------------------------------------------------- job-description versions

export async function createDescriptionDraftAction(
  previous: ConfigFormState,
  formData: FormData,
): Promise<ConfigFormState> {
  const input = parseFormInput(formData, formSchemas.descriptionCreate);
  if (input.kind === "REJECTED") return rejected(previous);
  const result = await createDescriptionDraft(
    input.values,
    await actorOrRefuse(),
  );
  const positionId = input.values.positionId ?? "";
  return outcome(previous, result, input.values, {
    message: "Draft description created.",
    next: (id) => `${base}/${positionId}/descriptions/${id}`,
  });
}

export async function updateDescriptionDraftAction(
  previous: ConfigFormState,
  formData: FormData,
): Promise<ConfigFormState> {
  const input = parseFormInput(formData, formSchemas.descriptionUpdate);
  if (input.kind === "REJECTED") return rejected(previous);
  const result = await updateDescriptionDraftContent(
    input.values,
    await actorOrRefuse(),
  );
  return outcome(previous, result, input.values, {
    message: "Draft description saved.",
  });
}

export async function publishDescriptionAction(
  previous: ConfigFormState,
  formData: FormData,
): Promise<ConfigFormState> {
  const input = parseFormInput(formData, formSchemas.configurationStatus);
  if (input.kind === "REJECTED") return rejected(previous);
  const result = await publishDescription(input.values, await actorOrRefuse());
  return outcome(previous, result, input.values, {
    message: "Description published.",
  });
}

// ------------------------------------------------------------ hiring cycles

/** "branchId" or "branchId/teamId" from the placement select. */
function placement(value: string | undefined) {
  const [branchId, teamId, extra] = (value ?? "").split("/");
  return extra === undefined
    ? { branchId, teamId: teamId ?? "" }
    : { branchId: "", teamId: "" };
}

export async function createHiringCycleAction(
  previous: ConfigFormState,
  formData: FormData,
): Promise<ConfigFormState> {
  const input = parseFormInput(formData, formSchemas.cycleCreate);
  if (input.kind === "REJECTED") return rejected(previous);
  const { placement: selected, ...rest } = input.values;
  const result = await createHiringCycle(
    { ...rest, ...placement(selected) },
    await actorOrRefuse(),
  );
  const positionId = input.values.positionId ?? "";
  return outcome(previous, result, input.values, {
    message: "Draft hiring cycle created.",
    next: (id) => `${base}/${positionId}/cycles/${id}`,
  });
}

export async function updateHiringCycleAction(
  previous: ConfigFormState,
  formData: FormData,
): Promise<ConfigFormState> {
  const input = parseFormInput(formData, formSchemas.cycleUpdate);
  if (input.kind === "REJECTED") return rejected(previous);
  const result = await updateHiringCycleDraft(
    input.values,
    await actorOrRefuse(),
  );
  return outcome(previous, result, input.values, {
    message: "Draft hiring cycle saved.",
  });
}

export async function publishHiringCycleAction(
  previous: ConfigFormState,
  formData: FormData,
): Promise<ConfigFormState> {
  const input = parseFormInput(formData, formSchemas.configurationStatus);
  if (input.kind === "REJECTED") return rejected(previous);
  const result = await transitionHiringCycle(
    "publish",
    input.values,
    await actorOrRefuse(),
  );
  return outcome(previous, result, input.values, {
    message: "Hiring cycle published.",
  });
}

export async function openHiringCycleAction(
  previous: ConfigFormState,
  formData: FormData,
): Promise<ConfigFormState> {
  const input = parseFormInput(formData, formSchemas.configurationStatus);
  if (input.kind === "REJECTED") return rejected(previous);
  const result = await transitionHiringCycle(
    "open",
    input.values,
    await actorOrRefuse(),
  );
  return outcome(previous, result, input.values, {
    message: "Hiring cycle opened.",
  });
}

export async function closeHiringCycleAction(
  previous: ConfigFormState,
  formData: FormData,
): Promise<ConfigFormState> {
  const input = parseFormInput(formData, formSchemas.configurationStatus);
  if (input.kind === "REJECTED") return rejected(previous);
  const result = await transitionHiringCycle(
    "close",
    input.values,
    await actorOrRefuse(),
  );
  return outcome(previous, result, input.values, {
    message: "Hiring cycle closed.",
  });
}

export async function cancelHiringCycleAction(
  previous: ConfigFormState,
  formData: FormData,
): Promise<ConfigFormState> {
  const input = parseFormInput(formData, formSchemas.configurationStatus);
  if (input.kind === "REJECTED") return rejected(previous);
  const result = await transitionHiringCycle(
    "cancel",
    input.values,
    await actorOrRefuse(),
  );
  return outcome(previous, result, input.values, {
    message: "Hiring cycle cancelled.",
  });
}

export async function archiveHiringCycleAction(
  previous: ConfigFormState,
  formData: FormData,
): Promise<ConfigFormState> {
  const input = parseFormInput(formData, formSchemas.configurationStatus);
  if (input.kind === "REJECTED") return rejected(previous);
  const result = await transitionHiringCycle(
    "archive",
    input.values,
    await actorOrRefuse(),
  );
  return outcome(previous, result, input.values, {
    message: "Hiring cycle archived.",
  });
}

"use server";

import { headers } from "next/headers";
import {
  dispatchApplicationEmails,
  returnApplication,
} from "@/modules/applications";
import {
  assignCandidacyOwner,
  assignCandidacyOwnerToSelf,
  closeProspect,
  candidateDependencies,
  createStaffProspect,
  mergePeople,
  queryCandidacyPath,
  releaseCandidacyOwner,
  reviewDuplicateMatch,
  setWorkItemDueDate,
  staffActorFrom,
  startApplicationFromProspect,
  type CandidateActor,
  type CandidateResult,
} from "@/modules/candidates";
import {
  refuseAccess,
  refuseIdentityReviewAccess,
} from "@/modules/identity-access/delivery/route-authorization";
import type { ConfigFormState } from "@/modules/organization/ui/config-form-state";
import { parseFormInput } from "@/shared/validation/form-input";
import { formSchemas } from "@/app/_auth/form-schemas";

// Same-origin Server Actions for M2.2 staff screens (packet M2.2 §13,
// §15, §17). Thin adapters: exact input (unknown fields reject — no person,
// owner, hierarchy, stage, status, match, or survivor field exists), one
// named command, typed outcome → form state, identity-review step-up, or
// the shared safe not-found. Nothing here reveals another record.

const fieldLabel: Readonly<Record<string, string>> = {
  legalFirstName: "Legal first name",
  legalMiddleName: "Middle name",
  legalLastName: "Legal last name",
  preferredName: "Preferred name",
  email: "Email",
  phone: "Phone",
  cycleReference: "Opening",
};
const problemText: Readonly<Record<string, string>> = {
  REQUIRED: "enter or choose a value.",
  TOO_LONG: "shorten this value.",
  INVALID_CHARACTERS:
    "use letters, spaces, apostrophes, hyphens, or periods only.",
  INVALID_EMAIL: "enter a valid email address.",
  INVALID_PHONE:
    "enter a phone number with digits, spaces, parentheses, or hyphens.",
};
const refusalText: Readonly<Record<string, string>> = {
  STALE_VERSION:
    "This record changed after you opened it. Reload the page to see the current version, then try again.",
  INVALID_TRANSITION:
    "This action is not available for the record's current state. Reload the page.",
  OPENING_UNAVAILABLE: "That opening is not accepting applications now.",
  COMMAND_KEY_CONFLICT:
    "This form was already used for a different request. Reload the page and try again.",
  INVALID_INPUT: "Check the form and try again.",
  OWNER_NOT_ELIGIBLE:
    "That person can't own this record. Reload the page and choose someone else.",
  RATE_LIMITED: "Too many attempts. Wait a few minutes, then try again.",
  BLOCKED_CASE_NOT_CONFIRMED: "Confirm the duplicate before merging.",
  BLOCKED_PERSON_NOT_ACTIVE:
    "One of these records is no longer active, so they cannot be merged.",
  BLOCKED_TWO_CANDIDATE_ACCOUNTS:
    "These records belong to two different candidate accounts. Merging them needs an approved account-reconciliation process; nothing was changed.",
  BLOCKED_CURRENT_CANDIDACY_COLLISION:
    "Both records have an active candidacy for the same opening. Close one of them first; nothing was changed.",
};

async function actor(): Promise<CandidateActor> {
  const staff = await staffActorFrom(await headers());
  if (!staff) return refuseAccess("UNAUTHENTICATED", "STAFF");
  return staff;
}

function rejected(previous: ConfigFormState): ConfigFormState {
  return {
    status: "error",
    message: "The form could not be submitted. Reload the page and try again.",
    attempt: (previous.attempt ?? 0) + 1,
  };
}

function echo(values: Readonly<Record<string, string | undefined>>) {
  return Object.fromEntries(
    Object.entries(values).filter(
      (e): e is [string, string] =>
        e[1] !== undefined &&
        !["commandKey", "candidacyId", "matchId", "expectedVersion"].includes(
          e[0],
        ),
    ),
  );
}

function outcome(
  previous: ConfigFormState,
  result: CandidateResult,
  values: Readonly<Record<string, string | undefined>>,
  success: Readonly<{ message: string; next?: (id: string) => string }>,
  review = false,
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
    case "UNCHANGED":
      return {
        status: "error",
        message:
          "A record with the same email address or phone number may already exist. To create this prospect anyway for manager review, tick the confirmation box and submit again.",
        values: echo(values),
        attempt,
      };
    case "INVALID_INPUT":
      return {
        status: "error",
        message: "Fix the highlighted fields and try again.",
        fieldErrors: Object.fromEntries(
          Object.entries(result.fields).map(([field, problem]) => [
            field,
            `${fieldLabel[field] ?? "Value"}: ${problemText[problem] ?? "check this value."}`,
          ]),
        ),
        values: echo(values),
        attempt,
      };
    case "REFUSED":
      switch (result.reason) {
        case "UNAUTHENTICATED":
          return refuseAccess("UNAUTHENTICATED", "STAFF");
        case "REAUTHENTICATION_REQUIRED":
          return review
            ? refuseIdentityReviewAccess("REAUTHENTICATION_REQUIRED")
            : refuseAccess("REAUTHENTICATION_REQUIRED", "STAFF");
        case "NOT_FOUND":
        case "NOT_AUTHORIZED":
          return refuseAccess("NOT_FOUND", "STAFF");
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

export async function createProspectAction(
  previous: ConfigFormState,
  formData: FormData,
): Promise<ConfigFormState> {
  const input = parseFormInput(formData, formSchemas.prospectCreate);
  if (input.kind === "REJECTED") return rejected(previous);
  const result = await createStaffProspect(input.values, await actor());
  const path =
    result.kind === "DONE" && result.targetId
      ? await queryCandidacyPath(await headers(), result.targetId)
      : null;
  return outcome(previous, result, input.values, {
    message: "Prospect created.",
    ...(path ? { next: () => path } : {}),
  });
}

export async function startApplicationFromProspectAction(
  previous: ConfigFormState,
  formData: FormData,
): Promise<ConfigFormState> {
  const input = parseFormInput(formData, formSchemas.candidacyCommand);
  if (input.kind === "REJECTED") return rejected(previous);
  const result = await startApplicationFromProspect(
    input.values,
    await actor(),
  );
  return outcome(previous, result, input.values, {
    message: "Application started.",
  });
}

export async function closeProspectAction(
  previous: ConfigFormState,
  formData: FormData,
): Promise<ConfigFormState> {
  const input = parseFormInput(formData, formSchemas.candidacyCommand);
  if (input.kind === "REJECTED") return rejected(previous);
  const result = await closeProspect(input.values, await actor());
  return outcome(previous, result, input.values, {
    message: "Prospect closed.",
  });
}

export async function assignOwnerToMeAction(
  previous: ConfigFormState,
  formData: FormData,
): Promise<ConfigFormState> {
  const input = parseFormInput(formData, formSchemas.candidacyCommand);
  if (input.kind === "REJECTED") return rejected(previous);
  const result = await assignCandidacyOwnerToSelf(input.values, await actor());
  return outcome(previous, result, input.values, {
    message: "You are now the owner.",
  });
}

export async function assignOwnerAction(
  previous: ConfigFormState,
  formData: FormData,
): Promise<ConfigFormState> {
  const input = parseFormInput(formData, formSchemas.workOwnerAssign);
  if (input.kind === "REJECTED") return rejected(previous);
  const result = await assignCandidacyOwner(input.values, await actor());
  return outcome(previous, result, input.values, {
    message: "Owner updated.",
  });
}

export async function releaseOwnerAction(
  previous: ConfigFormState,
  formData: FormData,
): Promise<ConfigFormState> {
  const input = parseFormInput(formData, formSchemas.candidacyCommand);
  if (input.kind === "REJECTED") return rejected(previous);
  const result = await releaseCandidacyOwner(input.values, await actor());
  return outcome(previous, result, input.values, {
    message: "This record is now unassigned.",
  });
}

export async function setDueDateAction(
  previous: ConfigFormState,
  formData: FormData,
): Promise<ConfigFormState> {
  const input = parseFormInput(formData, formSchemas.workDueDate);
  if (input.kind === "REJECTED") return rejected(previous);
  const result = await setWorkItemDueDate(input.values, await actor());
  return outcome(previous, result, input.values, {
    message: "Due date updated.",
  });
}

export async function reviewDuplicateAction(
  previous: ConfigFormState,
  formData: FormData,
): Promise<ConfigFormState> {
  const input = parseFormInput(formData, formSchemas.duplicateReview);
  if (input.kind === "REJECTED") return rejected(previous);
  const result = await reviewDuplicateMatch(input.values, await actor());
  return outcome(
    previous,
    result,
    input.values,
    { message: "Review recorded." },
    true,
  );
}

export async function mergePeopleAction(
  previous: ConfigFormState,
  formData: FormData,
): Promise<ConfigFormState> {
  const input = parseFormInput(formData, formSchemas.personMerge);
  if (input.kind === "REJECTED") return rejected(previous);
  const result = await mergePeople(input.values, await actor());
  return outcome(
    previous,
    result,
    input.values,
    {
      message: "Records merged. Both identities and all history are preserved.",
    },
    true,
  );
}

export async function returnApplicationAction(
  formData: FormData,
): Promise<Readonly<{ ok: boolean; message?: string }>> {
  const problem =
    "This application wasn't returned. Reload the page and try again.";
  const input = parseFormInput(formData, formSchemas.applicationReturn);
  if (input.kind === "REJECTED") return { ok: false, message: problem };
  const result = await returnApplication(input.values, await actor());
  if (result.kind === "DONE") {
    try {
      await dispatchApplicationEmails(candidateDependencies());
    } catch {
      // The row stays pending for the next dispatch.
    }
    return { ok: true };
  }
  if (result.kind === "REFUSED") {
    switch (result.reason) {
      case "UNAUTHENTICATED":
        return refuseAccess("UNAUTHENTICATED", "STAFF");
      case "NOT_FOUND":
      case "NOT_AUTHORIZED":
        return refuseAccess("NOT_FOUND", "STAFF");
      case "STALE_VERSION":
        return {
          ok: false,
          message:
            "This application changed after you opened it. Reload the page, then try again.",
        };
      case "INVALID_INPUT":
        return {
          ok: false,
          message:
            "Choose a reason and at least one section or attachments, and write instructions without unusual characters.",
        };
      case "RATE_LIMITED":
        return {
          ok: false,
          message: "Too many attempts. Wait a few minutes, then try again.",
        };
      default:
        return { ok: false, message: problem };
    }
  }
  return { ok: false, message: problem };
}

"use server";

import { headers } from "next/headers";
import {
  beginApplicationDraft,
  queryApplicationSection,
  saveApplicationSection,
} from "@/modules/applications";
import type {
  BeginDraftState,
  SaveSectionState,
} from "@/modules/applications/ui/application-form-state";
import { candidateActorFrom } from "@/modules/candidates";
import { refuseAccess } from "@/modules/identity-access/delivery/route-authorization";
import { parseFormInput } from "@/shared/validation/form-input";
import { formSchemas } from "@/app/_auth/form-schemas";

// Application-draft Server Actions (packet M2.4 §8). Thin adapters: exact
// input, one named command, and a closed result. The candidate supplies
// only a command key, references, an expected version, and their answers;
// the command derives ownership, state, actor, and time. Messages never
// echo an answer or reveal another record.

const problemText: Readonly<Record<string, string>> = {
  INVALID_FORMAT: "check this answer.",
  TOO_LONG: "shorten this answer.",
  INVALID_CHARACTERS: "remove unusual or invisible characters.",
  INVALID_EMAIL: "enter a valid email address.",
  INVALID_PHONE:
    "enter a phone number with digits, spaces, parentheses, or hyphens.",
  INVALID_DATE: "enter a valid date.",
  INVALID_CHOICE: "choose one of the listed options.",
};

const generalProblem =
  "Your request could not be completed. Reload the page and try again.";
const rateLimited = "Too many attempts. Wait a few minutes, then try again.";

export async function beginApplicationDraftAction(
  previous: BeginDraftState,
  formData: FormData,
): Promise<BeginDraftState> {
  const attempt = (previous.attempt ?? 0) + 1;
  const input = parseFormInput(formData, formSchemas.applicationBegin);
  if (input.kind === "REJECTED") {
    return { status: "error", message: generalProblem, attempt };
  }
  const actor = await candidateActorFrom(await headers());
  if (!actor) return refuseAccess("UNAUTHENTICATED", "CANDIDATE");
  const result = await beginApplicationDraft(input.values, actor);
  if (result.kind === "DONE") {
    return {
      status: "success",
      next: `/candidate/applications/${input.values.candidacyId}`,
      attempt,
    };
  }
  if (result.kind === "REFUSED") {
    if (result.reason === "UNAUTHENTICATED") {
      return refuseAccess("UNAUTHENTICATED", "CANDIDATE");
    }
    if (result.reason === "NOT_FOUND" || result.reason === "NOT_AUTHORIZED") {
      return refuseAccess("NOT_FOUND", "CANDIDATE");
    }
    if (result.reason === "TEMPLATE_UNAVAILABLE") {
      return {
        status: "error",
        message:
          "The application form isn't available right now. Please try again later.",
        attempt,
      };
    }
  }
  return { status: "error", message: generalProblem, attempt };
}

export async function saveApplicationSectionAction(
  formData: FormData,
): Promise<SaveSectionState> {
  const input = parseFormInput(formData, formSchemas.applicationSave);
  if (input.kind === "REJECTED") {
    return { status: "error", message: generalProblem };
  }
  const requestHeaders = await headers();
  const actor = await candidateActorFrom(requestHeaders);
  if (!actor) return refuseAccess("UNAUTHENTICATED", "CANDIDATE");
  const result = await saveApplicationSection(input.values, actor);
  switch (result.kind) {
    case "DONE": {
      const view = await queryApplicationSection(
        requestHeaders,
        input.values.candidacyId,
        input.values.sectionCode,
      );
      return view.kind === "OK"
        ? {
            status: "saved",
            version: result.version,
            sectionStatus: view.view.status,
            lastSaved: view.view.lastSaved,
          }
        : refuseAccess("NOT_FOUND", "CANDIDATE");
    }
    case "INVALID_INPUT":
      return {
        status: "invalid",
        message: "Your latest changes aren't saved yet. Fix these answers:",
        fieldErrors: Object.fromEntries(
          Object.entries(result.fields).map(([field, problem]) => [
            field,
            problemText[problem] ?? "check this answer.",
          ]),
        ),
      };
    case "REFUSED":
      switch (result.reason) {
        case "UNAUTHENTICATED":
          return refuseAccess("UNAUTHENTICATED", "CANDIDATE");
        case "NOT_FOUND":
        case "NOT_AUTHORIZED":
          return refuseAccess("NOT_FOUND", "CANDIDATE");
        case "STALE_VERSION":
          return {
            status: "conflict",
            message:
              "This section was changed somewhere else, such as another tab, so your latest changes weren't saved. Copy anything you need, then reload the page.",
          };
        case "RATE_LIMITED":
          return { status: "error", message: rateLimited };
        case "INVALID_TRANSITION":
          return {
            status: "error",
            message:
              "This application can no longer be edited. Reload the page to see its status.",
          };
        default:
          return { status: "error", message: generalProblem };
      }
    default:
      return { status: "error", message: generalProblem };
  }
}

"use server";

import { cookies, headers } from "next/headers";
import { applicationHandoffCookie } from "@/modules/identity-access";
import {
  refuseAccess,
  safeRedirect,
} from "@/modules/identity-access/delivery/route-authorization";
import { candidateActorFrom, startOwnCandidacy } from "@/modules/candidates";
import type { ConfigFormState } from "@/modules/organization/ui/config-form-state";
import { parseFormInput } from "@/shared/validation/form-input";
import { formSchemas } from "@/app/_auth/form-schemas";

// Candidate start-application action (packet M2.2 §12). Exact input: only
// the minimal name/phone fields and a server-issued command key. The
// opening comes from the signed HttpOnly handoff cookie read here, never
// from the form; ownership, hierarchy, stage, and worker path are decided
// by the command. Responses never mention any other person or record.

const fieldText: Readonly<Record<string, string>> = {
  REQUIRED: "enter a value.",
  TOO_LONG: "shorten this value.",
  INVALID_CHARACTERS:
    "use letters, spaces, apostrophes, hyphens, or periods only.",
  INVALID_PHONE:
    "enter a phone number with digits, spaces, parentheses, or hyphens.",
};
const fieldLabel: Readonly<Record<string, string>> = {
  legalFirstName: "Legal first name",
  legalMiddleName: "Middle name",
  legalLastName: "Legal last name",
  preferredName: "Preferred name",
  phone: "Phone",
};

export async function startOwnApplicationAction(
  previous: ConfigFormState,
  formData: FormData,
): Promise<ConfigFormState> {
  const attempt = (previous.attempt ?? 0) + 1;
  const input = parseFormInput(formData, formSchemas.candidateStart);
  if (input.kind === "REJECTED") {
    return {
      status: "error",
      message:
        "The form could not be submitted. Reload the page and try again.",
      attempt,
    };
  }
  const actor = await candidateActorFrom(await headers());
  if (!actor) return refuseAccess("UNAUTHENTICATED", "CANDIDATE");
  const store = await cookies();
  const cookie = applicationHandoffCookie();
  const result = await startOwnCandidacy(
    { ...input.values, handoffToken: store.get(cookie.name)?.value },
    actor,
  );
  const { commandKey: _key, ...values } = input.values;
  void _key;
  const echo = Object.fromEntries(
    Object.entries(values).filter(
      (e): e is [string, string] => e[1] !== undefined,
    ),
  );
  switch (result.kind) {
    case "DONE":
      store.delete(cookie.name);
      return safeRedirect("/candidate/applications/new?notice=started");
    case "INVALID_INPUT":
      return {
        status: "error",
        message: "Fix the highlighted fields and try again.",
        fieldErrors: Object.fromEntries(
          Object.entries(result.fields).map(([field, problem]) => [
            field,
            `${fieldLabel[field] ?? "Value"}: ${fieldText[problem] ?? "check this value."}`,
          ]),
        ),
        values: echo,
        attempt,
      };
    case "REFUSED":
      if (
        result.reason === "UNAUTHENTICATED" ||
        result.reason === "NOT_AUTHORIZED"
      ) {
        return refuseAccess("UNAUTHENTICATED", "CANDIDATE");
      }
      return {
        status: "error",
        message:
          result.reason === "OPENING_UNAVAILABLE"
            ? "This position is no longer accepting applications, or your link has expired. Choose a position again."
            : result.reason === "RATE_LIMITED"
              ? "Too many attempts. Wait a few minutes, then try again."
              : "Your request could not be completed. Reload the page and try again.",
        values: echo,
        attempt,
      };
    default:
      return {
        status: "error",
        message:
          "Your request could not be completed. Reload the page and try again.",
        attempt,
      };
  }
}

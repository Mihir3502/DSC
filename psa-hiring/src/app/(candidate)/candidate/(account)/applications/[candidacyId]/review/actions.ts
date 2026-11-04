"use server";

import { headers } from "next/headers";
import {
  dispatchApplicationEmails,
  submitApplication,
} from "@/modules/applications";
import {
  candidateActorFrom,
  candidateDependencies,
} from "@/modules/candidates";
import { refuseAccess } from "@/modules/identity-access/delivery/route-authorization";
import { parseFormInput } from "@/shared/validation/form-input";
import { formSchemas } from "@/app/_auth/form-schemas";

// Submitting an application (packet M2.6). A thin adapter over one named
// command. The confirmation email goes out after commit, and a delivery problem
// never undoes a submission; `pnpm outbox:dispatch` retries it.

export type SubmitState = Readonly<{ ok: boolean; message?: string }>;

const problem =
  "Your application wasn't submitted. Reload the page and try again.";

export async function submitApplicationAction(
  formData: FormData,
): Promise<SubmitState> {
  const input = parseFormInput(formData, formSchemas.applicationSubmit);
  if (input.kind === "REJECTED") return { ok: false, message: problem };
  const actor = await candidateActorFrom(await headers());
  if (!actor) return refuseAccess("UNAUTHENTICATED", "CANDIDATE");
  const result = await submitApplication(input.values, actor);
  if (result.kind === "DONE") {
    try {
      await dispatchApplicationEmails(candidateDependencies());
    } catch {
      // The row stays pending for the next dispatch.
    }
    return { ok: true };
  }
  if (result.kind === "INCOMPLETE") {
    return {
      ok: false,
      message:
        "Your application isn't complete yet. Reload this page to see what's missing.",
    };
  }
  if (result.kind === "REFUSED") {
    switch (result.reason) {
      case "UNAUTHENTICATED":
        return refuseAccess("UNAUTHENTICATED", "CANDIDATE");
      case "NOT_FOUND":
      case "NOT_AUTHORIZED":
        return refuseAccess("NOT_FOUND", "CANDIDATE");
      case "STALE_VERSION":
        return {
          ok: false,
          message:
            "Your application changed after this page opened. Reload it and check your answers before submitting.",
        };
      case "OPENING_UNAVAILABLE":
        return {
          ok: false,
          message:
            "This position is no longer accepting applications, so your application can't be submitted. Your draft is saved.",
        };
      case "INVALID_INPUT":
        return {
          ok: false,
          message:
            "Check the certification box and type your full name, then try again.",
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

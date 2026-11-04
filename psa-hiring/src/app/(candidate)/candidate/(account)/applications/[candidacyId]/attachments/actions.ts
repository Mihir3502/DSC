"use server";

import { headers } from "next/headers";
import { candidateActorFrom } from "@/modules/candidates";
import { removeApplicationAttachment } from "@/modules/documents";
import { refuseAccess } from "@/modules/identity-access/delivery/route-authorization";
import { parseFormInput } from "@/shared/validation/form-input";
import { formSchemas } from "@/app/_auth/form-schemas";

// Removing an attachment (packet M2.5). A thin adapter over one named command;
// the file and its history stay on record.

export async function removeAttachmentAction(
  formData: FormData,
): Promise<Readonly<{ ok: boolean; message?: string }>> {
  const problem =
    "This file could not be removed. Reload the page and try again.";
  const input = parseFormInput(formData, formSchemas.attachmentRemove);
  if (input.kind === "REJECTED") return { ok: false, message: problem };
  const actor = await candidateActorFrom(await headers());
  if (!actor) return refuseAccess("UNAUTHENTICATED", "CANDIDATE");
  const result = await removeApplicationAttachment(input.values, actor);
  if (result.kind === "DONE") return { ok: true };
  if (
    result.kind === "REFUSED" &&
    (result.reason === "NOT_FOUND" || result.reason === "NOT_AUTHORIZED")
  ) {
    return refuseAccess("NOT_FOUND", "CANDIDATE");
  }
  return { ok: false, message: problem };
}

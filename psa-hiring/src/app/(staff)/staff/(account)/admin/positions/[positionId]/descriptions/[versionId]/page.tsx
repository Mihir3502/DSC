import type { Metadata } from "next";
import Link from "next/link";
import { currentRequestHeaders } from "@/app/_auth/auth-messages";
import { newCommandKey, queryDescriptionDetail } from "@/modules/organization";
import { refuseConfigurationAccess } from "@/modules/identity-access/delivery/route-authorization";
import { ConfigForm } from "@/modules/organization/ui/config-form";
import { ConfirmCommand } from "@/modules/organization/ui/confirm-command";
import {
  changeReasonOptions,
  statusLabels,
} from "@/modules/organization/ui/labels";
import {
  publishDescriptionAction,
  updateDescriptionDraftAction,
} from "../../../actions";

// One job-description version (packet M2.1 §11, §16). Drafts are editable
// and publishable by authorized staff; published and superseded versions
// are shown read-only. Stored text is rendered only as escaped text.

export const metadata: Metadata = { title: "Job description" };
export const dynamic = "force-dynamic";

export default async function DescriptionPage({
  params,
}: PageProps<"/staff/admin/positions/[positionId]/descriptions/[versionId]">) {
  const { positionId, versionId } = await params;
  const result = await queryDescriptionDetail(
    await currentRequestHeaders(),
    positionId,
    versionId,
  );
  if (result.kind === "UNAUTHENTICATED") {
    refuseConfigurationAccess("UNAUTHENTICATED");
  }
  if (result.kind !== "OK") refuseConfigurationAccess("NOT_FOUND");
  const d = result.view;
  const draft = d.status === "DRAFT";
  const can = (action: string) => d.actions.includes(action);

  return (
    <div className="flex max-w-3xl flex-col gap-8">
      <Link
        href={`/staff/admin/positions/${d.positionId}`}
        className="underline underline-offset-4"
      >
        Back to {d.positionTitle}
      </Link>
      <div className="flex flex-col gap-2">
        <h1 className="text-3xl font-semibold tracking-tight">
          Job description, version {d.versionNumber}
        </h1>
        <p>
          <span className="font-medium">Status:</span> {statusLabels[d.status]}
        </p>
        {!draft ? (
          <p className="rounded-lg border p-3">
            This version is published history and cannot be edited. Create a new
            draft from the position page to change the wording.
          </p>
        ) : null}
      </div>

      {draft && can("job_description_publish") ? (
        <ConfirmCommand
          action={publishDescriptionAction}
          label="Publish description"
          title="Publish this description version?"
          recordLabel={`${d.publicTitle} (version ${d.versionNumber})`}
          result="Published; the previous published version becomes superseded"
          consequence="Published wording is frozen. New hiring cycles will use it; cycles already published keep the version they captured."
          reasons={changeReasonOptions}
          hidden={{
            commandKey: newCommandKey(),
            targetId: d.id,
            expectedVersion: String(d.version),
          }}
        />
      ) : null}

      {draft && can("job_description_edit") ? (
        <ConfigForm
          action={updateDescriptionDraftAction}
          title="Edit draft"
          submitLabel="Save draft"
          hidden={{
            commandKey: newCommandKey(),
            positionId: d.positionId,
            descriptionId: d.id,
            expectedVersion: String(d.version),
          }}
          fields={[
            {
              kind: "text",
              name: "publicTitle",
              label: "Public title",
              defaultValue: d.publicTitle,
              maxLength: 120,
            },
            {
              kind: "textarea",
              name: "summary",
              label: "Summary",
              defaultValue: d.summary,
              maxLength: 500,
              rows: 3,
            },
            {
              kind: "textarea",
              name: "body",
              label: "Description",
              hint: "Plain text only. Separate paragraphs with a blank line; start lines with “- ” for a list.",
              defaultValue: d.body,
              maxLength: 8000,
              rows: 14,
            },
          ]}
        />
      ) : (
        <section
          aria-labelledby="content-heading"
          className="flex flex-col gap-3"
        >
          <h2 id="content-heading" className="text-xl font-semibold">
            {d.publicTitle}
          </h2>
          <p>{d.summary}</p>
          <div className="whitespace-pre-line rounded-lg border p-4">
            {d.body}
          </div>
        </section>
      )}
    </div>
  );
}

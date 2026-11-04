import type { Metadata } from "next";
import Link from "next/link";
import { currentRequestHeaders } from "@/app/_auth/auth-messages";
import {
  attachmentCategories,
  queryApplicationAttachments,
} from "@/modules/documents";
import { AttachmentPanel } from "@/modules/documents/ui/attachment-panel";
import { newCandidateCommandKey } from "@/modules/candidates";
import { refuseAccess } from "@/modules/identity-access/delivery/route-authorization";
import { removeAttachmentAction } from "./actions";

// Application attachments (packet M2.5; UI_FLOW §7.3). The title stays generic,
// so no file name reaches the browser tab or history.

export const metadata: Metadata = { title: "Application attachments" };
export const dynamic = "force-dynamic";

export default async function ApplicationAttachmentsPage({
  params,
}: PageProps<"/candidate/applications/[candidacyId]/attachments">) {
  const { candidacyId } = await params;
  const result = await queryApplicationAttachments(
    await currentRequestHeaders(),
    candidacyId,
  );
  if (result.kind !== "OK") {
    return refuseAccess(
      result.kind === "UNAUTHENTICATED" ? "UNAUTHENTICATED" : "NOT_FOUND",
      "CANDIDATE",
    );
  }
  const view = result.view;
  return (
    <div className="flex max-w-2xl flex-col gap-6">
      <h1 className="text-3xl font-semibold tracking-tight">Attachments</h1>
      <p>
        You can add a resume and any licenses or certifications. Attachments are
        optional.
      </p>
      <p>
        Accepted files: PDF, JPEG, or PNG, up to 10 MB each and 10 in total.
        Please don&apos;t upload ID, tax, banking, or medical documents.
      </p>
      <AttachmentPanel
        view={view}
        categories={attachmentCategories}
        commandKey={newCandidateCommandKey()}
        removeAction={removeAttachmentAction}
      />
      <p>
        <Link
          prefetch={false}
          href={`/candidate/applications/${view.candidacyId}`}
          className="underline underline-offset-4"
        >
          Back to application overview
        </Link>
      </p>
    </div>
  );
}

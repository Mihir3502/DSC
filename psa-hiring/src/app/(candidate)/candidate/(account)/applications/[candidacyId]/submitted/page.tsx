import type { Metadata } from "next";
import Link from "next/link";
import { currentRequestHeaders } from "@/app/_auth/auth-messages";
import { queryApplicationReceipt } from "@/modules/applications";
import { refuseAccess } from "@/modules/identity-access/delivery/route-authorization";

// Submission receipt (packet M2.6). Read from the frozen record, so it can't
// drift from what was submitted.

export const metadata: Metadata = { title: "Application receipt" };
export const dynamic = "force-dynamic";

export default async function ApplicationReceiptPage({
  params,
}: PageProps<"/candidate/applications/[candidacyId]/submitted">) {
  const { candidacyId } = await params;
  const result = await queryApplicationReceipt(
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
      <h1 className="text-3xl font-semibold tracking-tight">
        We received your application
      </h1>
      <p>
        Keep this receipt for your records. We&apos;ll contact you if we need
        anything else.
      </p>
      <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-1 [overflow-wrap:anywhere]">
        <dt className="font-medium">Receipt number</dt>
        <dd className="font-mono">{view.receiptNumber}</dd>
        <dt className="font-medium">Reference</dt>
        <dd className="font-mono">{view.reference}</dd>
        <dt className="font-medium">Position</dt>
        <dd>{view.title}</dd>
        <dt className="font-medium">Submitted</dt>
        <dd>{view.submitted}</dd>
        <dt className="font-medium">Certified by</dt>
        <dd>{view.certifiedName}</dd>
        <dt className="font-medium">Certification version</dt>
        <dd>{view.certificationVersion}</dd>
        <dt className="font-medium">Sections</dt>
        <dd>{view.sectionCount}</dd>
        <dt className="font-medium">Attachments</dt>
        <dd>{view.attachmentCount}</dd>
      </dl>
      <p>
        <Link
          prefetch={false}
          href="/candidate"
          className="underline underline-offset-4"
        >
          Back to home
        </Link>
      </p>
    </div>
  );
}

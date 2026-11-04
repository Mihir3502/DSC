import type { Metadata } from "next";
import Link from "next/link";
import { queryApplicationOverview } from "@/modules/applications";
import { BeginApplicationForm } from "@/modules/applications/ui/begin-application-form";
import { newCandidateCommandKey } from "@/modules/candidates";
import { currentRequestHeaders } from "@/app/_auth/auth-messages";
import { refuseAccess } from "@/modules/identity-access/delivery/route-authorization";
import { beginApplicationDraftAction } from "./actions";

// The candidate's application overview (packet M2.4). Reading this page
// never writes: a draft begins only through its command. Unknown and
// not-owned references get the same safe not-found.

export const metadata: Metadata = { title: "Your application" };
export const dynamic = "force-dynamic";

export default async function ApplicationOverviewPage({
  params,
}: PageProps<"/candidate/applications/[candidacyId]">) {
  const { candidacyId } = await params;
  const result = await queryApplicationOverview(
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
  const base = `/candidate/applications/${view.candidacyId}`;
  return (
    <div className="flex max-w-2xl flex-col gap-6">
      <h1 className="text-3xl font-semibold tracking-tight">
        Your application
      </h1>
      <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-1 [overflow-wrap:anywhere]">
        <dt className="font-medium">Position</dt>
        <dd>{view.title}</dd>
        <dt className="font-medium">Location</dt>
        <dd>{view.location}</dd>
        <dt className="font-medium">Reference</dt>
        <dd className="font-mono">{view.reference}</dd>
        <dt className="font-medium">Status</dt>
        <dd>{view.status}</dd>
      </dl>

      {!view.editable ? (
        <p role="status" className="rounded-lg border p-4">
          This application can&apos;t be edited right now.
        </p>
      ) : !view.started ? (
        <>
          <p>
            Your application has {view.sections.length} sections. You can save
            your answers and come back to them. Nothing is submitted until you
            choose to submit it.
          </p>
          <BeginApplicationForm
            action={beginApplicationDraftAction}
            candidacyId={view.candidacyId}
            commandKey={newCandidateCommandKey()}
          />
        </>
      ) : (
        <>
          <p role="status">
            {view.completeCount} of {view.sections.length} sections complete.
            {view.lastSaved ? ` Last saved ${view.lastSaved}.` : ""} Nothing has
            been submitted yet.
          </p>
          <ol className="flex flex-col gap-3">
            {view.sections.map((section) => (
              <li key={section.code} className="rounded-lg border p-4">
                <h2 className="font-semibold">
                  <Link
                    prefetch={false}
                    href={`${base}/${section.code}`}
                    className="underline underline-offset-4"
                  >
                    {section.title}
                  </Link>
                </h2>
                <p className="text-sm">{section.description}</p>
                <p className="text-sm">
                  Status: <span className="font-medium">{section.status}</span>
                </p>
              </li>
            ))}
          </ol>
          <section className="rounded-lg border p-4">
            <h2 className="font-semibold">
              <Link
                prefetch={false}
                href={`${base}/attachments`}
                className="underline underline-offset-4"
              >
                Attachments
              </Link>
            </h2>
            <p className="text-sm">
              Add a resume and any licenses or certifications. Optional.
            </p>
          </section>
        </>
      )}
    </div>
  );
}

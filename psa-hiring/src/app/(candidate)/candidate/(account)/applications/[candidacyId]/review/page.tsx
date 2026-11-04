import type { Metadata } from "next";
import Link from "next/link";
import { currentRequestHeaders } from "@/app/_auth/auth-messages";
import { queryApplicationReview } from "@/modules/applications";
import { SubmitApplicationForm } from "@/modules/applications/ui/submit-application-form";
import { newCandidateCommandKey } from "@/modules/candidates";
import { refuseAccess } from "@/modules/identity-access/delivery/route-authorization";
import { submitApplicationAction } from "./actions";

// Review and certification (packet M2.6; UI_FLOW §7.4). It shows exactly what
// will be frozen. Reading it never writes.

export const metadata: Metadata = { title: "Review your application" };
export const dynamic = "force-dynamic";

export default async function ApplicationReviewPage({
  params,
}: PageProps<"/candidate/applications/[candidacyId]/review">) {
  const { candidacyId } = await params;
  const result = await queryApplicationReview(
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
        Review your application
      </h1>
      <p className="[overflow-wrap:anywhere]">
        {view.title} · <span className="font-mono">{view.reference}</span>
      </p>

      {view.sections.map((section) => (
        <section
          key={section.code}
          aria-labelledby={`review-${section.code}`}
          className="flex flex-col gap-2 rounded-lg border p-4 [overflow-wrap:anywhere]"
        >
          <h2 id={`review-${section.code}`} className="text-xl font-semibold">
            {section.title}
          </h2>
          <p className="text-sm">
            Status:{" "}
            <span className="font-medium">
              {section.complete ? "Complete" : "Needs answers"}
            </span>
          </p>
          {section.missing.length > 0 ? (
            <div>
              <p className="font-medium">Still needed:</p>
              <ul className="list-disc pl-5">
                {section.missing.map((label) => (
                  <li key={label}>{label}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {section.answers.length > 0 ? (
            <dl className="flex flex-col gap-2">
              {section.answers.map((answer) => (
                <div key={answer.label}>
                  <dt className="font-medium">{answer.label}</dt>
                  <dd className="whitespace-pre-wrap">{answer.value}</dd>
                </div>
              ))}
            </dl>
          ) : null}
          <p className="print:hidden">
            <Link
              prefetch={false}
              href={`${base}/${section.code}`}
              className="inline-flex min-h-11 items-center underline underline-offset-4"
            >
              Edit {section.title}
            </Link>
          </p>
        </section>
      ))}

      <section
        aria-labelledby="review-attachments"
        className="flex flex-col gap-2 rounded-lg border p-4 [overflow-wrap:anywhere]"
      >
        <h2 id="review-attachments" className="text-xl font-semibold">
          Attachments
        </h2>
        {view.attachments.length === 0 ? (
          <p>No files will be included.</p>
        ) : (
          <ul className="list-disc pl-5">
            {view.attachments.map((file) => (
              <li key={`${file.name}-${file.size}`}>
                {file.name} ({file.category}, {file.size})
              </li>
            ))}
          </ul>
        )}
        {view.excludedAttachments.length > 0 ? (
          <div>
            <p className="font-medium">These files won&apos;t be included:</p>
            <ul className="list-disc pl-5">
              {view.excludedAttachments.map((file) => (
                <li key={file.name}>
                  {file.name} ({file.status})
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        <p className="print:hidden">
          <Link
            prefetch={false}
            href={`${base}/attachments`}
            className="inline-flex min-h-11 items-center underline underline-offset-4"
          >
            Change attachments
          </Link>
        </p>
      </section>

      <SubmitApplicationForm
        action={submitApplicationAction}
        candidacyId={view.candidacyId}
        commandKey={newCandidateCommandKey()}
        complete={view.complete}
        accepting={view.accepting}
        statement={view.certification.statement}
        certificationVersion={view.certification.version}
        reviewToken={view.reviewToken}
      />
    </div>
  );
}

import type { Metadata } from "next";
import { currentRequestHeaders } from "@/app/_auth/auth-messages";
import { queryStaffApplicationReview } from "@/modules/applications";
import { returnReasons } from "@/modules/applications/domain/application-template";
import { StaffReturnForm } from "@/modules/applications/ui/staff-return-form";
import { newCandidateCommandKey } from "@/modules/candidates";
import { refuseAccess } from "@/modules/identity-access/delivery/route-authorization";
import { returnApplicationAction } from "../../actions";

// The submitted application, exactly as frozen (packet M2.7). The title stays
// generic, so no name or reference reaches the browser tab.

export const metadata: Metadata = { title: "Submitted application" };
export const dynamic = "force-dynamic";

export default async function StaffApplicationPage({
  params,
}: PageProps<"/staff/candidates/[candidacyId]/application">) {
  const { candidacyId } = await params;
  const result = await queryStaffApplicationReview(
    await currentRequestHeaders(),
    candidacyId,
  );
  if (result.kind !== "OK") {
    return refuseAccess(
      result.kind === "UNAUTHENTICATED" ? "UNAUTHENTICATED" : "NOT_FOUND",
      "STAFF",
    );
  }
  const view = result.view;
  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <h2 className="text-2xl font-semibold tracking-tight">
        Submitted application
      </h2>
      <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-1 [overflow-wrap:anywhere]">
        <dt className="font-medium">Reference</dt>
        <dd className="font-mono">{view.reference}</dd>
        <dt className="font-medium">Position</dt>
        <dd>{view.title}</dd>
        <dt className="font-medium">Submitted</dt>
        <dd>{view.submitted}</dd>
        <dt className="font-medium">Receipt</dt>
        <dd className="font-mono">{view.receiptNumber}</dd>
        <dt className="font-medium">Certified by</dt>
        <dd>{view.certifiedName}</dd>
        <dt className="font-medium">Certification version</dt>
        <dd>{view.certificationVersion}</dd>
      </dl>

      {view.sections.map((section) => (
        <section
          key={section.code}
          aria-labelledby={`frozen-${section.code}`}
          className="flex flex-col gap-2 rounded-lg border p-4 [overflow-wrap:anywhere]"
        >
          <h3 id={`frozen-${section.code}`} className="text-xl font-semibold">
            {section.title}
          </h3>
          <dl className="flex flex-col gap-2">
            {section.fields.map((field) => (
              <div key={field.code}>
                <dt className="font-medium">{field.label}</dt>
                <dd className="whitespace-pre-wrap">
                  {field.value ?? "Not answered"}
                </dd>
              </div>
            ))}
          </dl>
        </section>
      ))}

      <section
        aria-labelledby="frozen-attachments"
        className="flex flex-col gap-2 rounded-lg border p-4 [overflow-wrap:anywhere]"
      >
        <h3 id="frozen-attachments" className="text-xl font-semibold">
          Attachments
        </h3>
        {view.attachments.length === 0 ? (
          <p>No files were included.</p>
        ) : (
          <ul className="list-disc pl-5">
            {view.attachments.map((file) => (
              <li key={`${file.name}-${file.size}`}>
                {file.name} ({file.category}, {file.size})
              </li>
            ))}
          </ul>
        )}
      </section>

      {view.earlierReturns.length > 0 ? (
        <section
          aria-labelledby="earlier-returns"
          className="flex flex-col gap-2"
        >
          <h3 id="earlier-returns" className="text-xl font-semibold">
            Earlier returns
          </h3>
          <ul className="flex flex-col gap-2">
            {view.earlierReturns.map((item) => (
              <li
                key={item.when}
                className="rounded-lg border p-3 [overflow-wrap:anywhere]"
              >
                <p className="font-medium">
                  {item.reason} · {item.when}
                </p>
                <p className="whitespace-pre-wrap">{item.instructions}</p>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {view.awaitingCorrection ? (
        <p role="status" className="rounded-lg border p-4">
          Application returned. Waiting for the candidate to correct and submit
          it. This page shows what they last submitted.
        </p>
      ) : null}

      {view.canReturn ? (
        <StaffReturnForm
          action={returnApplicationAction}
          candidacyId={view.candidacyId}
          version={view.version}
          commandKey={newCandidateCommandKey()}
          sections={view.sections.map(({ code, title, fields }) => ({
            code,
            title,
            fields: fields.map((f) => ({ code: f.code, label: f.label })),
          }))}
          reasons={returnReasons}
        />
      ) : null}
    </div>
  );
}

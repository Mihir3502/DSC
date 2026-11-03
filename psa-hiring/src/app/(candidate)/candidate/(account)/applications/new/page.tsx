import type { Metadata } from "next";
import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";
import { cookies } from "next/headers";
import { currentRequestHeaders } from "@/app/_auth/auth-messages";
import { applicationHandoffCookie } from "@/modules/identity-access";
import { refuseAccess } from "@/modules/identity-access/delivery/route-authorization";
import {
  newCandidateCommandKey,
  queryCandidateStart,
} from "@/modules/candidates";
import { ConfigForm } from "@/modules/organization/ui/config-form";
import { startOwnApplicationAction } from "./actions";

// Candidate start-application page (packet M2.2 §12, §18.1). Shows the
// opening named by the signed handoff, asks for minimal details only when
// no canonical person is linked yet, and reports the candidate's own
// candidacy. It never reveals any other person, account, candidacy, or
// duplicate review. Not a portal: no dashboard or navigation (M2.3).

export const metadata: Metadata = { title: "Start your application" };
export const dynamic = "force-dynamic";

export default async function ApplicationStartPage({
  searchParams,
}: PageProps<"/candidate/applications/new">) {
  const { notice } = await searchParams;
  const started = notice === "started";
  const token = (await cookies()).get(applicationHandoffCookie().name)?.value;
  const result = await queryCandidateStart(
    await currentRequestHeaders(),
    started ? undefined : token,
    {
      latest: started,
    },
  );
  if (result.kind !== "OK") {
    refuseAccess(
      result.kind === "UNAUTHENTICATED" ? "UNAUTHENTICATED" : "NOT_FOUND",
      "CANDIDATE",
    );
  }
  const view = result.view;

  if (started && view.own) {
    return (
      <div className="flex max-w-2xl flex-col gap-6">
        <h1 className="text-3xl font-semibold tracking-tight">
          Application started
        </h1>
        <div
          role="status"
          className="flex flex-col gap-2 rounded-lg border p-4"
        >
          <p className="font-medium">
            Your application for {view.own.title} has started.
          </p>
          <p>
            Your reference is{" "}
            <span className="font-mono">{view.own.reference}</span>. Status:{" "}
            {view.own.status}.
          </p>
          <p>Nothing has been submitted yet.</p>
        </div>
        <Link
          href={`/candidate/applications/${view.own.candidacyId}`}
          className={buttonVariants({ size: "lg" })}
        >
          Continue your application
        </Link>
      </div>
    );
  }

  if (!view.opening) {
    return (
      <div className="flex max-w-2xl flex-col gap-6">
        <h1 className="text-3xl font-semibold tracking-tight">
          Start your application
        </h1>
        <p role="status" className="rounded-lg border p-4">
          Choose a position that is accepting applications to start. If you
          followed a link, it may have expired or the position may no longer be
          accepting applications.
        </p>
        <Link href="/positions" className="underline underline-offset-4">
          See open positions
        </Link>
      </div>
    );
  }

  if (view.own) {
    return (
      <div className="flex max-w-2xl flex-col gap-6">
        <h1 className="text-3xl font-semibold tracking-tight">
          Start your application
        </h1>
        <div
          role="status"
          className="flex flex-col gap-2 rounded-lg border p-4"
        >
          <p className="font-medium">
            You have already started an application for {view.opening.title}.
          </p>
          <p>
            Your reference is{" "}
            <span className="font-mono">{view.own.reference}</span>. Status:{" "}
            {view.own.status}.
          </p>
        </div>
        <Link
          href={`/candidate/applications/${view.own.candidacyId}`}
          className={buttonVariants({ size: "lg" })}
        >
          Continue your application
        </Link>
      </div>
    );
  }

  return (
    <div className="flex max-w-2xl flex-col gap-6">
      <h1 className="text-3xl font-semibold tracking-tight">
        Start your application
      </h1>
      <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-1 [overflow-wrap:anywhere]">
        <dt className="font-medium">Position</dt>
        <dd>{view.opening.title}</dd>
        <dt className="font-medium">Location</dt>
        <dd>{view.opening.location}</dd>
        {view.opening.closes ? (
          <>
            <dt className="font-medium">Applications close</dt>
            <dd>{view.opening.closes}</dd>
          </>
        ) : null}
      </dl>
      <p>
        Continuing starts an application process for this position. You will
        complete and submit the application itself in a later step.
      </p>
      <ConfigForm
        action={startOwnApplicationAction}
        title={view.needsPersonDetails ? "Your details" : "Confirm"}
        submitLabel="Start application"
        hidden={{ commandKey: newCandidateCommandKey() }}
        fields={
          view.needsPersonDetails
            ? [
                {
                  kind: "text",
                  name: "legalFirstName",
                  label: "Legal first name",
                  maxLength: 100,
                  required: true,
                  autoComplete: "given-name",
                },
                {
                  kind: "text",
                  name: "legalMiddleName",
                  label: "Middle name (optional)",
                  maxLength: 100,
                  autoComplete: "additional-name",
                },
                {
                  kind: "text",
                  name: "legalLastName",
                  label: "Legal last name",
                  maxLength: 100,
                  required: true,
                  autoComplete: "family-name",
                },
                {
                  kind: "text",
                  name: "preferredName",
                  label: "Preferred name (optional)",
                  maxLength: 100,
                  autoComplete: "nickname",
                },
                {
                  kind: "text",
                  name: "phone",
                  label: "Phone (optional)",
                  hint: "We use the email address on your account to contact you.",
                  maxLength: 40,
                  autoComplete: "tel",
                },
              ]
            : []
        }
      />
    </div>
  );
}

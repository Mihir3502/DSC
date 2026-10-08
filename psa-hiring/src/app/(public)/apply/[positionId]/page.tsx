import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { queryHandoffOpening } from "@/modules/organization";
import { StartApplicationForm } from "@/modules/organization/ui/start-application-form";
import { startApplicationAction } from "./actions";

// Start-application confirmation (packet M2.1 §19). Re-reads the opening
// without the public cache. Unknown and non-public references are the
// same not-found as the detail page; a closed opening shows the generic
// no-longer-accepting state. Private, no-store (protected path prefix).

export const metadata: Metadata = { title: "Start application" };
export const dynamic = "force-dynamic";

export default async function StartApplicationPage({
  params,
}: PageProps<"/apply/[positionId]">) {
  const result = await queryHandoffOpening((await params).positionId);
  if (result.kind !== "FOUND") notFound();
  const view = result.view;

  if (view.availability !== "ACCEPTING") {
    return (
      <div className="flex max-w-2xl flex-col gap-4">
        <h1 className="text-3xl font-semibold tracking-tight">
          This position is no longer accepting applications
        </h1>
        <Link href="/positions" className="underline underline-offset-4">
          See positions that are open now
        </Link>
      </div>
    );
  }

  return (
    <div className="flex max-w-2xl flex-col gap-6">
      <h1 className="text-3xl font-semibold tracking-tight">
        Start your application
      </h1>
      <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1">
        <dt className="font-medium">Position</dt>
        <dd>{view.title}</dd>
        <dt className="font-medium">Location</dt>
        <dd>{view.location}</dd>
        {view.closes ? (
          <>
            <dt className="font-medium">Deadline</dt>
            <dd>{view.closes}</dd>
          </>
        ) : null}
      </dl>
      <p>
        Next, sign in to your candidate account or create one. Continuing does
        not submit an application, and nothing is shared with the agency until
        you submit an application yourself.
      </p>
      <StartApplicationForm
        action={startApplicationAction}
        reference={view.reference}
      />
      <p className="text-sm">
        No account yet?{" "}
        <Link href="/register" className="underline underline-offset-4">
          Create a candidate account
        </Link>
        , then sign in to continue.
      </p>
    </div>
  );
}

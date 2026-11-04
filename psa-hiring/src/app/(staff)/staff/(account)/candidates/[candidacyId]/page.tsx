import type { Metadata } from "next";
import Link from "next/link";
import { currentRequestHeaders } from "@/app/_auth/auth-messages";
import {
  NO_BLOCKERS_MESSAGE,
  newCandidateCommandKey,
  prospectCloseReasons,
  queryCandidateOverview,
  queryProspectDetail,
} from "@/modules/candidates";
import { refuseAccess } from "@/modules/identity-access/delivery/route-authorization";
import { ConfirmCommand } from "@/modules/organization/ui/confirm-command";
import {
  assignOwnerToMeAction,
  closeProspectAction,
  startApplicationFromProspectAction,
} from "../actions";

// Workspace Overview (packets M2.2 §18.2, M3.2): blockers and a timeline for
// anyone who may open the workspace. Contact details and prospect actions show
// only when the separate prospect query allows them. Every action re-authorizes
// on the server with the rendered version. The title and URL carry no PII.

export const metadata: Metadata = { title: "Candidate overview" };

const dateFormat = new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "UTC",
});
const formatInstant = (iso: string) =>
  `${dateFormat.format(new Date(iso))} UTC`;
export const dynamic = "force-dynamic";

const closeLabels: Readonly<
  Record<(typeof prospectCloseReasons)[number], string>
> = {
  NOT_INTERESTED: "Not interested",
  UNREACHABLE: "Unreachable",
  DUPLICATE_RECORD: "Duplicate record",
  NOT_QUALIFIED: "Does not meet minimum qualifications",
};

export default async function ProspectDetailPage({
  params,
}: PageProps<"/staff/candidates/[candidacyId]">) {
  const { candidacyId } = await params;
  const requestHeaders = await currentRequestHeaders();
  const overview = await queryCandidateOverview(requestHeaders, candidacyId);
  if (overview.kind === "UNAUTHENTICATED") {
    refuseAccess("UNAUTHENTICATED", "STAFF");
  }
  if (overview.kind !== "OK") refuseAccess("NOT_FOUND", "STAFF");
  // Only some workspace readers may see contact details and prospect actions.
  const detail = await queryProspectDetail(requestHeaders, candidacyId);
  const view = detail.kind === "OK" ? detail.view : null;
  const hidden: Readonly<Record<string, string>> = view
    ? {
        commandKey: newCandidateCommandKey(),
        candidacyId: view.id,
        expectedVersion: String(view.version),
      }
    : {};
  const open = view?.status === "Active" && view.stage === "Prospect";

  return (
    <div className="flex flex-col gap-8">
      <section aria-labelledby="blockers" className="flex flex-col gap-3">
        <h2 id="blockers" className="text-xl font-semibold">
          What&apos;s holding this up
        </h2>
        {overview.view.blockers.length === 0 ? (
          <p>{NO_BLOCKERS_MESSAGE}</p>
        ) : (
          <ul className="flex list-disc flex-col gap-1 pl-6">
            {overview.view.blockers.map((blocker) => (
              <li key={blocker.code}>{blocker.label}</li>
            ))}
          </ul>
        )}
        {overview.view.canManageWork ? (
          <p>
            <Link
              prefetch={false}
              href={`/staff/work/${candidacyId}`}
              className="font-medium underline underline-offset-4"
            >
              Manage owner and due date
            </Link>
          </p>
        ) : null}
      </section>

      {view ? (
        <section aria-labelledby="details" className="flex flex-col gap-3">
          <h2 id="details" className="text-xl font-semibold">
            Details
          </h2>
          <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-6 gap-y-2 [overflow-wrap:anywhere]">
            <dt className="font-medium">Opening</dt>
            <dd>{view.opening || "Unavailable"}</dd>
            <dt className="font-medium">Source</dt>
            <dd>{view.source}</dd>
            <dt className="font-medium">Email</dt>
            <dd>{view.email}</dd>
            <dt className="font-medium">Phone</dt>
            <dd>{view.phone ?? "Not provided"}</dd>
          </dl>
        </section>
      ) : null}

      {view && view.status === "Active" && view.actions.length > 0 ? (
        <section
          aria-labelledby="prospect-actions"
          className="flex flex-col gap-3"
        >
          <h2 id="prospect-actions" className="text-xl font-semibold">
            Actions
          </h2>
          <div className="flex flex-wrap gap-3">
            {open && view.actions.includes("prospect_create") ? (
              <ConfirmCommand
                action={startApplicationFromProspectAction}
                label="Start application"
                title="Start application"
                recordLabel={view.reference}
                result="Application incomplete"
                consequence="The prospect moves to the application stage for the same opening. The opening must still be accepting applications."
                hidden={hidden}
              />
            ) : null}
            {view.owner === "Unassigned" &&
            view.actions.includes("owner_assign") ? (
              <ConfirmCommand
                action={assignOwnerToMeAction}
                label="Assign to me"
                title="Become the owner"
                recordLabel={view.reference}
                result="You are the owner"
                consequence="You become responsible for following up on this record. It doesn't change the stage or give you access to the candidate's account."
                hidden={hidden}
              />
            ) : null}
            {open && view.actions.includes("prospect_close") ? (
              <ConfirmCommand
                action={closeProspectAction}
                label="Close prospect"
                title="Close prospect"
                recordLabel={view.reference}
                result="Closed"
                consequence="The prospect is closed and cannot be reopened. The record and its history are kept."
                reasons={prospectCloseReasons.map((value) => ({
                  value,
                  label: closeLabels[value],
                }))}
                hidden={hidden}
                destructive
              />
            ) : null}
          </div>
        </section>
      ) : null}
      <section aria-labelledby="timeline" className="flex flex-col gap-3">
        <h2 id="timeline" className="text-xl font-semibold">
          Timeline
        </h2>
        <ol className="flex flex-col gap-2">
          {overview.view.timeline.map((entry, index) => (
            <li
              key={`${entry.when}-${index}`}
              className="rounded-lg border p-3 [overflow-wrap:anywhere]"
            >
              <span className="font-medium">{entry.event}</span>
              {entry.detail ? ` (${entry.detail})` : ""},{" "}
              <time dateTime={entry.when}>{formatInstant(entry.when)}</time>
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}

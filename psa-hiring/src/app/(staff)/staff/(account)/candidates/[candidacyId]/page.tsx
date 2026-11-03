import type { Metadata } from "next";
import { currentRequestHeaders } from "@/app/_auth/auth-messages";
import {
  newCandidateCommandKey,
  prospectCloseReasons,
  queryProspectDetail,
} from "@/modules/candidates";
import { refuseAccess } from "@/modules/identity-access/delivery/route-authorization";
import { ConfirmCommand } from "@/modules/organization/ui/confirm-command";
import {
  assignOwnerToMeAction,
  closeProspectAction,
  startApplicationFromProspectAction,
} from "../actions";

// Bounded prospect/candidacy detail (packet M2.2 §18.2). Not the M3
// candidate workspace: identity, opening, stage, owner, a generic possible
// duplicate flag, and append-only stage history. Every action re-authorizes
// on the server with the rendered version. The title and URL carry no PII.

export const metadata: Metadata = { title: "Prospect" };

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
  const result = await queryProspectDetail(
    await currentRequestHeaders(),
    candidacyId,
  );
  if (result.kind === "UNAUTHENTICATED")
    refuseAccess("UNAUTHENTICATED", "STAFF");
  if (result.kind !== "OK") refuseAccess("NOT_FOUND", "STAFF");
  const view = result.view;
  const hidden = {
    commandKey: newCandidateCommandKey(),
    candidacyId: view.id,
    expectedVersion: String(view.version),
  };
  const open = view.status === "Active" && view.stage === "Prospect";

  return (
    <div className="flex max-w-3xl flex-col gap-8">
      <div className="flex flex-col gap-2">
        <h1 className="text-3xl font-semibold tracking-tight">
          {view.displayName}
        </h1>
        <p className="font-mono">{view.reference}</p>
      </div>
      {view.possibleDuplicate ? (
        <p role="note" className="rounded-lg border p-4">
          <strong>Possible duplicate:</strong> a manager will review whether
          this is the same person as another record.
        </p>
      ) : null}
      <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-6 gap-y-2 [overflow-wrap:anywhere]">
        <dt className="font-medium">Opening</dt>
        <dd>{view.opening || "Unavailable"}</dd>
        <dt className="font-medium">Stage</dt>
        <dd>{view.stage}</dd>
        <dt className="font-medium">Status</dt>
        <dd>{view.status}</dd>
        <dt className="font-medium">Source</dt>
        <dd>{view.source}</dd>
        <dt className="font-medium">Owner</dt>
        <dd>{view.owner}</dd>
        <dt className="font-medium">Email</dt>
        <dd>{view.email}</dd>
        <dt className="font-medium">Phone</dt>
        <dd>{view.phone ?? "Not provided"}</dd>
      </dl>
      {view.status === "Active" && view.actions.length > 0 ? (
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
            {view.owner !== "You" && view.actions.includes("owner_assign") ? (
              <ConfirmCommand
                action={assignOwnerToMeAction}
                label="Assign to me"
                title="Become the owner"
                recordLabel={view.reference}
                result="You are the owner"
                consequence="You become responsible for following up on this record. Any previous owner is replaced; the change is recorded."
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
      <section aria-labelledby="stage-history" className="flex flex-col gap-3">
        <h2 id="stage-history" className="text-xl font-semibold">
          Stage history
        </h2>
        <ol className="flex flex-col gap-2">
          {view.history.map((h, i) => (
            <li key={`${h.occurredAt}-${i}`} className="rounded-lg border p-3">
              <span className="font-medium">{h.stage}</span> — {h.command},{" "}
              <time dateTime={h.occurredAt}>{formatInstant(h.occurredAt)}</time>
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}

import type { Metadata } from "next";
import Link from "next/link";
import { currentRequestHeaders } from "@/app/_auth/auth-messages";
import {
  newCandidateCommandKey,
  ownerChangeReasonLabels,
  ownerChangeReasons,
  queryWorkItem,
} from "@/modules/candidates";
import { refuseAccess } from "@/modules/identity-access/delivery/route-authorization";
import { ConfirmCommand } from "@/modules/organization/ui/confirm-command";
import {
  assignOwnerAction,
  assignOwnerToMeAction,
  releaseOwnerAction,
  setDueDateAction,
} from "../../candidates/actions";

// One record's responsibility panel (packet M3.1). Owner, due date, and their
// history, with only the actions this person may take. Not the M3.2 candidate
// workspace. The title and URL carry no personal data, and every command
// re-authorizes with the version rendered here.

export const metadata: Metadata = { title: "Work item" };
export const dynamic = "force-dynamic";

const dateFormat = new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "UTC",
});

const reasons = ownerChangeReasons.map((value) => ({
  value,
  label: ownerChangeReasonLabels[value],
}));

export default async function WorkItemPage({
  params,
}: PageProps<"/staff/work/[candidacyId]">) {
  const { candidacyId } = await params;
  const result = await queryWorkItem(
    await currentRequestHeaders(),
    candidacyId,
  );
  if (result.kind === "UNAUTHENTICATED") {
    refuseAccess("UNAUTHENTICATED", "STAFF");
  }
  if (result.kind !== "OK") refuseAccess("NOT_FOUND", "STAFF");
  const view = result.view;
  const hidden = {
    commandKey: newCandidateCommandKey(),
    candidacyId: view.id,
    expectedVersion: String(view.version),
  };
  const can = (action: string) => view.actions.includes(action);
  const hasOwnerAction = can("claim") || can("release") || can("assign");

  return (
    <div className="flex max-w-3xl flex-col gap-8">
      <div className="flex flex-col gap-2">
        <p>
          <Link
            prefetch={false}
            href="/staff/work"
            className="font-medium underline underline-offset-4"
          >
            Back to the work queue
          </Link>
        </p>
        <h1 className="text-3xl font-semibold tracking-tight [overflow-wrap:anywhere]">
          {view.displayName}
        </h1>
        <p className="font-mono">{view.reference}</p>
      </div>

      <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-6 gap-y-2 [overflow-wrap:anywhere]">
        <dt className="font-medium">Stage</dt>
        <dd>{view.stage}</dd>
        <dt className="font-medium">Next action</dt>
        <dd>{view.nextAction}</dd>
        <dt className="font-medium">Position</dt>
        <dd>{view.position}</dd>
        <dt className="font-medium">Branch</dt>
        <dd>{view.branch}</dd>
        <dt className="font-medium">Proposed worker path</dt>
        <dd>{view.workerPath}</dd>
        {view.returned ? (
          <>
            <dt className="font-medium">Exception</dt>
            <dd>Returned for correction</dd>
          </>
        ) : null}
        <dt className="font-medium">Owner</dt>
        <dd>{view.owner}</dd>
        <dt className="font-medium">Due (UTC)</dt>
        <dd>
          {view.item?.dueDate
            ? `${view.item.dueDate}${view.item.overdue ? " (overdue)" : ""}`
            : "No due date"}
        </dd>
      </dl>

      {view.hasApplication ? (
        <p>
          <Link
            prefetch={false}
            href={`/staff/candidates/${view.id}/application`}
            className="font-medium underline underline-offset-4"
          >
            Open the submitted application
          </Link>
        </p>
      ) : null}

      {hasOwnerAction ? (
        <section aria-labelledby="owner" className="flex flex-col gap-3">
          <h2 id="owner" className="text-xl font-semibold">
            Owner
          </h2>
          <div className="flex flex-wrap gap-3">
            {can("claim") ? (
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
            {can("assign") && view.eligibleOwners.length > 0 ? (
              <ConfirmCommand
                action={assignOwnerAction}
                label={view.unassigned ? "Assign owner" : "Change owner"}
                title={view.unassigned ? "Assign an owner" : "Change the owner"}
                recordLabel={view.reference}
                result="The person you choose becomes the owner"
                consequence="They become responsible for following up on this record. It doesn't change the stage, and they aren't notified automatically."
                hidden={hidden}
                reasons={reasons}
              >
                <div className="flex flex-col gap-1.5">
                  <label htmlFor="owner-account" className="font-medium">
                    New owner
                  </label>
                  <select
                    id="owner-account"
                    name="ownerAccountId"
                    required
                    defaultValue=""
                    className="h-10 w-full rounded-lg border border-input bg-background px-3"
                  >
                    <option value="" disabled>
                      Choose a person
                    </option>
                    {view.eligibleOwners.map((owner) => (
                      <option key={owner.id} value={owner.id}>
                        {owner.name}
                      </option>
                    ))}
                  </select>
                </div>
              </ConfirmCommand>
            ) : null}
            {can("release") ? (
              <ConfirmCommand
                action={releaseOwnerAction}
                label="Remove owner"
                title="Remove the owner"
                recordLabel={view.reference}
                result="Unassigned"
                consequence="Nobody will be responsible for this record until someone takes it. The history keeps who owned it."
                hidden={hidden}
                reasons={reasons}
              />
            ) : null}
          </div>
          {can("assign") && view.eligibleOwners.length === 0 ? (
            <p>Nobody else in this record&apos;s scope can own it right now.</p>
          ) : null}
        </section>
      ) : null}

      {can("due_date") && view.item ? (
        <section aria-labelledby="due" className="flex flex-col gap-3">
          <h2 id="due" className="text-xl font-semibold">
            Due date
          </h2>
          <div className="flex flex-wrap gap-3">
            <ConfirmCommand
              action={setDueDateAction}
              label={view.item.dueDate ? "Change due date" : "Set due date"}
              title="Set the due date"
              recordLabel={view.reference}
              result="The work is due at the end of that day, UTC"
              consequence="This is for staff planning only. The candidate doesn't see it, and nothing happens automatically when it passes."
              hidden={{
                ...hidden,
                expectedVersion: String(view.item.version),
              }}
            >
              <div className="flex flex-col gap-1.5">
                <label htmlFor="due-date" className="font-medium">
                  Due date (today through one year ahead)
                </label>
                <input
                  id="due-date"
                  type="date"
                  name="dueDate"
                  required
                  defaultValue={view.item.dueDate ?? ""}
                  className="h-10 w-full rounded-lg border border-input bg-background px-3"
                />
              </div>
            </ConfirmCommand>
            {view.item.dueDate ? (
              <ConfirmCommand
                action={setDueDateAction}
                label="Clear due date"
                title="Clear the due date"
                recordLabel={view.reference}
                result="No due date"
                consequence="The work stays in the queue without a date."
                hidden={{
                  ...hidden,
                  expectedVersion: String(view.item.version),
                  dueDate: "",
                }}
              />
            ) : null}
          </div>
        </section>
      ) : null}

      <section aria-labelledby="history" className="flex flex-col gap-3">
        <h2 id="history" className="text-xl font-semibold">
          Responsibility history
        </h2>
        {view.history.length === 0 ? (
          <p>No changes yet.</p>
        ) : (
          <ol className="flex flex-col gap-2">
            {view.history.map((entry, index) => (
              <li key={index} className="[overflow-wrap:anywhere]">
                <span className="font-medium">{entry.change}</span>
                {entry.reason ? ` (${entry.reason})` : ""} by {entry.by},{" "}
                <time dateTime={entry.when}>
                  {dateFormat.format(new Date(entry.when))} UTC
                </time>
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}

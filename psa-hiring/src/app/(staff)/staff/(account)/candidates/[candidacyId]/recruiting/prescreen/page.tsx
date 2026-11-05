import type { Metadata } from "next";
import { currentRequestHeaders } from "@/app/_auth/auth-messages";
import {
  exceptionReasonLabels,
  exceptionReasons,
  notSelectedReasonLabels,
  notSelectedReasons,
  prescreenResultLabels,
  queryPrescreen,
} from "@/modules/applications";
import {
  holdCategories,
  holdCategoryLabels,
  newCandidateCommandKey,
} from "@/modules/candidates";
import { refuseAccess } from "@/modules/identity-access/delivery/route-authorization";
import { ConfirmCommand } from "@/modules/organization/ui/confirm-command";
import {
  acceptForPrescreenAction,
  approvePrescreenExceptionAction,
  notSelectPrescreenAction,
  passPrescreenAction,
  placeHoldAction,
  removeHoldAction,
  savePrescreenAction,
} from "../../../actions";
import { PrescreenForm } from "./prescreen-form";

// Prescreen tab (packet M3.3; UI_FLOW §11.3). Only the actions this person may
// take appear, and the server checks each again. Reasons and notes stay on staff
// screens. The title and URL carry no personal data.

export const metadata: Metadata = { title: "Prescreen" };
export const dynamic = "force-dynamic";

const statusText: Readonly<Record<string, string>> = {
  NOT_STARTED: "Not started",
  IN_PROGRESS: "In progress",
  PASSED: "Passed",
  NOT_SELECTED: "Not selected",
  RETURNED: "Returned for more information",
};

const dateFormat = new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "UTC",
});
const when = (iso: string) => `${dateFormat.format(new Date(iso))} UTC`;

export default async function PrescreenPage({
  params,
}: PageProps<"/staff/candidates/[candidacyId]/recruiting/prescreen">) {
  const { candidacyId } = await params;
  const result = await queryPrescreen(
    await currentRequestHeaders(),
    candidacyId,
  );
  if (result.kind === "UNAUTHENTICATED") {
    refuseAccess("UNAUTHENTICATED", "STAFF");
  }
  if (result.kind !== "OK") refuseAccess("NOT_FOUND", "STAFF");
  const view = result.view;
  const can = (action: string) => view.actions.includes(action);
  const commandKey = newCandidateCommandKey();
  const onRecord = {
    commandKey,
    candidacyId: view.candidacyId,
    expectedVersion: String(view.candidacyVersion),
  };
  const onReview = {
    ...onRecord,
    expectedVersion: String(view.reviewVersion ?? 0),
  };
  const reasonsOf = <T extends string>(
    list: readonly T[],
    labels: Readonly<Record<T, string>>,
  ) => list.map((value) => ({ value, label: labels[value] }));

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-2">
        <h2 className="text-2xl font-semibold tracking-tight">Prescreen</h2>
        <p>
          <span className="font-medium">Status:</span> {statusText[view.status]}
        </p>
        {view.checklistDraft ? (
          <p role="note" className="rounded-lg border p-3">
            Checklist version {view.checklistVersion} is a draft awaiting
            business review.
          </p>
        ) : null}
        {view.reviewer ? (
          <p>
            <span className="font-medium">Reviewer:</span> {view.reviewer}
          </p>
        ) : null}
      </div>

      {view.hold ? (
        <section aria-labelledby="hold" className="flex flex-col gap-3">
          <h3 id="hold" className="text-xl font-semibold">
            Hold
          </h3>
          <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-6 gap-y-2 [overflow-wrap:anywhere]">
            <dt className="font-medium">Category</dt>
            <dd>{view.hold.category}</dd>
            <dt className="font-medium">Internal reason</dt>
            <dd>{view.hold.reason}</dd>
            <dt className="font-medium">Review by (UTC)</dt>
            <dd>{view.hold.reviewDate}</dd>
            <dt className="font-medium">Placed by</dt>
            <dd>{view.hold.placedBy}</dd>
          </dl>
          <p>While this is on hold, no prescreen decision can be made.</p>
          {can("remove_hold") ? (
            <div>
              <ConfirmCommand
                action={removeHoldAction}
                label="Remove hold"
                title="Remove the hold"
                recordLabel={view.hold.category}
                result="The prescreen continues where it stopped"
                consequence="The record of this hold stays in the history."
                hidden={{
                  ...onRecord,
                  expectedVersion: String(view.hold.version),
                }}
                reasons={[
                  { value: "RESOLVED", label: "Resolved" },
                  { value: "PLACED_IN_ERROR", label: "Placed in error" },
                ]}
              />
            </div>
          ) : null}
        </section>
      ) : null}

      {can("accept") ? (
        <section aria-labelledby="accept" className="flex flex-col gap-3">
          <h3 id="accept" className="text-xl font-semibold">
            Start
          </h3>
          <div>
            <ConfirmCommand
              action={acceptForPrescreenAction}
              label="Accept for prescreen"
              title="Accept this application for prescreen"
              recordLabel={view.reference}
              result="Prescreen review"
              consequence="The candidate will see that their application is under review."
              hidden={onRecord}
            />
          </div>
        </section>
      ) : null}

      {view.items.length > 0 ? (
        <section aria-labelledby="checklist" className="flex flex-col gap-3">
          <h3 id="checklist" className="text-xl font-semibold">
            Checklist
          </h3>
          {can("save") ? (
            <PrescreenForm
              action={savePrescreenAction}
              candidacyId={view.candidacyId}
              version={view.reviewVersion!}
              commandKey={commandKey}
              items={view.items}
              notes={view.notes}
            />
          ) : (
            <>
              <ul className="flex flex-col gap-2">
                {view.items.map((item) => (
                  <li key={item.code} className="rounded-lg border p-3">
                    <span className="font-medium">{item.label}:</span>{" "}
                    {item.result
                      ? prescreenResultLabels[item.result]
                      : "Not answered"}
                  </li>
                ))}
              </ul>
              {view.notes ? (
                <p className="[overflow-wrap:anywhere]">
                  <span className="font-medium">Internal notes:</span>{" "}
                  {view.notes}
                </p>
              ) : null}
            </>
          )}
        </section>
      ) : null}

      {view.exception ? (
        <p role="note" className="rounded-lg border p-3">
          Exception approved by {view.exception.by}, {when(view.exception.when)}
          : {view.exception.reason}.
        </p>
      ) : null}
      {view.exceptionNeeded && view.status === "IN_PROGRESS" ? (
        <p role="note" className="rounded-lg border p-3">
          An item is marked Not met, so passing needs a PSA Manager&apos;s
          exception. The manager can&apos;t be the person who answered the
          checklist. Changing the answers cancels any exception.
        </p>
      ) : null}

      {view.decision ? (
        <p className="[overflow-wrap:anywhere]">
          <span className="font-medium">Decision:</span>{" "}
          {statusText[view.status]}
          {view.decision.reason ? ` (${view.decision.reason})` : ""} by{" "}
          {view.decision.by}, {when(view.decision.when)}
        </p>
      ) : null}

      {can("pass") ||
      can("not_select") ||
      can("exception") ||
      can("place_hold") ? (
        <section aria-labelledby="decide" className="flex flex-col gap-3">
          <h3 id="decide" className="text-xl font-semibold">
            Decide
          </h3>
          <div className="flex flex-wrap gap-3">
            {can("pass") ? (
              <ConfirmCommand
                action={passPrescreenAction}
                label="Pass"
                title="Pass this prescreen"
                recordLabel={view.reference}
                result="Interview"
                consequence="The candidate moves to the interview stage. Interview scheduling isn't available yet, and no email is sent."
                hidden={onReview}
              />
            ) : null}
            {can("exception") ? (
              <ConfirmCommand
                action={approvePrescreenExceptionAction}
                label="Approve exception"
                title="Approve an exception"
                recordLabel={view.reference}
                result="This prescreen can pass despite the unmet item"
                consequence="Your name and reason are recorded against these exact answers."
                hidden={onReview}
                reasons={reasonsOf(exceptionReasons, exceptionReasonLabels)}
              />
            ) : null}
            {can("place_hold") ? (
              <ConfirmCommand
                action={placeHoldAction}
                label="Place on hold"
                title="Place this candidate on hold"
                recordLabel={view.reference}
                result="On hold"
                consequence="No prescreen decision can be made until the hold is removed. The candidate isn't told, and their status doesn't change."
                hidden={onRecord}
                reasons={reasonsOf(holdCategories, holdCategoryLabels)}
              >
                <div className="flex flex-col gap-1.5">
                  <label htmlFor="hold-reason" className="font-medium">
                    Internal reason (the candidate never sees this)
                  </label>
                  <textarea
                    id="hold-reason"
                    name="internalReason"
                    required
                    rows={3}
                    maxLength={1000}
                    className="w-full rounded-lg border border-input bg-background p-3"
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <label htmlFor="hold-review" className="font-medium">
                    Review by (UTC, within 180 days)
                  </label>
                  <input
                    id="hold-review"
                    type="date"
                    name="reviewDate"
                    required
                    className="h-10 w-full rounded-lg border border-input bg-background px-3"
                  />
                </div>
              </ConfirmCommand>
            ) : null}
            {can("not_select") ? (
              <ConfirmCommand
                action={notSelectPrescreenAction}
                label="Not selected"
                title="Mark as not selected"
                recordLabel={view.reference}
                result="Closed"
                consequence="The application closes. The candidate sees 'Application not continuing' with no reason, and no email is sent. The reason stays internal."
                hidden={onReview}
                reasons={reasonsOf(notSelectedReasons, notSelectedReasonLabels)}
                destructive
              />
            ) : null}
          </div>
          <p>
            To ask the candidate for more information, use Return for correction
            on the Application tab.
          </p>
        </section>
      ) : null}
    </div>
  );
}

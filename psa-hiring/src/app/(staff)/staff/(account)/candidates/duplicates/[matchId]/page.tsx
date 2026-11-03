import type { Metadata } from "next";
import Link from "next/link";
import { currentRequestHeaders } from "@/app/_auth/auth-messages";
import {
  newCandidateCommandKey,
  queryDuplicateReview,
} from "@/modules/candidates";
import {
  refuseAccess,
  refuseIdentityReviewAccess,
} from "@/modules/identity-access/delivery/route-authorization";
import { ConfirmCommand } from "@/modules/organization/ui/confirm-command";
import { mergePeopleAction, reviewDuplicateAction } from "../../actions";

// Possible-duplicate review (packet M2.2 §15–§17, §18.3). Minimal side by
// side comparison with masked contact values, the matching signals, and a
// clear merge blocker when one applies. Review and merge each use a
// confirmation dialog with a closed reason; the server re-checks
// authorization, step-up, version, and every merge gate.

export const metadata: Metadata = { title: "Review possible duplicate" };
export const dynamic = "force-dynamic";

const signalLabels = {
  EXACT_EMAIL: "Same email address",
  EXACT_PHONE: "Same phone number",
} as const;
const statusLabels = {
  PENDING: "Pending review",
  CONFIRMED_DUPLICATE: "Confirmed duplicate",
  NOT_DUPLICATE: "Not a duplicate",
  MERGED: "Merged",
} as const;
const blockerText: Readonly<Record<string, string>> = {
  BLOCKED_PERSON_NOT_ACTIVE:
    "One of these records is no longer active, so they cannot be merged.",
  BLOCKED_TWO_CANDIDATE_ACCOUNTS:
    "Both records belong to different candidate accounts. They cannot be merged here.",
  BLOCKED_CURRENT_CANDIDACY_COLLISION:
    "Both records have an active candidacy for the same opening. Close one of them before merging.",
};

export default async function DuplicateReviewPage({
  params,
}: PageProps<"/staff/candidates/duplicates/[matchId]">) {
  const { matchId } = await params;
  const result = await queryDuplicateReview(
    await currentRequestHeaders(),
    matchId,
  );
  if (result.kind === "UNAUTHENTICATED")
    refuseAccess("UNAUTHENTICATED", "STAFF");
  if (result.kind === "REAUTHENTICATION_REQUIRED") {
    refuseIdentityReviewAccess("REAUTHENTICATION_REQUIRED");
  }
  if (result.kind !== "OK") refuseAccess("NOT_FOUND", "STAFF");
  const view = result.view;
  const hidden = { matchId: view.id, expectedVersion: String(view.version) };

  return (
    <div className="flex max-w-4xl flex-col gap-8">
      <div className="flex flex-col gap-2">
        <h1 className="text-3xl font-semibold tracking-tight">
          Review possible duplicate
        </h1>
        <p>
          Status: <strong>{statusLabels[view.status]}</strong>. Confidence:{" "}
          {view.tier === "HIGH" ? "High" : "Medium"} (rules {view.ruleset}).
        </p>
        <ul className="list-disc pl-5">
          {view.signals.map((s) => (
            <li key={s}>{signalLabels[s]}</li>
          ))}
        </ul>
      </div>
      <div className="grid gap-6 md:grid-cols-2">
        {(
          [
            ["Record 1", view.first],
            ["Record 2", view.second],
          ] as const
        ).map(([heading, side]) => (
          <section
            key={heading}
            aria-label={heading}
            className="flex flex-col gap-2 rounded-lg border p-4"
          >
            <h2 className="text-xl font-semibold">{heading}</h2>
            <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-1 [overflow-wrap:anywhere]">
              <dt className="font-medium">Name</dt>
              <dd>{side.displayName}</dd>
              <dt className="font-medium">Email</dt>
              <dd>{side.email}</dd>
              <dt className="font-medium">Phone</dt>
              <dd>{side.phone ?? "Not provided"}</dd>
              <dt className="font-medium">Candidate account</dt>
              <dd>{side.candidateAccountLinked ? "Linked" : "None"}</dd>
            </dl>
            <h3 className="font-medium">Candidacies</h3>
            {side.candidacies.length === 0 ? (
              <p>None</p>
            ) : (
              <ul className="flex flex-col gap-1">
                {side.candidacies.map((c) => (
                  <li key={c.reference}>
                    <span className="font-mono">{c.reference}</span> — {c.stage}
                    , {c.status}
                  </li>
                ))}
              </ul>
            )}
          </section>
        ))}
      </div>
      {view.mergeBlocker &&
      view.status !== "MERGED" &&
      view.status !== "NOT_DUPLICATE" ? (
        <p role="note" className="rounded-lg border p-4">
          <strong>Merge not possible:</strong> {blockerText[view.mergeBlocker]}
        </p>
      ) : null}
      {view.actions.length > 0 ? (
        <section
          aria-labelledby="review-actions"
          className="flex flex-col gap-3"
        >
          <h2 id="review-actions" className="text-xl font-semibold">
            Decision
          </h2>
          <div className="flex flex-wrap gap-3">
            {view.actions.includes("review") ? (
              <>
                <ConfirmCommand
                  action={reviewDuplicateAction}
                  label="Confirm same person"
                  title="Confirm these records are the same person"
                  recordLabel="This case"
                  result="Confirmed duplicate"
                  consequence="The case is marked as a confirmed duplicate. Nothing is merged until you merge the records separately."
                  reasons={[
                    {
                      value: "SAME_PERSON_CONFIRMED",
                      label: "Same person confirmed",
                    },
                  ]}
                  hidden={{
                    ...hidden,
                    commandKey: newCandidateCommandKey(),
                    decision: "CONFIRMED_DUPLICATE",
                  }}
                />
                <ConfirmCommand
                  action={reviewDuplicateAction}
                  label="Not the same person"
                  title="Mark these records as different people"
                  recordLabel="This case"
                  result="Not a duplicate"
                  consequence="The case is closed. Both records stay separate and unchanged."
                  reasons={[
                    {
                      value: "DIFFERENT_PEOPLE_CONFIRMED",
                      label: "Different people confirmed",
                    },
                    {
                      value: "INSUFFICIENT_EVIDENCE",
                      label: "Not enough evidence",
                    },
                  ]}
                  hidden={{
                    ...hidden,
                    commandKey: newCandidateCommandKey(),
                    decision: "NOT_DUPLICATE",
                  }}
                />
              </>
            ) : null}
            {view.actions.includes("merge") && !view.mergeBlocker ? (
              <ConfirmCommand
                action={mergePeopleAction}
                label="Merge records"
                title="Merge these records"
                recordLabel="This case"
                result="Merged"
                consequence="Candidacies move to the surviving record and any candidate account link is kept. The merged record is preserved and points to the survivor. This cannot be undone here."
                reasons={[
                  {
                    value: "CONFIRMED_DUPLICATE_RECORD",
                    label: "Confirmed duplicate record",
                  },
                ]}
                hidden={{ ...hidden, commandKey: newCandidateCommandKey() }}
                destructive
              />
            ) : null}
          </div>
        </section>
      ) : null}
      <Link
        href="/staff/candidates/duplicates"
        className="underline underline-offset-4"
      >
        Back to possible duplicates
      </Link>
    </div>
  );
}

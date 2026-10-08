import type { Metadata } from "next";
import Link from "next/link";
import { currentRequestHeaders } from "@/app/_auth/auth-messages";
import { newCommandKey, queryCycleDetail } from "@/modules/organization";
import { refuseConfigurationAccess } from "@/modules/identity-access/delivery/route-authorization";
import { ConfigForm } from "@/modules/organization/ui/config-form";
import { ConfirmCommand } from "@/modules/organization/ui/confirm-command";
import {
  cancelReasonOptions,
  changeReasonOptions,
  closeReasonOptions,
  codeHint,
  statusLabels,
} from "@/modules/organization/ui/labels";
import {
  archiveHiringCycleAction,
  cancelHiringCycleAction,
  closeHiringCycleAction,
  openHiringCycleAction,
  publishHiringCycleAction,
  updateHiringCycleAction,
} from "../../../actions";

// One hiring cycle (packet M2.1 §12–§13, §16). Drafts are editable; once
// published, the window, labels, and snapshot are frozen and shown
// read-only. Lifecycle actions appear only when the current status and
// the principal's grants allow them; the server rechecks both, the
// parents' status, and the window at the trusted server time.

export const metadata: Metadata = { title: "Hiring cycle" };
export const dynamic = "force-dynamic";

export default async function CyclePage({
  params,
}: PageProps<"/staff/admin/positions/[positionId]/cycles/[cycleId]">) {
  const { positionId, cycleId } = await params;
  const result = await queryCycleDetail(
    await currentRequestHeaders(),
    positionId,
    cycleId,
  );
  if (result.kind === "UNAUTHENTICATED") {
    refuseConfigurationAccess("UNAUTHENTICATED");
  }
  if (result.kind !== "OK") refuseConfigurationAccess("NOT_FOUND");
  const c = result.view;
  const can = (action: string) => c.actions.includes(action);
  const hidden = () => ({
    commandKey: newCommandKey(),
    targetId: c.id,
    expectedVersion: String(c.version),
  });
  const record = `${c.internalLabel} (${c.code})`;
  const windowText = `Opens ${c.opensAt} (inclusive) · ${
    c.closesAt
      ? `Closes ${c.closesAt} (exclusive)`
      : "No closing time (open-ended)"
  }`;

  return (
    <div className="flex max-w-3xl flex-col gap-8">
      <Link
        href={`/staff/admin/positions/${c.positionId}`}
        className="underline underline-offset-4"
      >
        Back to {c.positionTitle}
      </Link>
      <div className="flex flex-col gap-2">
        <h1 className="text-3xl font-semibold tracking-tight">
          {c.internalLabel}
        </h1>
        <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1">
          <dt className="font-medium">Status</dt>
          <dd>{statusLabels[c.status]}</dd>
          <dt className="font-medium">Code</dt>
          <dd className="font-mono">{c.code}</dd>
          <dt className="font-medium">Public reference</dt>
          <dd className="font-mono">{c.publicReference}</dd>
          <dt className="font-medium">Placement</dt>
          <dd>
            {c.teamName ? `${c.branchName} · ${c.teamName}` : c.branchName}
          </dd>
          <dt className="font-medium">Application window</dt>
          <dd>{windowText}</dd>
          <dt className="font-medium">Display timezone</dt>
          <dd>{c.timezone}</dd>
          {c.endReason ? (
            <>
              <dt className="font-medium">End reason</dt>
              <dd>{c.endReason}</dd>
            </>
          ) : null}
        </dl>
      </div>

      <section
        aria-label="Hiring cycle actions"
        className="flex flex-wrap gap-3"
      >
        {c.status === "DRAFT" && can("hiring_cycle_publish") ? (
          <ConfirmCommand
            action={publishHiringCycleAction}
            label="Publish cycle"
            title="Publish this hiring cycle?"
            recordLabel={record}
            result="Published (not yet open to applicants)"
            consequence="The description version, public title, location label, worker-path eligibility, window, and timezone are frozen. Later changes to the position or description will not change this cycle."
            reasons={changeReasonOptions}
            hidden={hidden()}
          />
        ) : null}
        {c.status === "PUBLISHED" && can("hiring_cycle_open") ? (
          <ConfirmCommand
            action={openHiringCycleAction}
            label="Open cycle"
            title="Open this hiring cycle to applicants?"
            recordLabel={record}
            result="Open: listed publicly and accepting applications"
            consequence={`The opening appears on the public positions page and accepts applications until ${c.closesAt ?? "it is closed"} (exclusive). It can open only inside its window.`}
            reasons={changeReasonOptions}
            hidden={hidden()}
          />
        ) : null}
        {(c.status === "OPEN" || c.status === "PUBLISHED") &&
        can("hiring_cycle_close") ? (
          <ConfirmCommand
            action={closeHiringCycleAction}
            label="Close cycle"
            title="Close this hiring cycle?"
            recordLabel={record}
            result="Closed: no longer accepting applications"
            consequence="The opening leaves the public list immediately. A closed cycle can never reopen; create a new cycle to hire again."
            reasons={closeReasonOptions}
            hidden={hidden()}
            destructive
          />
        ) : null}
        {(c.status === "DRAFT" ||
          c.status === "PUBLISHED" ||
          c.status === "OPEN") &&
        can("hiring_cycle_cancel") ? (
          <ConfirmCommand
            action={cancelHiringCycleAction}
            label="Cancel cycle"
            title="Cancel this hiring cycle?"
            recordLabel={record}
            result="Cancelled"
            consequence="The opening is withdrawn and is not shown publicly. A cancelled cycle can never reopen."
            reasons={cancelReasonOptions}
            hidden={hidden()}
            destructive
          />
        ) : null}
        {(c.status === "CLOSED" || c.status === "CANCELLED") &&
        can("hiring_cycle_archive") ? (
          <ConfirmCommand
            action={archiveHiringCycleAction}
            label="Archive cycle"
            title="Archive this hiring cycle?"
            recordLabel={record}
            result="Archived (history kept)"
            consequence="The cycle is kept as history only. Nothing is deleted."
            reasons={changeReasonOptions}
            hidden={hidden()}
          />
        ) : null}
      </section>

      {c.snapshot ? (
        <section
          aria-labelledby="snapshot-heading"
          className="flex flex-col gap-2"
        >
          <h2 id="snapshot-heading" className="text-xl font-semibold">
            Published snapshot (frozen)
          </h2>
          <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1">
            <dt className="font-medium">Description version</dt>
            <dd>{c.snapshot.descriptionVersion}</dd>
            <dt className="font-medium">Public title</dt>
            <dd>{c.publicLabel ?? c.snapshot.publicTitle}</dd>
            <dt className="font-medium">Location label</dt>
            <dd>{c.snapshot.locationLabel}</dd>
            <dt className="font-medium">Worker paths</dt>
            <dd>{c.snapshot.workerPaths}</dd>
            <dt className="font-medium">Published</dt>
            <dd>{c.snapshot.publishedAt}</dd>
          </dl>
        </section>
      ) : null}

      {c.status === "DRAFT" && can("hiring_cycle_edit") ? (
        <ConfigForm
          action={updateHiringCycleAction}
          title="Edit draft"
          submitLabel="Save draft"
          hidden={{
            commandKey: newCommandKey(),
            positionId: c.positionId,
            cycleId: c.id,
            expectedVersion: String(c.version),
          }}
          fields={[
            {
              kind: "text",
              name: "code",
              label: "Cycle code",
              hint: codeHint,
              defaultValue: c.code,
              maxLength: 32,
            },
            {
              kind: "text",
              name: "internalLabel",
              label: "Internal label",
              defaultValue: c.internalLabel,
              maxLength: 120,
            },
            {
              kind: "text",
              name: "publicLabel",
              label: "Public label (optional)",
              defaultValue: c.publicLabel ?? "",
              maxLength: 120,
            },
            {
              kind: "datetime-local",
              name: "opensAt",
              label: `Applications open (inclusive, ${c.timezone})`,
              defaultValue: c.opensAtLocal,
            },
            {
              kind: "datetime-local",
              name: "closesAt",
              label: `Applications close (exclusive, ${c.timezone})`,
              defaultValue: c.closesAtLocal ?? "",
            },
            {
              kind: "checkbox",
              name: "openEnded",
              label: "This cycle is explicitly open-ended (no closing time)",
              defaultChecked: c.openEnded,
            },
          ]}
        />
      ) : null}
    </div>
  );
}

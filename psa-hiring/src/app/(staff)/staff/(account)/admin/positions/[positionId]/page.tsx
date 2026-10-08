import type { Metadata } from "next";
import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";
import { currentRequestHeaders } from "@/app/_auth/auth-messages";
import { newCommandKey, queryPositionDetail } from "@/modules/organization";
import { refuseConfigurationAccess } from "@/modules/identity-access/delivery/route-authorization";
import { ConfigForm } from "@/modules/organization/ui/config-form";
import { ConfirmCommand } from "@/modules/organization/ui/confirm-command";
import {
  changeReasonOptions,
  codeHint,
  statusLabels,
  workerPathHint,
  workerPathOptions,
} from "@/modules/organization/ui/labels";
import {
  activatePositionAction,
  createDescriptionDraftAction,
  inactivatePositionAction,
  retirePositionAction,
  updatePositionAction,
} from "../actions";

// One reusable position (packet M2.1 §10–§12, §16): details, lifecycle
// actions, job-description versions, and the hiring cycles in scope.
// Only actions the principal's grants permit are rendered; every action
// re-authorizes on the server. Unknown and out-of-scope IDs are one
// not-found.

export const metadata: Metadata = { title: "Position" };
export const dynamic = "force-dynamic";

export default async function PositionPage({
  params,
}: PageProps<"/staff/admin/positions/[positionId]">) {
  const { positionId } = await params;
  const result = await queryPositionDetail(
    await currentRequestHeaders(),
    positionId,
  );
  if (result.kind === "UNAUTHENTICATED") {
    refuseConfigurationAccess("UNAUTHENTICATED");
  }
  if (result.kind !== "OK") refuseConfigurationAccess("NOT_FOUND");
  const { position, organizationName, descriptions, cycles, actions } =
    result.view;
  const can = (action: string) => actions.includes(action);
  // One fresh server-issued command key per rendered form.
  const status = () => ({
    commandKey: newCommandKey(),
    targetId: position.id,
    expectedVersion: String(position.version),
  });
  const hasDraft = descriptions.some((d) => d.status === "DRAFT");
  const hasPublished = descriptions.some((d) => d.status === "PUBLISHED");
  const record = `${position.internalTitle} (${position.code})`;

  return (
    <div className="flex flex-col gap-10">
      <Link
        href="/staff/admin/positions"
        className="underline underline-offset-4"
      >
        Back to positions
      </Link>
      <div className="flex flex-col gap-2">
        <h1 className="text-3xl font-semibold tracking-tight">
          {position.internalTitle}
        </h1>
        <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1">
          <dt className="font-medium">Code</dt>
          <dd className="font-mono">{position.code}</dd>
          <dt className="font-medium">Organization</dt>
          <dd>{organizationName}</dd>
          <dt className="font-medium">Status</dt>
          <dd>{statusLabels[position.status]}</dd>
          <dt className="font-medium">Public title</dt>
          <dd>{position.publicTitle}</dd>
        </dl>
      </div>

      <section aria-label="Position actions" className="flex flex-wrap gap-3">
        {can("position_activate") &&
        (position.status === "DRAFT" || position.status === "INACTIVE") ? (
          <ConfirmCommand
            action={activatePositionAction}
            label="Activate position"
            title="Activate this position?"
            recordLabel={record}
            result="Active"
            consequence="Active positions can be used to create hiring cycles. The position code can no longer change."
            reasons={changeReasonOptions}
            hidden={status()}
          />
        ) : null}
        {can("position_activate") && position.status === "ACTIVE" ? (
          <ConfirmCommand
            action={inactivatePositionAction}
            label="Inactivate position"
            title="Inactivate this position?"
            recordLabel={record}
            result="Inactive"
            consequence="No new hiring cycles can be created, and its open cycles stop accepting applications publicly. History is kept."
            reasons={changeReasonOptions}
            hidden={status()}
            destructive
          />
        ) : null}
        {can("position_retire") && position.status !== "RETIRED" ? (
          <ConfirmCommand
            action={retirePositionAction}
            label="Retire position"
            title="Retire this position permanently?"
            recordLabel={record}
            result="Retired"
            consequence="A retired position can never be reactivated or reopened; create a new position if the role is needed again. History is kept."
            reasons={changeReasonOptions}
            hidden={status()}
            destructive
          />
        ) : null}
      </section>

      {can("position_edit") && position.status !== "RETIRED" ? (
        <ConfigForm
          action={updatePositionAction}
          title="Edit position"
          submitLabel="Save position"
          hidden={{
            commandKey: newCommandKey(),
            positionId: position.id,
            expectedVersion: String(position.version),
          }}
          fields={[
            {
              kind: "text",
              name: "code",
              label: "Position code",
              hint: codeHint,
              defaultValue: position.code,
              maxLength: 32,
              readOnly: position.status !== "DRAFT",
            },
            {
              kind: "text",
              name: "internalTitle",
              label: "Internal title",
              defaultValue: position.internalTitle,
              maxLength: 120,
            },
            {
              kind: "text",
              name: "publicTitle",
              label: "Public title",
              defaultValue: position.publicTitle,
              maxLength: 120,
            },
            {
              kind: "select",
              name: "workerPathsAllowed",
              label: "Worker paths",
              hint: `${workerPathHint} Changing this never alters a published hiring cycle.`,
              options: workerPathOptions,
              defaultValue: position.workerPaths,
            },
          ]}
        />
      ) : null}

      <section
        aria-labelledby="descriptions-heading"
        className="flex flex-col gap-4"
      >
        <h2 id="descriptions-heading" className="text-xl font-semibold">
          Job descriptions
        </h2>
        <p className="text-muted-foreground">
          Published descriptions are frozen. To change published wording, create
          a new draft version; publishing it supersedes the current version for
          new cycles only.
        </p>
        {descriptions.length === 0 ? (
          <p role="status">No description versions yet.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {descriptions.map((d) => (
              <li key={d.id}>
                <Link
                  href={`/staff/admin/positions/${position.id}/descriptions/${d.id}`}
                  className="underline underline-offset-4"
                >
                  Version {d.versionNumber}: {d.publicTitle}
                </Link>{" "}
                — {statusLabels[d.status]}
              </li>
            ))}
          </ul>
        )}
        {can("job_description_edit") &&
        !hasDraft &&
        position.status !== "RETIRED" ? (
          <ConfigForm
            action={createDescriptionDraftAction}
            title="New draft description"
            submitLabel="Create draft description"
            hidden={{ commandKey: newCommandKey(), positionId: position.id }}
            fields={[
              {
                kind: "text",
                name: "publicTitle",
                label: "Public title",
                defaultValue: position.publicTitle,
                maxLength: 120,
              },
              {
                kind: "textarea",
                name: "summary",
                label: "Summary",
                hint: "One or two plain sentences, up to 500 characters.",
                maxLength: 500,
                rows: 3,
              },
              {
                kind: "textarea",
                name: "body",
                label: "Description",
                hint: "Plain text only, up to 8,000 characters. Separate paragraphs with a blank line; start lines with “- ” for a list. Links, markup, and templates are not accepted.",
                maxLength: 8000,
                rows: 12,
              },
            ]}
          />
        ) : null}
      </section>

      <section aria-labelledby="cycles-heading" className="flex flex-col gap-4">
        <h2 id="cycles-heading" className="text-xl font-semibold">
          Hiring cycles
        </h2>
        {position.status === "ACTIVE" && hasPublished ? (
          <Link
            href={`/staff/admin/positions/${position.id}/cycles/new`}
            className={`${buttonVariants({ variant: "outline" })} self-start`}
          >
            New hiring cycle
          </Link>
        ) : (
          <p className="text-muted-foreground">
            A hiring cycle needs an active position with a published
            description.
          </p>
        )}
        {cycles.length === 0 ? (
          <p role="status">No hiring cycles in your scope.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left">
              <caption className="sr-only">Hiring cycles</caption>
              <thead>
                <tr className="border-b">
                  <th scope="col" className="p-2">
                    Code
                  </th>
                  <th scope="col" className="p-2">
                    Label
                  </th>
                  <th scope="col" className="p-2">
                    Placement
                  </th>
                  <th scope="col" className="p-2">
                    Window
                  </th>
                  <th scope="col" className="p-2">
                    Status
                  </th>
                </tr>
              </thead>
              <tbody>
                {cycles.map((c) => (
                  <tr key={c.id} className="border-b">
                    <td className="p-2 font-mono">{c.code}</td>
                    <td className="p-2">
                      <Link
                        href={`/staff/admin/positions/${position.id}/cycles/${c.id}`}
                        className="underline underline-offset-4"
                      >
                        {c.internalLabel}
                      </Link>
                    </td>
                    <td className="p-2">{c.placement}</td>
                    <td className="p-2">{c.window}</td>
                    <td className="p-2">{statusLabels[c.status]}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

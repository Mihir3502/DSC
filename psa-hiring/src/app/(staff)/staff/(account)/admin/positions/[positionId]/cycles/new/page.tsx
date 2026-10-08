import type { Metadata } from "next";
import Link from "next/link";
import { currentRequestHeaders } from "@/app/_auth/auth-messages";
import { newCommandKey, queryCycleForm } from "@/modules/organization";
import { refuseConfigurationAccess } from "@/modules/identity-access/delivery/route-authorization";
import { ConfigForm } from "@/modules/organization/ui/config-form";
import { codeHint } from "@/modules/organization/ui/labels";
import { createHiringCycleAction } from "../../../actions";

// Create a draft hiring cycle: one opening of this position at one active
// branch and optional team (packet M2.1 §12, §16). Only placements where
// the principal may create cycles are offered; the command re-resolves the
// placement from stored rows and authorizes again. Times are entered as
// local wall-clock times in the branch's timezone.

export const metadata: Metadata = { title: "New hiring cycle" };
export const dynamic = "force-dynamic";

export default async function NewCyclePage({
  params,
}: PageProps<"/staff/admin/positions/[positionId]/cycles/new">) {
  const { positionId } = await params;
  const result = await queryCycleForm(
    await currentRequestHeaders(),
    positionId,
  );
  if (result.kind === "UNAUTHENTICATED") {
    refuseConfigurationAccess("UNAUTHENTICATED");
  }
  if (result.kind !== "OK") refuseConfigurationAccess("NOT_FOUND");
  const view = result.view;
  const placements = view.branches.flatMap((b) => [
    { value: b.id, label: `${b.name} (${b.timezone})` },
    ...b.teams.map((t) => ({
      value: `${b.id}/${t.id}`,
      label: `${b.name} · ${t.name} (${b.timezone})`,
    })),
  ]);

  return (
    <div className="flex max-w-2xl flex-col gap-6">
      <Link
        href={`/staff/admin/positions/${view.positionId}`}
        className="underline underline-offset-4"
      >
        Back to {view.positionTitle}
      </Link>
      <h1 className="text-3xl font-semibold tracking-tight">
        New hiring cycle
      </h1>
      <ConfigForm
        action={createHiringCycleAction}
        title="Opening details"
        submitLabel="Create draft hiring cycle"
        hidden={{ commandKey: newCommandKey(), positionId: view.positionId }}
        fields={[
          {
            kind: "select",
            name: "placement",
            label: "Branch and team",
            hint: "The opening's location. It cannot change after creation.",
            options: placements,
            required: true,
          },
          {
            kind: "text",
            name: "code",
            label: "Cycle code",
            hint: codeHint,
            maxLength: 32,
            required: true,
          },
          {
            kind: "text",
            name: "internalLabel",
            label: "Internal label",
            hint: "Staff only; never shown publicly.",
            maxLength: 120,
            required: true,
          },
          {
            kind: "text",
            name: "publicLabel",
            label: "Public label (optional)",
            hint: "Replaces the description's public title for this opening.",
            maxLength: 120,
          },
          {
            kind: "datetime-local",
            name: "opensAt",
            label: "Applications open (inclusive)",
            hint: "Local time in the branch's timezone. Applications are accepted from this moment.",
            required: true,
          },
          {
            kind: "datetime-local",
            name: "closesAt",
            label: "Applications close (exclusive)",
            hint: "Local time in the branch's timezone. Applications stop at exactly this moment. Leave empty only for an open-ended cycle.",
          },
          {
            kind: "checkbox",
            name: "openEnded",
            label: "This cycle is explicitly open-ended (no closing time)",
          },
        ]}
      />
    </div>
  );
}

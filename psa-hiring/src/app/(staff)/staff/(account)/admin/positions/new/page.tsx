import type { Metadata } from "next";
import Link from "next/link";
import { currentRequestHeaders } from "@/app/_auth/auth-messages";
import { newCommandKey, queryPositionForm } from "@/modules/organization";
import { refuseConfigurationAccess } from "@/modules/identity-access/delivery/route-authorization";
import { ConfigForm } from "@/modules/organization/ui/config-form";
import {
  codeHint,
  workerPathHint,
  workerPathOptions,
} from "@/modules/organization/ui/labels";
import { createPositionAction } from "../actions";

// Create a draft reusable position (packet M2.1 §10, §16). Only
// organizations where the principal holds position.create are offered;
// the command authorizes again. A new position starts as DRAFT.

export const metadata: Metadata = { title: "New position" };
export const dynamic = "force-dynamic";

export default async function NewPositionPage() {
  const result = await queryPositionForm(await currentRequestHeaders());
  if (result.kind === "UNAUTHENTICATED") {
    refuseConfigurationAccess("UNAUTHENTICATED");
  }
  if (result.kind !== "OK") refuseConfigurationAccess("NOT_FOUND");
  const { organizations } = result.view;

  return (
    <div className="flex max-w-2xl flex-col gap-6">
      <Link
        href="/staff/admin/positions"
        className="underline underline-offset-4"
      >
        Back to positions
      </Link>
      <h1 className="text-3xl font-semibold tracking-tight">New position</h1>
      <ConfigForm
        action={createPositionAction}
        title="Position details"
        submitLabel="Create draft position"
        hidden={{ commandKey: newCommandKey() }}
        fields={[
          {
            kind: "select",
            name: "organizationId",
            label: "Organization",
            options: organizations.map((o) => ({
              value: o.id,
              label: `${o.name} (${o.code})`,
            })),
            required: true,
          },
          {
            kind: "text",
            name: "code",
            label: "Position code",
            hint: codeHint,
            maxLength: 32,
            required: true,
          },
          {
            kind: "text",
            name: "internalTitle",
            label: "Internal title",
            maxLength: 120,
            required: true,
          },
          {
            kind: "text",
            name: "publicTitle",
            label: "Public title",
            hint: "The default title applicants see.",
            maxLength: 120,
            required: true,
          },
          {
            kind: "select",
            name: "workerPathsAllowed",
            label: "Worker paths",
            hint: workerPathHint,
            options: workerPathOptions,
            defaultValue: "W2_ONLY",
            required: true,
          },
        ]}
      />
    </div>
  );
}

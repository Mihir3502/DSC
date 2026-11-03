import type { Metadata } from "next";
import { currentRequestHeaders } from "@/app/_auth/auth-messages";
import {
  newCandidateCommandKey,
  queryProspectForm,
} from "@/modules/candidates";
import { refuseAccess } from "@/modules/identity-access/delivery/route-authorization";
import { ConfigForm } from "@/modules/organization/ui/config-form";
import { createProspectAction } from "../actions";

// Staff prospect creation (packet M2.2 §13, §18.2). Openings come only from
// the actor's prospect scope; minimal identifying fields; a possible
// duplicate is reported as one generic warning and creating anyway needs an
// explicit confirmation. Staff never set ownership of a candidate account,
// stage, status, or hierarchy.

export const metadata: Metadata = { title: "New prospect" };
export const dynamic = "force-dynamic";

export default async function NewProspectPage() {
  const result = await queryProspectForm(await currentRequestHeaders());
  if (result.kind === "UNAUTHENTICATED")
    refuseAccess("UNAUTHENTICATED", "STAFF");
  if (result.kind !== "OK") refuseAccess("NOT_FOUND", "STAFF");
  const { openings } = result.view;

  return (
    <div className="flex max-w-2xl flex-col gap-6">
      <div className="flex flex-col gap-2">
        <h1 className="text-3xl font-semibold tracking-tight">New prospect</h1>
        <p className="text-muted-foreground">
          Record a person who may apply for an opening. The prospect is not
          linked to any candidate account and no message is sent.
        </p>
      </div>
      {openings.length === 0 ? (
        <p role="status" className="rounded-lg border p-4">
          No opening in your scope is accepting applications right now.
        </p>
      ) : (
        <ConfigForm
          action={createProspectAction}
          title="Prospect details"
          submitLabel="Create prospect"
          hidden={{ commandKey: newCandidateCommandKey() }}
          fields={[
            {
              kind: "select",
              name: "cycleReference",
              label: "Opening",
              required: true,
              options: openings.map((o) => ({
                value: o.reference,
                label: `${o.title} · ${o.location}${o.closes ? ` (closes ${o.closes})` : ""}`,
              })),
            },
            {
              kind: "text",
              name: "legalFirstName",
              label: "Legal first name",
              maxLength: 100,
              required: true,
            },
            {
              kind: "text",
              name: "legalMiddleName",
              label: "Middle name (optional)",
              maxLength: 100,
            },
            {
              kind: "text",
              name: "legalLastName",
              label: "Legal last name",
              maxLength: 100,
              required: true,
            },
            {
              kind: "text",
              name: "preferredName",
              label: "Preferred name (optional)",
              maxLength: 100,
            },
            {
              kind: "text",
              name: "email",
              label: "Email",
              maxLength: 254,
              required: true,
            },
            {
              kind: "text",
              name: "phone",
              label: "Phone (optional)",
              maxLength: 40,
            },
            {
              kind: "checkbox",
              name: "assignToMe",
              label: "Make me the owner of this prospect",
              hint: "Only available if you are allowed to assign owners for this opening.",
            },
            {
              kind: "checkbox",
              name: "acknowledgeDuplicate",
              label: "Create this prospect even if a possible duplicate exists",
              hint: "Possible duplicates are sent to a manager for review. Records are never merged automatically.",
            },
          ]}
        />
      )}
    </div>
  );
}

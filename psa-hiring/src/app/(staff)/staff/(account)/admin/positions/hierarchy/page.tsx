import type { Metadata } from "next";
import Link from "next/link";
import { currentRequestHeaders } from "@/app/_auth/auth-messages";
import { newCommandKey, queryHierarchy } from "@/modules/organization";
import { refuseConfigurationAccess } from "@/modules/identity-access/delivery/route-authorization";
import { ConfigForm } from "@/modules/organization/ui/config-form";
import { ConfirmCommand } from "@/modules/organization/ui/confirm-command";
import {
  changeReasonOptions,
  codeHint,
  statusLabels,
  timezoneHint,
} from "@/modules/organization/ui/labels";
import {
  activateBranchAction,
  activateOrganizationAction,
  activateTeamAction,
  createBranchAction,
  createTeamAction,
  inactivateBranchAction,
  inactivateOrganizationAction,
  inactivateTeamAction,
  updateBranchAction,
  updateOrganizationAction,
  updateTeamAction,
} from "../actions";

// Organization, branch, and team configuration panels (packet M2.1 §7–§8,
// §16). Shows only the hierarchy inside the principal's current scope.
// Changes are PSA Manager actions authorized against the organization-wide
// scope; reparenting is not offered (and is refused by the database).
// Organizations are provisioned outside this screen in M2.1.

export const metadata: Metadata = {
  title: "Organizations, branches, and teams",
};
export const dynamic = "force-dynamic";

type Status = "DRAFT" | "ACTIVE" | "INACTIVE" | "ARCHIVED";

function statusConfirms(
  kind: "organization" | "branch" | "team",
  allowed: boolean,
  entity: Readonly<{
    id: string;
    code: string;
    name: string;
    status: Status;
    version: number;
  }>,
) {
  if (!allowed) return null;
  const hidden = {
    commandKey: newCommandKey(),
    targetId: entity.id,
    expectedVersion: String(entity.version),
  };
  const record = `${entity.name} (${entity.code})`;
  const actions = {
    organization: [activateOrganizationAction, inactivateOrganizationAction],
    branch: [activateBranchAction, inactivateBranchAction],
    team: [activateTeamAction, inactivateTeamAction],
  }[kind];
  if (entity.status === "DRAFT" || entity.status === "INACTIVE") {
    return (
      <ConfirmCommand
        action={actions[0]!}
        label={`Activate ${kind}`}
        title={`Activate this ${kind}?`}
        recordLabel={record}
        result="Active"
        consequence={`Its code becomes permanent. Openings under an active ${kind} can be published and opened. Every parent must already be active.`}
        reasons={changeReasonOptions}
        hidden={hidden}
      />
    );
  }
  if (entity.status === "ACTIVE") {
    return (
      <ConfirmCommand
        action={actions[1]!}
        label={`Inactivate ${kind}`}
        title={`Inactivate this ${kind}?`}
        recordLabel={record}
        result="Inactive"
        consequence={`Openings under this ${kind} stop accepting applications publicly at once, and staff scoped to it lose that scope's authority. History is kept.`}
        reasons={changeReasonOptions}
        hidden={hidden}
        destructive
      />
    );
  }
  return null;
}

export default async function HierarchyPage() {
  const result = await queryHierarchy(await currentRequestHeaders());
  if (result.kind === "UNAUTHENTICATED") {
    refuseConfigurationAccess("UNAUTHENTICATED");
  }
  if (result.kind !== "OK") refuseConfigurationAccess("NOT_FOUND");
  const { organizations } = result.view;

  return (
    <div className="flex flex-col gap-10">
      <Link
        href="/staff/admin/positions"
        className="underline underline-offset-4"
      >
        Back to positions
      </Link>
      <h1 className="text-3xl font-semibold tracking-tight">
        Organizations, branches, and teams
      </h1>
      {organizations.length === 0 ? (
        <p role="status" className="rounded-lg border p-4">
          No organization is in your scope.
        </p>
      ) : null}
      {organizations.map((org) => {
        const can = (action: string) => org.actions.includes(action);
        return (
          <section
            key={org.id}
            aria-labelledby={`org-${org.id}`}
            className="flex flex-col gap-6 rounded-xl border p-4"
          >
            <div className="flex flex-col gap-1">
              <h2 id={`org-${org.id}`} className="text-2xl font-semibold">
                {org.name}
              </h2>
              <p>
                <span className="font-mono">{org.code}</span> ·{" "}
                {statusLabels[org.status]} · {org.timezone}
              </p>
            </div>
            <div className="flex flex-wrap gap-3">
              {statusConfirms(
                "organization",
                can("organization_status_change"),
                org,
              )}
            </div>
            {can("organization_configure") ? (
              <details>
                <summary className="cursor-pointer font-medium">
                  Edit organization
                </summary>
                <ConfigForm
                  action={updateOrganizationAction}
                  title="Organization details"
                  submitLabel="Save organization"
                  hidden={{
                    commandKey: newCommandKey(),
                    organizationId: org.id,
                    expectedVersion: String(org.version),
                  }}
                  fields={[
                    {
                      kind: "text",
                      name: "code",
                      label: "Code",
                      hint: codeHint,
                      defaultValue: org.code,
                      maxLength: 32,
                      readOnly: org.status !== "DRAFT",
                    },
                    {
                      kind: "text",
                      name: "legalName",
                      label: "Legal name",
                      defaultValue: org.legalName,
                      maxLength: 200,
                    },
                    {
                      kind: "text",
                      name: "displayName",
                      label: "Display name",
                      defaultValue: org.name,
                      maxLength: 120,
                    },
                    {
                      kind: "text",
                      name: "timezone",
                      label: "Timezone",
                      hint: timezoneHint,
                      defaultValue: org.timezone,
                      maxLength: 64,
                    },
                  ]}
                />
              </details>
            ) : null}

            <h3 className="text-xl font-semibold">Branches</h3>
            {org.branches.length === 0 ? (
              <p role="status">No branches yet.</p>
            ) : null}
            <ul className="flex flex-col gap-6">
              {org.branches.map((branch) => (
                <li
                  key={branch.id}
                  className="flex flex-col gap-3 border-l-4 pl-4"
                >
                  <p>
                    <span className="font-semibold">{branch.name}</span> (
                    <span className="font-mono">{branch.code}</span>) ·{" "}
                    {statusLabels[branch.status]} · {branch.timezone} · Public
                    location: {branch.publicLocationLabel}
                  </p>
                  <div className="flex flex-wrap gap-3">
                    {statusConfirms(
                      "branch",
                      can("branch_status_change"),
                      branch,
                    )}
                  </div>
                  {can("branch_configure") ? (
                    <details>
                      <summary className="cursor-pointer font-medium">
                        Edit branch {branch.code}
                      </summary>
                      <ConfigForm
                        action={updateBranchAction}
                        title={`Branch ${branch.code}`}
                        submitLabel="Save branch"
                        hidden={{
                          commandKey: newCommandKey(),
                          branchId: branch.id,
                          expectedVersion: String(branch.version),
                        }}
                        fields={[
                          {
                            kind: "text",
                            name: "code",
                            label: "Code",
                            hint: codeHint,
                            defaultValue: branch.code,
                            maxLength: 32,
                            readOnly: branch.status !== "DRAFT",
                          },
                          {
                            kind: "text",
                            name: "name",
                            label: "Name",
                            defaultValue: branch.name,
                            maxLength: 120,
                          },
                          {
                            kind: "text",
                            name: "publicLocationLabel",
                            label: "Public location label",
                            hint: "Shown to the public, for example a city name.",
                            defaultValue: branch.publicLocationLabel,
                            maxLength: 120,
                          },
                          {
                            kind: "text",
                            name: "timezone",
                            label: "Timezone",
                            hint: timezoneHint,
                            defaultValue: branch.timezone,
                            maxLength: 64,
                          },
                        ]}
                      />
                    </details>
                  ) : null}
                  <h4 className="font-semibold">Teams</h4>
                  {branch.teams.length === 0 ? <p>No teams.</p> : null}
                  <ul className="flex flex-col gap-3">
                    {branch.teams.map((team) => (
                      <li key={team.id} className="flex flex-col gap-2">
                        <p>
                          {team.name} (
                          <span className="font-mono">{team.code}</span>) ·{" "}
                          {statusLabels[team.status]}
                        </p>
                        <div className="flex flex-wrap gap-3">
                          {statusConfirms(
                            "team",
                            can("team_status_change"),
                            team,
                          )}
                        </div>
                        {can("team_configure") ? (
                          <details>
                            <summary className="cursor-pointer font-medium">
                              Edit team {team.code}
                            </summary>
                            <ConfigForm
                              action={updateTeamAction}
                              title={`Team ${team.code}`}
                              submitLabel="Save team"
                              hidden={{
                                commandKey: newCommandKey(),
                                teamId: team.id,
                                expectedVersion: String(team.version),
                              }}
                              fields={[
                                {
                                  kind: "text",
                                  name: "code",
                                  label: "Code",
                                  hint: codeHint,
                                  defaultValue: team.code,
                                  maxLength: 32,
                                  readOnly: team.status !== "DRAFT",
                                },
                                {
                                  kind: "text",
                                  name: "name",
                                  label: "Name",
                                  defaultValue: team.name,
                                  maxLength: 120,
                                },
                              ]}
                            />
                          </details>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                  {can("team_configure") && branch.status !== "ARCHIVED" ? (
                    <details>
                      <summary className="cursor-pointer font-medium">
                        Add a team to {branch.code}
                      </summary>
                      <ConfigForm
                        action={createTeamAction}
                        title={`New team in ${branch.code}`}
                        submitLabel="Create draft team"
                        hidden={{
                          commandKey: newCommandKey(),
                          branchId: branch.id,
                        }}
                        fields={[
                          {
                            kind: "text",
                            name: "code",
                            label: "Code",
                            hint: codeHint,
                            maxLength: 32,
                          },
                          {
                            kind: "text",
                            name: "name",
                            label: "Name",
                            maxLength: 120,
                          },
                        ]}
                      />
                    </details>
                  ) : null}
                </li>
              ))}
            </ul>
            {can("branch_configure") ? (
              <details>
                <summary className="cursor-pointer font-medium">
                  Add a branch
                </summary>
                <ConfigForm
                  action={createBranchAction}
                  title="New branch"
                  submitLabel="Create draft branch"
                  hidden={{
                    commandKey: newCommandKey(),
                    organizationId: org.id,
                  }}
                  fields={[
                    {
                      kind: "text",
                      name: "code",
                      label: "Code",
                      hint: codeHint,
                      maxLength: 32,
                    },
                    {
                      kind: "text",
                      name: "name",
                      label: "Name",
                      maxLength: 120,
                    },
                    {
                      kind: "text",
                      name: "publicLocationLabel",
                      label: "Public location label",
                      hint: "Shown to the public, for example a city name.",
                      maxLength: 120,
                    },
                    {
                      kind: "text",
                      name: "timezone",
                      label: "Timezone",
                      hint: `${timezoneHint} Pre-filled with the organization's timezone; confirm or change it.`,
                      defaultValue: org.timezone,
                      maxLength: 64,
                    },
                  ]}
                />
              </details>
            ) : null}
          </section>
        );
      })}
    </div>
  );
}

import { currentRequestHeaders } from "@/app/_auth/auth-messages";
import { queryCandidateWorkspaceShell } from "@/modules/candidates";
import { HoldIndicator } from "@/modules/candidates/ui/hold-indicator";
import { WorkspaceTabs } from "@/modules/candidates/ui/workspace-tabs";
import { refuseAccess } from "@/modules/identity-access/delivery/route-authorization";

// Candidate workspace shell (packet M3.2; UI_FLOW §10): a stable summary header
// and permission-aware tabs around each tab's page. Each page authorizes again
// through its own query. Statuses are labels here, never inputs. The tab title
// and URL carry no personal data.

export const dynamic = "force-dynamic";

export default async function CandidateWorkspaceLayout({
  params,
  children,
}: LayoutProps<"/staff/candidates/[candidacyId]">) {
  const { candidacyId } = await params;
  const result = await queryCandidateWorkspaceShell(
    await currentRequestHeaders(),
    candidacyId,
  );
  if (result.kind === "UNAUTHENTICATED") {
    refuseAccess("UNAUTHENTICATED", "STAFF");
  }
  if (result.kind !== "OK") refuseAccess("NOT_FOUND", "STAFF");
  const view = result.view;
  const fields: readonly (readonly [string, string])[] = [
    ["Position", view.position],
    ["Branch", view.branch],
    ["Stage", view.stage],
    ["Candidate sees", view.status],
    ["Proposed worker path", view.workerPath],
    ["Owner", view.owner],
    ["Next action", view.nextAction],
    ["Due (UTC)", view.dueDate ?? "No due date"],
  ];
  return (
    <div className="flex max-w-4xl flex-col gap-6">
      <header className="flex flex-col gap-3">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <h1 className="text-3xl font-semibold tracking-tight [overflow-wrap:anywhere]">
            {view.displayName}
          </h1>
          <span className="font-mono">{view.reference}</span>
        </div>
        <HoldIndicator hold={view.hold} />
        {view.closed ? (
          <p role="note" className="rounded-lg border p-3">
            This record is closed.
          </p>
        ) : null}
        <dl className="grid gap-x-6 gap-y-1 [overflow-wrap:anywhere] sm:grid-cols-2">
          {fields.map(([term, value]) => (
            <div key={term} className="flex gap-2">
              <dt className="font-medium">{term}:</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      </header>
      <WorkspaceTabs tabs={view.tabs} />
      {children}
    </div>
  );
}

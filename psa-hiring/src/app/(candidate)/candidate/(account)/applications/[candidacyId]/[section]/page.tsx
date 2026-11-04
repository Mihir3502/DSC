import type { Metadata } from "next";
import { queryApplicationSection } from "@/modules/applications";
import { ApplicationSectionForm } from "@/modules/applications/ui/application-section-form";
import { currentRequestHeaders } from "@/app/_auth/auth-messages";
import { refuseAccess } from "@/modules/identity-access/delivery/route-authorization";
import { saveApplicationSectionAction } from "../actions";

// One section of the candidate's application draft (packet M2.4; UI_FLOW
// §7.3). The title stays generic so no answer or reference reaches the
// browser tab or history.

export const metadata: Metadata = { title: "Application section" };
export const dynamic = "force-dynamic";

export default async function ApplicationSectionPage({
  params,
}: PageProps<"/candidate/applications/[candidacyId]/[section]">) {
  const { candidacyId, section } = await params;
  const result = await queryApplicationSection(
    await currentRequestHeaders(),
    candidacyId,
    section,
  );
  if (result.kind !== "OK") {
    return refuseAccess(
      result.kind === "UNAUTHENTICATED" ? "UNAUTHENTICATED" : "NOT_FOUND",
      "CANDIDATE",
    );
  }
  const view = result.view;
  return (
    <div className="flex max-w-2xl flex-col gap-6">
      <div className="flex flex-col gap-2">
        <h1 className="text-3xl font-semibold tracking-tight">{view.title}</h1>
        <p>{view.description}</p>
      </div>
      {view.correction ? (
        <section
          aria-label="What we asked you to correct"
          className="flex flex-col gap-1 rounded-lg border-2 border-foreground p-4 [overflow-wrap:anywhere]"
        >
          <p className="font-medium">{view.correction.reason}</p>
          <p className="whitespace-pre-wrap">{view.correction.instructions}</p>
        </section>
      ) : null}
      <ApplicationSectionForm
        action={saveApplicationSectionAction}
        candidacyId={view.candidacyId}
        sectionCode={view.code}
        initialVersion={view.version}
        initialStatus={view.status}
        initialSaved={view.lastSaved}
        fields={view.fields}
        overviewPath={`/candidate/applications/${view.candidacyId}`}
        previous={view.previous}
        next={view.next}
      />
    </div>
  );
}

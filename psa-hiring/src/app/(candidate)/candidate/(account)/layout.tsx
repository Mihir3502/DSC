import { currentRequestHeaders } from "@/app/_auth/auth-messages";
import { Button } from "@/components/ui/button";
import { queryCandidateShell } from "@/modules/candidates";
import { CandidateNavigation } from "@/modules/candidates/ui/candidate-navigation";
import { guardNavigation } from "@/modules/identity-access/delivery/route-authorization";
import { signOutAction } from "./security/actions";

// Candidate portal shell (packets M1.5 §8, M2.3 §12). The guard is a
// navigation convenience: an anonymous browser goes to candidate sign-in, and
// a staff or service principal sees the same safe not-found as an unknown
// page. Every page and action below authorizes again through its own query or
// command, and nothing computed here is passed down or trusted.
export const dynamic = "force-dynamic";

export default async function CandidateAccountLayout({
  children,
}: LayoutProps<"/candidate">) {
  await guardNavigation("CANDIDATE");
  const shell = await queryCandidateShell(await currentRequestHeaders());
  if (shell.kind !== "OK") return children;
  const agency = shell.view.agencyName;
  return (
    <div className="flex flex-col gap-6">
      {agency || shell.view.displayName ? (
        <p className="text-sm [overflow-wrap:anywhere]">
          {agency ? <span className="font-medium">{agency}</span> : null}
          {agency && shell.view.displayName ? " · " : null}
          {shell.view.displayName
            ? `Signed in as ${shell.view.displayName}`
            : null}
        </p>
      ) : null}
      <CandidateNavigation
        entries={shell.view.navigation}
        signOut={
          <form action={signOutAction}>
            <Button
              type="submit"
              variant="outline"
              className="min-h-11 md:min-h-8"
            >
              Sign out
            </Button>
          </form>
        }
      />
      {children}
    </div>
  );
}

import { currentRequestHeaders } from "@/app/_auth/auth-messages";
import { Button } from "@/components/ui/button";
import { queryStaffShell } from "@/modules/candidates";
import { CandidateNavigation } from "@/modules/candidates/ui/candidate-navigation";
import { guardNavigation } from "@/modules/identity-access/delivery/route-authorization";
import { staffSignOutAction } from "./security/actions";

// Staff account route group (packets M1.5 §8, M3.1). Navigation convenience
// only: an anonymous or password-only (MFA-incomplete) browser goes to staff
// sign-in and a candidate or service principal sees the same safe not-found as
// an unknown page. Links appear only for what's built and permitted. Every page
// and action below authorizes again through its application query or command;
// nothing computed here is passed down or trusted.
export const dynamic = "force-dynamic";

export default async function StaffAccountLayout({
  children,
}: LayoutProps<"/staff">) {
  await guardNavigation("STAFF");
  const shell = await queryStaffShell(await currentRequestHeaders());
  if (shell.kind !== "OK") return children;
  return (
    <div className="flex flex-col gap-6">
      <CandidateNavigation
        label="Staff"
        home="/staff"
        entries={shell.view.navigation}
        signOut={
          <form action={staffSignOutAction}>
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

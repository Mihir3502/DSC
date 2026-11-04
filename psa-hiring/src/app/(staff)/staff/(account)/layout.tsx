import Link from "next/link";
import { currentRequestHeaders } from "@/app/_auth/auth-messages";
import { queryStaffShell } from "@/modules/candidates";
import { guardNavigation } from "@/modules/identity-access/delivery/route-authorization";

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
  return (
    <div className="flex flex-col gap-6">
      {shell.kind === "OK" ? (
        <nav aria-label="Staff">
          <ul className="flex flex-wrap gap-x-4 gap-y-1">
            {shell.view.navigation.map((entry) => (
              <li key={entry.href}>
                <Link
                  prefetch={false}
                  href={entry.href}
                  className="inline-flex min-h-11 items-center font-medium underline underline-offset-4 md:min-h-8"
                >
                  {entry.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      ) : null}
      {children}
    </div>
  );
}

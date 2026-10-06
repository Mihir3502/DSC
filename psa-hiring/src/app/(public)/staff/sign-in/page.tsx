import type { Metadata } from "next";
import { staffSignInNotices } from "@/app/_auth/staff-messages";
import { AuthPage } from "@/modules/identity-access/ui/auth-page";
import { StaffSignInForm } from "@/modules/identity-access/ui/staff-auth-forms";
import { staffSignInAction } from "../staff-auth-actions";

// Staff first factor (packet M1.3 §11.1). A correct password only starts
// the second-factor step; it never signs a staff member in by itself.
export const metadata: Metadata = { title: "Staff sign in" };
export const dynamic = "force-dynamic";

export default async function StaffSignInPage({
  searchParams,
}: PageProps<"/staff/sign-in">) {
  const { notice } = await searchParams;
  const text =
    typeof notice === "string" && Object.hasOwn(staffSignInNotices, notice)
      ? staffSignInNotices[notice]
      : undefined;
  return (
    <AuthPage
      title="Staff sign in"
      intro={
        <p>
          Staff accounts are invitation-only and always need your password and a
          code from your authenticator app.
        </p>
      }
    >
      <StaffSignInForm action={staffSignInAction} notice={text} />
    </AuthPage>
  );
}

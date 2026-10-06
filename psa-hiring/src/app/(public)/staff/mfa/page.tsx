import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { hasStaffChallenge } from "@/modules/identity-access";
import { AuthPage } from "@/modules/identity-access/ui/auth-page";
import { StaffMfaForm } from "@/modules/identity-access/ui/staff-auth-forms";
import { staffMfaAction } from "../staff-auth-actions";

// Staff second factor (packet M1.3 §11.2). Reached only with the short-lived
// challenge cookie set after a correct password; the server validates the
// challenge again on submit.
export const metadata: Metadata = { title: "Staff verification" };
export const dynamic = "force-dynamic";

export default async function StaffMfaPage() {
  if (!hasStaffChallenge(await headers())) redirect("/staff/sign-in");
  return (
    <AuthPage
      title="Verify it is you"
      intro={
        <p>
          Enter the current code from your authenticator app. If you cannot use
          the app, use one of your backup codes.
        </p>
      }
    >
      <StaffMfaForm action={staffMfaAction} />
    </AuthPage>
  );
}

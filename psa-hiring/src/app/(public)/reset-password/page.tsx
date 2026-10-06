import type { Metadata } from "next";
import { AuthPage } from "@/modules/identity-access/ui/auth-page";
import { ResetPasswordForm } from "@/modules/identity-access/ui/candidate-auth-forms";
import { resetPasswordAction } from "../auth-actions";

// The reset capability arrives in the URL fragment and is removed from the
// address bar before the form renders. The title is generic.
export const metadata: Metadata = { title: "Choose a new password" };
export const dynamic = "force-dynamic";

export default function ResetPasswordPage() {
  return (
    <AuthPage title="Choose a new password">
      <ResetPasswordForm action={resetPasswordAction} />
    </AuthPage>
  );
}

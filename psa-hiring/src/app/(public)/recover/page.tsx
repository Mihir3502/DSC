import type { Metadata } from "next";
import { AuthPage } from "@/modules/identity-access/ui/auth-page";
import { RecoverForm } from "@/modules/identity-access/ui/candidate-auth-forms";
import { recoverAction } from "../auth-actions";

export const metadata: Metadata = { title: "Reset your password" };
export const dynamic = "force-dynamic";

export default function RecoverPage() {
  return (
    <AuthPage
      title="Reset your password"
      intro={
        <p>
          Enter the email address for your candidate account. If the account can
          reset its password, we will email it a link.
        </p>
      }
    >
      <RecoverForm action={recoverAction} />
    </AuthPage>
  );
}

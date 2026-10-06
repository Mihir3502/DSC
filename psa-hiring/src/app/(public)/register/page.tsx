import type { Metadata } from "next";
import { issuePublicRegistrationIntent } from "@/modules/identity-access";
import { AuthPage } from "@/modules/identity-access/ui/auth-page";
import { RegisterForm } from "@/modules/identity-access/ui/candidate-auth-forms";
import { registerAction } from "../auth-actions";

export const metadata: Metadata = { title: "Create a candidate account" };
// A fresh, short-lived signed registration intent on every request.
export const dynamic = "force-dynamic";

export default function RegisterPage() {
  return (
    <AuthPage
      title="Create a candidate account"
      intro={
        <p>
          Enter your email address and choose a password. We will email you a
          code to confirm the address. No other information is collected at this
          step.
        </p>
      }
    >
      <RegisterForm
        action={registerAction}
        publicIntent={issuePublicRegistrationIntent()}
      />
    </AuthPage>
  );
}

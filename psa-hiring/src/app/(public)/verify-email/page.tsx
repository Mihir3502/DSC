import type { Metadata } from "next";
import { OTP_LENGTH } from "@/modules/identity-access";
import { AuthPage } from "@/modules/identity-access/ui/auth-page";
import { VerifyEmailForm } from "@/modules/identity-access/ui/candidate-auth-forms";
import { resendCodeAction, verifyEmailAction } from "../auth-actions";

export const metadata: Metadata = { title: "Verify your email address" };
export const dynamic = "force-dynamic";

export default function VerifyEmailPage() {
  return (
    <AuthPage
      title="Verify your email address"
      intro={
        <p>
          Enter the email address you registered with and the{" "}
          {`${OTP_LENGTH}-digit`} code we sent to it. Each code works once and
          expires after a short time.
        </p>
      }
    >
      <VerifyEmailForm
        verifyAction={verifyEmailAction}
        resendAction={resendCodeAction}
        codeLength={OTP_LENGTH}
      />
    </AuthPage>
  );
}

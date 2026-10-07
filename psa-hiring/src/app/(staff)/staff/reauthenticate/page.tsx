import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { currentRequestHeaders } from "@/app/_auth/auth-messages";
import {
  isInlineReauthenticationPurpose,
  isReauthenticationPurpose,
  resolveCurrentStaff,
} from "@/modules/identity-access";
import { AuthPage } from "@/modules/identity-access/ui/auth-page";
import { StaffReauthenticateForm } from "@/modules/identity-access/ui/staff-auth-forms";
import { reauthenticateAction } from "../security/actions";

// Recent-authentication challenge (packet M1.3 §13.4). The purpose is a key
// from a closed registry, never a URL or action; anything else falls back
// to the general security purpose, and the server resolves the destination.
export const metadata: Metadata = { title: "Confirm it is you" };
export const dynamic = "force-dynamic";

export default async function StaffReauthenticatePage({
  searchParams,
}: PageProps<"/staff/reauthenticate">) {
  if (!(await resolveCurrentStaff(await currentRequestHeaders()))) {
    redirect("/staff/sign-in");
  }
  const { purpose } = await searchParams;
  const key =
    isReauthenticationPurpose(purpose) &&
    !isInlineReauthenticationPurpose(purpose)
      ? purpose
      : "STAFF_SECURITY";
  return (
    <AuthPage
      title="Confirm it is you"
      intro={
        <p>
          {key === "CHANGE_PASSWORD"
            ? "Changing your password needs a recent confirmation. "
            : "This action needs a recent confirmation. "}
          Enter your password and the current code from your authenticator app.
        </p>
      }
    >
      <StaffReauthenticateForm action={reauthenticateAction} purpose={key} />
    </AuthPage>
  );
}

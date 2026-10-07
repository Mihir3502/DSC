import type { Metadata } from "next";
import { currentRequestHeaders } from "@/app/_auth/auth-messages";
import {
  isInlineReauthenticationPurpose,
  isReauthenticationPurpose,
  queryStaffReauthentication,
} from "@/modules/identity-access";
import { refuseAccess } from "@/modules/identity-access/delivery/route-authorization";
import { AuthPage } from "@/modules/identity-access/ui/auth-page";
import { StaffReauthenticateForm } from "@/modules/identity-access/ui/staff-auth-forms";
import { reauthenticateAction } from "../security/actions";

// Recent-authentication challenge (packet M1.3 §13.4). The purpose is a key
// from a closed registry, never a URL or action; anything else falls back
// to the general security purpose, and the server resolves the destination.
// M1.5: the STAFF_REAUTHENTICATE policy is evaluated here, independently of
// the route-group guard; after a successful step-up the destination page
// runs its own full authorization again (no allow result is carried over).
export const metadata: Metadata = { title: "Confirm it is you" };
export const dynamic = "force-dynamic";

export default async function StaffReauthenticatePage({
  searchParams,
}: PageProps<"/staff/reauthenticate">) {
  const access = await queryStaffReauthentication(
    await currentRequestHeaders(),
  );
  if (access.kind !== "OK") refuseAccess(access.kind, "STAFF");
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

import type { Metadata } from "next";
import { AuthPage } from "@/modules/identity-access/ui/auth-page";
import { StaffActivationFlow } from "@/modules/identity-access/ui/staff-auth-forms";
import {
  beginActivationAction,
  completeActivationAction,
  verifyEnrollmentAction,
} from "../staff-auth-actions";

// Staff invitation acceptance (packet M1.3 §9). The capability arrives in
// the URL fragment and is removed from the address bar before the form
// renders. The page title is generic and never contains secrets.
export const metadata: Metadata = { title: "Activate staff account" };
export const dynamic = "force-dynamic";

export default function StaffActivatePage() {
  return (
    <AuthPage
      title="Activate your staff account"
      intro={
        <p>
          Activation has three steps: create a password, set up an authenticator
          app, and save your backup codes. Your account becomes active only
          after all three.
        </p>
      }
    >
      <StaffActivationFlow
        beginAction={beginActivationAction}
        verifyAction={verifyEnrollmentAction}
        completeAction={completeActivationAction}
      />
    </AuthPage>
  );
}

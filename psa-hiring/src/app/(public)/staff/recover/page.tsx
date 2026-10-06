import type { Metadata } from "next";
import { AuthPage } from "@/modules/identity-access/ui/auth-page";
import { StaffRecoveryForm } from "@/modules/identity-access/ui/staff-auth-forms";
import { staffRecoveryAction } from "../staff-auth-actions";

// Generic staff recovery request (packet M1.3 §14.1). It may open a bounded
// administrative case and always shows the same confirmation. Nothing is
// reset from here: an administrator must verify identity outside the
// application and a different person must approve.
export const metadata: Metadata = { title: "Staff account help" };
export const dynamic = "force-dynamic";

const reasons = [
  { value: "UNSPECIFIED", label: "Choose a reason (optional)" },
  {
    value: "LOST_AUTHENTICATOR",
    label: "I lost my authenticator app or device",
  },
  { value: "FORGOTTEN_PASSWORD", label: "I forgot my password" },
  { value: "SUSPECTED_COMPROMISE", label: "I think my account was misused" },
] as const;

export default function StaffRecoverPage() {
  return (
    <AuthPage
      title="Get help signing in"
      intro={
        <p>
          Staff sign-in cannot be reset by email alone. Submit a request, then
          contact your administrator, who will verify your identity before
          anything changes.
        </p>
      }
    >
      <StaffRecoveryForm action={staffRecoveryAction} reasons={reasons} />
    </AuthPage>
  );
}

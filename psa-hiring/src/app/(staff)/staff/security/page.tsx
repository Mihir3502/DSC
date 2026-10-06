import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Button } from "@/components/ui/button";
import { currentRequestHeaders } from "@/app/_auth/auth-messages";
import { getStaffSecurityOverview } from "@/modules/identity-access";
import { ChangePasswordForm } from "@/modules/identity-access/ui/candidate-auth-forms";
import { RegenerateBackupCodesForm } from "@/modules/identity-access/ui/staff-auth-forms";
import {
  regenerateBackupCodesAction,
  revokeOtherStaffSessionsAction,
  revokeStaffSessionAction,
  staffChangePasswordAction,
  staffSignOutAction,
  staffSignOutEverywhereAction,
} from "./actions";

// The only authenticated staff page in M1.3 (packet §12, AC-M1.3-11):
// account, two-step verification, password, and session controls. No
// roles, permissions, scopes, branch/team, candidate records, queues,
// dashboards, reports, or administration. The TOTP secret and existing
// backup codes are never shown.

export const metadata: Metadata = { title: "Staff account security" };
export const dynamic = "force-dynamic";

const notices: Record<string, string> = {
  revoked: "The session was signed out.",
  "others-revoked": "All other sessions were signed out.",
  "not-found": "That session is no longer active.",
};

const dateFormat = new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "UTC",
});

function formatUtc(date: Date) {
  return `${dateFormat.format(date)} UTC`;
}

const methodLabels: Record<string, string> = {
  PASSWORD_TOTP: "password and authenticator app code",
  PASSWORD_BACKUP_CODE: "password and a backup code",
};

export default async function StaffSecurityPage({
  searchParams,
}: PageProps<"/staff/security">) {
  const overview = await getStaffSecurityOverview(
    await currentRequestHeaders(),
  );
  if (!overview) redirect("/staff/sign-in");
  const { notice } = await searchParams;
  const noticeText =
    typeof notice === "string" && Object.hasOwn(notices, notice)
      ? notices[notice]
      : undefined;
  const others = overview.sessions.filter((s) => !s.current).length;
  const recent = overview.recentAuthentication;
  const window =
    recent.windowSeconds < 60
      ? `${recent.windowSeconds} seconds`
      : `${Math.round(recent.windowSeconds / 60)} minutes`;

  return (
    <div className="flex flex-col gap-10">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex flex-col gap-2">
          <h1 className="text-3xl font-semibold tracking-tight">
            Staff account security
          </h1>
          <p className="text-muted-foreground">
            Signed in as {overview.maskedEmail}
            {overview.signedInWith
              ? ` using your ${methodLabels[overview.signedInWith] ?? "password and a second step"}`
              : ""}
          </p>
        </div>
        <form action={staffSignOutAction}>
          <Button type="submit" variant="outline" size="lg">
            Sign out
          </Button>
        </form>
      </div>

      {noticeText ? (
        <p role="status" className="rounded-lg border p-3">
          {noticeText}
        </p>
      ) : null}

      <section
        aria-labelledby="mfa-heading"
        className="flex max-w-2xl flex-col gap-3"
      >
        <h2 id="mfa-heading" className="text-xl font-semibold">
          Two-step verification
        </h2>
        <p>
          <strong>On</strong>: authenticator app (time-based codes). Required
          for every staff account and cannot be turned off.
        </p>
        <p>
          {recent.recent
            ? `You confirmed your identity recently${recent.at ? ` (${formatUtc(recent.at)})` : ""}. Sensitive changes are allowed for up to ${window} after a confirmation.`
            : `You have not confirmed your identity in the last ${window}. Sensitive changes will ask for your password and an authenticator code first.`}
        </p>
        <h3 className="text-lg font-semibold">Backup codes</h3>
        <p className="text-muted-foreground">
          Existing backup codes are never shown again. Creating new codes stops
          every earlier code from working. You need your password and a current
          authenticator code.
        </p>
        <RegenerateBackupCodesForm action={regenerateBackupCodesAction} />
        <h3 className="text-lg font-semibold">Lost your authenticator?</h3>
        <p>
          Use a backup code to sign in, then create new codes. If you have no
          backup codes left, an administrator must verify your identity and
          reset your sign-in; use{" "}
          <Link
            href="/staff/recover"
            className="font-medium text-primary underline underline-offset-4"
          >
            staff account help
          </Link>{" "}
          and contact your administrator.
        </p>
      </section>

      <section
        id="password"
        aria-labelledby="password-heading"
        className="flex max-w-xl flex-col gap-4"
      >
        <h2 id="password-heading" className="text-xl font-semibold">
          Change password
        </h2>
        <p className="text-muted-foreground">
          Changing your password signs out every session, including this one. If
          you have not confirmed your identity recently, you will be asked to
          first.
        </p>
        <ChangePasswordForm action={staffChangePasswordAction} />
      </section>

      <section
        aria-labelledby="sessions-heading"
        className="flex flex-col gap-4"
      >
        <h2 id="sessions-heading" className="text-xl font-semibold">
          Signed-in sessions
        </h2>
        <ul className="flex flex-col gap-3">
          {overview.sessions.map((session) => (
            <li
              key={session.ref}
              className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-4"
            >
              <div className="flex flex-col gap-1">
                <p className="font-medium">
                  {session.deviceLabel}
                  {session.current ? " (this session)" : ""}
                </p>
                <p className="text-sm text-muted-foreground">
                  Signed in {formatUtc(session.createdAt)} · Last active{" "}
                  {formatUtc(session.lastActiveAt)} · Expires{" "}
                  {formatUtc(session.expiresAt)}
                </p>
              </div>
              <form action={revokeStaffSessionAction}>
                <input type="hidden" name="session" value={session.ref} />
                <Button type="submit" variant="outline">
                  {session.current
                    ? "Sign out this session"
                    : `Sign out ${session.deviceLabel} session`}
                </Button>
              </form>
            </li>
          ))}
        </ul>
        <div className="flex flex-wrap gap-3">
          {others > 0 ? (
            <form action={revokeOtherStaffSessionsAction}>
              <Button type="submit" variant="outline" size="lg">
                Sign out all other sessions
              </Button>
            </form>
          ) : null}
          <form action={staffSignOutEverywhereAction}>
            <Button type="submit" variant="outline" size="lg">
              Sign out everywhere
            </Button>
          </form>
        </div>
      </section>
    </div>
  );
}

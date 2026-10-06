import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Button } from "@/components/ui/button";
import { currentRequestHeaders } from "@/app/_auth/auth-messages";
import { getCandidateSecurityOverview } from "@/modules/identity-access";
import { ChangePasswordForm } from "@/modules/identity-access/ui/candidate-auth-forms";
import {
  changePasswordAction,
  revokeOtherSessionsAction,
  revokeSessionAction,
  signOutAction,
  signOutEverywhereAction,
} from "./actions";

// Candidate account security (packet M1.2 §13). Rendered only for an
// active, verified candidate session resolved on the server; shows a masked
// email, verification status, password change, and the candidate's own
// sessions by opaque reference (never tokens, IPs, or full user agents).

export const metadata: Metadata = { title: "Account security" };
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

export default async function CandidateSecurityPage({
  searchParams,
}: PageProps<"/candidate/security">) {
  const overview = await getCandidateSecurityOverview(
    await currentRequestHeaders(),
  );
  if (!overview) redirect("/sign-in");
  const { notice } = await searchParams;
  const noticeText =
    typeof notice === "string" && Object.hasOwn(notices, notice)
      ? notices[notice]
      : undefined;
  const others = overview.sessions.filter((s) => !s.current).length;

  return (
    <div className="flex flex-col gap-10">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex flex-col gap-2">
          <h1 className="text-3xl font-semibold tracking-tight">
            Account security
          </h1>
          <p className="text-muted-foreground">
            Signed in as {overview.maskedEmail}
          </p>
        </div>
        <form action={signOutAction}>
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

      <section aria-labelledby="email-heading" className="flex flex-col gap-2">
        <h2 id="email-heading" className="text-xl font-semibold">
          Email address
        </h2>
        <p>
          {overview.maskedEmail}:{" "}
          <strong>
            {overview.emailVerified ? "Verified" : "Not verified"}
          </strong>
        </p>
      </section>

      <section
        aria-labelledby="password-heading"
        className="flex max-w-xl flex-col gap-4"
      >
        <h2 id="password-heading" className="text-xl font-semibold">
          Change password
        </h2>
        <p className="text-muted-foreground">
          Changing your password signs out every other session.
        </p>
        <ChangePasswordForm action={changePasswordAction} />
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
              <form action={revokeSessionAction}>
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
            <form action={revokeOtherSessionsAction}>
              <Button type="submit" variant="outline" size="lg">
                Sign out all other sessions
              </Button>
            </form>
          ) : null}
          <form action={signOutEverywhereAction}>
            <Button type="submit" variant="outline" size="lg">
              Sign out everywhere
            </Button>
          </form>
        </div>
      </section>
    </div>
  );
}

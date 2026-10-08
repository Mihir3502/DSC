import type { Metadata } from "next";
import Link from "next/link";
import { cookies } from "next/headers";
import { currentRequestHeaders } from "@/app/_auth/auth-messages";
import { applicationHandoffCookie } from "@/modules/identity-access";
import { refuseAccess } from "@/modules/identity-access/delivery/route-authorization";
import { confirmApplicationHandoff } from "@/modules/organization";

// The M2.2 start-application boundary (packet M2.1 §19). M2.1 only
// confirms that the signed handoff is valid and its opening still accepts
// applications (re-checked without any cache). It creates no person,
// candidacy, application, or ownership record; M2.2 replaces this page
// with the real application start.

export const metadata: Metadata = { title: "Your application" };
export const dynamic = "force-dynamic";

export default async function ApplicationStartPage() {
  const token = (await cookies()).get(applicationHandoffCookie().name)?.value;
  const result = await confirmApplicationHandoff(
    await currentRequestHeaders(),
    token,
  );
  if (result.kind === "UNAUTHENTICATED") {
    refuseAccess("UNAUTHENTICATED", "CANDIDATE");
  }

  return (
    <div className="flex max-w-2xl flex-col gap-6">
      <h1 className="text-3xl font-semibold tracking-tight">
        Your application
      </h1>
      {result.kind === "CONFIRMED" ? (
        <div
          role="status"
          className="flex flex-col gap-2 rounded-lg border p-4"
        >
          <p className="font-medium">
            We have noted your interest in {result.title} ({result.location}).
          </p>
          {result.closes ? <p>{result.closes}.</p> : null}
          <p>
            The online application form is not available yet. No application has
            been started or submitted, and no information has been shared with
            the agency.
          </p>
        </div>
      ) : result.kind === "NONE" ? (
        <p role="status" className="rounded-lg border p-4">
          Choose a position to start an application.
        </p>
      ) : (
        <p role="status" className="rounded-lg border p-4">
          This position is no longer accepting applications, or your link has
          expired.
        </p>
      )}
      <Link href="/positions" className="underline underline-offset-4">
        See open positions
      </Link>
    </div>
  );
}

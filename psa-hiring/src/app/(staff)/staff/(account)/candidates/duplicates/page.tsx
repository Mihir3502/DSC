import type { Metadata } from "next";
import Link from "next/link";
import { currentRequestHeaders } from "@/app/_auth/auth-messages";
import { queryDuplicateQueue } from "@/modules/candidates";
import {
  refuseAccess,
  refuseIdentityReviewAccess,
} from "@/modules/identity-access/delivery/route-authorization";

// Possible-duplicate queue (packet M2.2 §15, §18.3). PSA Manager only, at
// organization scope, behind a recent identity-review step-up. Rows carry
// no personal data: a case link, confidence tier, status, and date.

export const metadata: Metadata = { title: "Possible duplicates" };
export const dynamic = "force-dynamic";

export default async function DuplicateQueuePage() {
  const result = await queryDuplicateQueue(await currentRequestHeaders());
  if (result.kind === "UNAUTHENTICATED")
    refuseAccess("UNAUTHENTICATED", "STAFF");
  if (result.kind === "REAUTHENTICATION_REQUIRED") {
    refuseIdentityReviewAccess("REAUTHENTICATION_REQUIRED");
  }
  if (result.kind !== "OK") refuseAccess("NOT_FOUND", "STAFF");
  const { cases } = result.view;

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <div className="flex flex-col gap-2">
        <h1 className="text-3xl font-semibold tracking-tight">
          Possible duplicates
        </h1>
        <p className="text-muted-foreground">
          Records that share an exact email address or phone number. Matches are
          suggestions only; nothing is merged unless you confirm it.
        </p>
      </div>
      {cases.length === 0 ? (
        <p role="status" className="rounded-lg border p-4">
          There are no possible duplicates to review.
        </p>
      ) : (
        <table className="w-full border-collapse text-left">
          <caption className="sr-only">Open possible-duplicate cases</caption>
          <thead>
            <tr className="border-b">
              <th scope="col" className="py-2 pr-4">
                Case
              </th>
              <th scope="col" className="py-2 pr-4">
                Confidence
              </th>
              <th scope="col" className="py-2 pr-4">
                Status
              </th>
              <th scope="col" className="py-2">
                Found
              </th>
            </tr>
          </thead>
          <tbody>
            {cases.map((c) => (
              <tr key={c.id} className="border-b">
                <td className="py-2 pr-4">
                  <Link
                    href={`/staff/candidates/duplicates/${c.id}`}
                    className="underline underline-offset-4"
                  >
                    Review case {c.id.slice(0, 4).toUpperCase()}
                  </Link>
                </td>
                <td className="py-2 pr-4">
                  {c.tier === "HIGH" ? "High" : "Medium"}
                </td>
                <td className="py-2 pr-4">{c.status}</td>
                <td className="py-2">{c.created}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

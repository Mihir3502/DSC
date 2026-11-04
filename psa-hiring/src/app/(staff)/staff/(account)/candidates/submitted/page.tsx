import type { Metadata } from "next";
import Link from "next/link";
import { currentRequestHeaders } from "@/app/_auth/auth-messages";
import { querySubmittedQueue } from "@/modules/candidates";
import { refuseAccess } from "@/modules/identity-access/delivery/route-authorization";

// Submitted applications waiting for review (packet M2.6). A narrow list only:
// assignment, review, and the unified work queue arrive with M3.

export const metadata: Metadata = { title: "Submitted applications" };
export const dynamic = "force-dynamic";

export default async function SubmittedQueuePage() {
  const result = await querySubmittedQueue(await currentRequestHeaders());
  if (result.kind === "UNAUTHENTICATED") {
    refuseAccess("UNAUTHENTICATED", "STAFF");
  }
  if (result.kind !== "OK") refuseAccess("NOT_FOUND", "STAFF");
  const { items } = result.view;
  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <div className="flex flex-col gap-2">
        <h1 className="text-3xl font-semibold tracking-tight">
          Submitted applications
        </h1>
        <p className="text-muted-foreground">
          Applications waiting for review, oldest first. All are unassigned.
        </p>
      </div>
      {items.length === 0 ? (
        <p role="status" className="rounded-lg border p-4">
          No applications are waiting for review.
        </p>
      ) : (
        <table className="w-full border-collapse text-left">
          <caption className="sr-only">
            Submitted applications waiting for review
          </caption>
          <thead>
            <tr className="border-b">
              <th scope="col" className="py-2 pr-4">
                Reference
              </th>
              <th scope="col" className="py-2 pr-4">
                Position
              </th>
              <th scope="col" className="py-2">
                Submitted (UTC)
              </th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.id} className="border-b">
                <td className="py-2 pr-4 font-mono">
                  <Link
                    prefetch={false}
                    href={`/staff/candidates/${item.id}`}
                    className="underline underline-offset-4"
                  >
                    {item.reference}
                  </Link>
                </td>
                <td className="py-2 pr-4 [overflow-wrap:anywhere]">
                  {item.opening}
                </td>
                <td className="py-2">
                  <time dateTime={item.submitted}>
                    {item.submitted.slice(0, 16).replace("T", " ")}
                  </time>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

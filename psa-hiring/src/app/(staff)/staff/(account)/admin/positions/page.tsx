import type { Metadata } from "next";
import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";
import { currentRequestHeaders } from "@/app/_auth/auth-messages";
import { queryPositionList } from "@/modules/organization";
import { refuseConfigurationAccess } from "@/modules/identity-access/delivery/route-authorization";
import { statusLabels } from "@/modules/organization/ui/labels";

// Position administration landing (packet M2.1 §16). Positions inside the
// principal's current scope only (SQL-filtered, each row rechecked), from
// the exact staff.position_list.v1 projection. No dashboard, queue,
// candidate, or count data. Unknown filters fall back to a safe state.

export const metadata: Metadata = { title: "Positions and hiring cycles" };
export const dynamic = "force-dynamic";

const statuses = ["DRAFT", "ACTIVE", "INACTIVE", "RETIRED"] as const;

export default async function PositionsAdminPage({
  searchParams,
}: PageProps<"/staff/admin/positions">) {
  const { status, after } = await searchParams;
  const filter =
    typeof status === "string" &&
    (statuses as readonly string[]).includes(status)
      ? status
      : undefined;
  const cursor =
    typeof after === "string" && /^[A-Z0-9_-]{2,32}$/.test(after)
      ? after
      : undefined;
  const result = await queryPositionList(await currentRequestHeaders(), {
    status: filter,
    after: cursor,
  });
  if (result.kind === "UNAUTHENTICATED") {
    refuseConfigurationAccess("UNAUTHENTICATED");
  }
  if (result.kind !== "OK") refuseConfigurationAccess("NOT_FOUND");
  const view = result.view;

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-2">
        <h1 className="text-3xl font-semibold tracking-tight">
          Positions and hiring cycles
        </h1>
        <p className="text-muted-foreground">
          Reusable positions in your authorized scope. Open a position to manage
          its job descriptions and hiring cycles.
        </p>
      </div>
      <nav
        aria-label="Position administration"
        className="flex flex-wrap gap-3"
      >
        {view.canCreate ? (
          <Link
            href="/staff/admin/positions/new"
            className={buttonVariants({ variant: "default" })}
          >
            New position
          </Link>
        ) : null}
        <Link
          href="/staff/admin/positions/hierarchy"
          className={buttonVariants({ variant: "outline" })}
        >
          Organizations, branches, and teams
        </Link>
      </nav>
      <form method="get" className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="status-filter" className="font-medium">
            Status
          </label>
          <select
            id="status-filter"
            name="status"
            defaultValue={filter ?? ""}
            className="h-10 rounded-lg border border-input bg-background px-3"
          >
            <option value="">All statuses</option>
            {statuses.map((s) => (
              <option key={s} value={s}>
                {statusLabels[s]}
              </option>
            ))}
          </select>
        </div>
        <button
          type="submit"
          className={buttonVariants({ variant: "outline" })}
        >
          Apply filter
        </button>
      </form>
      {view.items.length === 0 ? (
        <p role="status" className="rounded-lg border p-4">
          No positions match.{" "}
          {view.canCreate ? "Create a position to begin." : ""}
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left">
            <caption className="sr-only">Positions in your scope</caption>
            <thead>
              <tr className="border-b">
                <th scope="col" className="p-2">
                  Code
                </th>
                <th scope="col" className="p-2">
                  Internal title
                </th>
                <th scope="col" className="p-2">
                  Public title
                </th>
                <th scope="col" className="p-2">
                  Status
                </th>
              </tr>
            </thead>
            <tbody>
              {view.items.map((item) => (
                <tr key={item.id} className="border-b">
                  <td className="p-2 font-mono">{item.code}</td>
                  <td className="p-2">
                    <Link
                      href={`/staff/admin/positions/${item.id}`}
                      className="underline underline-offset-4"
                    >
                      {item.internalTitle}
                    </Link>
                  </td>
                  <td className="p-2">{item.publicTitle}</td>
                  <td className="p-2">{statusLabels[item.status]}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {view.nextCursor ? (
        <Link
          href={`/staff/admin/positions?${new URLSearchParams({
            ...(filter ? { status: filter } : {}),
            after: view.nextCursor,
          }).toString()}`}
          className="underline underline-offset-4"
        >
          Next page
        </Link>
      ) : null}
    </div>
  );
}

import type { Metadata } from "next";
import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";
import {
  queryPublicPositions,
  workerPathFilterLabels,
  workerPaths,
} from "@/modules/organization";

// Public list of currently accepting openings (packet M2.1 §17). Built
// only from the public projection of OPEN hiring cycles inside their
// window at the server's current time. No cookie, session, or account is
// read here. Filters are allowlisted and bounded; anything else shows one
// generic message and is never echoed back.

export const metadata: Metadata = { title: "Open positions" };
export const dynamic = "force-dynamic";

export default async function PositionsPage({
  searchParams,
}: PageProps<"/positions">) {
  const result = await queryPublicPositions(await searchParams);

  if (result.kind === "INVALID_FILTER") {
    return (
      <div className="flex flex-col gap-4">
        <h1 className="text-3xl font-semibold tracking-tight">
          Open positions
        </h1>
        <p role="status" className="rounded-lg border p-4">
          Those filters can’t be used.{" "}
          <Link href="/positions" className="underline underline-offset-4">
            Show all open positions
          </Link>
          .
        </p>
      </div>
    );
  }

  const { items, page, hasNext, locations, filters } = result.view;
  const pageHref = (n: number) =>
    `/positions?${new URLSearchParams({
      ...(filters.location ? { location: filters.location } : {}),
      ...(filters.type ? { type: filters.type } : {}),
      page: String(n),
    }).toString()}`;

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-2">
        <h1 className="text-3xl font-semibold tracking-tight">
          Open positions
        </h1>
        <p className="text-muted-foreground">
          Positions currently accepting applications. Closing times are shown in
          each location’s local time.
        </p>
      </div>
      <form method="get" className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="location-filter" className="font-medium">
            Location
          </label>
          <select
            id="location-filter"
            name="location"
            defaultValue={filters.location ?? ""}
            className="h-10 rounded-lg border border-input bg-background px-3"
          >
            <option value="">All locations</option>
            {locations.map((location) => (
              <option key={location} value={location}>
                {location}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="type-filter" className="font-medium">
            Work arrangement
          </label>
          <select
            id="type-filter"
            name="type"
            defaultValue={filters.type ?? ""}
            className="h-10 rounded-lg border border-input bg-background px-3"
          >
            <option value="">All arrangements</option>
            {workerPaths.map((path) => (
              <option key={path} value={path}>
                {workerPathFilterLabels[path]}
              </option>
            ))}
          </select>
        </div>
        <button
          type="submit"
          className={buttonVariants({ variant: "outline" })}
        >
          Apply filters
        </button>
      </form>

      {items.length === 0 ? (
        <p role="status" className="rounded-lg border p-4">
          No positions are open right now. Please check back later.
        </p>
      ) : (
        <ul className="flex flex-col gap-4" aria-label="Open positions">
          {items.map((item) => (
            <li key={item.reference} className="rounded-xl border p-4">
              <h2 className="text-xl font-semibold">
                <Link
                  href={`/positions/${item.reference}`}
                  className="underline underline-offset-4"
                >
                  {item.title}
                </Link>
              </h2>
              <p className="text-muted-foreground">{item.location}</p>
              <p className="mt-2">{item.summary}</p>
              <p className="mt-2 text-sm">{item.workerPaths}</p>
              {item.closes ? (
                <p className="mt-1 text-sm">{item.closes}</p>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      <nav aria-label="Pages" className="flex gap-4">
        {page > 1 ? (
          <Link
            href={pageHref(page - 1)}
            className="underline underline-offset-4"
          >
            Previous page
          </Link>
        ) : null}
        {hasNext ? (
          <Link
            href={pageHref(page + 1)}
            className="underline underline-offset-4"
          >
            Next page
          </Link>
        ) : null}
      </nav>
    </div>
  );
}

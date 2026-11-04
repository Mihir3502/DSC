import type { Metadata } from "next";
import Link from "next/link";
import { currentRequestHeaders } from "@/app/_auth/auth-messages";
import { buttonVariants } from "@/components/ui/button";
import {
  assignmentFilters,
  assignmentLabels,
  dueFilters,
  dueLabels,
  exceptionFilters,
  exceptionLabels,
  queryWorkQueue,
  stageFilters,
  stageLabels,
  workerPathFilters,
  workerPathLabels,
} from "@/modules/candidates";
import { refuseAccess } from "@/modules/identity-access/delivery/route-authorization";

// Unified work queue (packet M3.1; UI_FLOW §9.2). A plain GET form, so filters
// work without client code and the URL holds only closed codes and record ids,
// never a name. The server parses every value and applies scope in SQL.
// Blocker counts, holds, disputes, and classification aren't built yet, so
// they aren't offered. Controlled statuses are labels here, not inputs.

export const metadata: Metadata = { title: "Work queue" };
export const dynamic = "force-dynamic";

const selectClass =
  "h-11 w-full rounded-lg border border-input bg-background px-3 md:h-10";

function Filter({
  name,
  label,
  value,
  all,
  options,
}: {
  name: string;
  label: string;
  value: string;
  all: string;
  options: readonly Readonly<{ value: string; label: string }>[];
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <label htmlFor={`filter-${name}`} className="font-medium">
        {label}
      </label>
      <select
        id={`filter-${name}`}
        name={name}
        defaultValue={value}
        className={selectClass}
      >
        <option value="">{all}</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
}

const entries = <T extends string>(
  list: readonly T[],
  labels: Readonly<Record<T, string>>,
) => list.map((value) => ({ value, label: labels[value] }));

export default async function WorkQueuePage({
  searchParams,
}: PageProps<"/staff/work">) {
  const search = await searchParams;
  const result = await queryWorkQueue(await currentRequestHeaders(), search);
  if (result.kind === "UNAUTHENTICATED") {
    refuseAccess("UNAUTHENTICATED", "STAFF");
  }
  if (result.kind === "INVALID_FILTERS") {
    return (
      <div className="flex max-w-3xl flex-col gap-4">
        <h1 className="text-3xl font-semibold tracking-tight">Work queue</h1>
        <p role="alert" className="rounded-lg border border-destructive p-4">
          We couldn&apos;t use those filters.
        </p>
        <p>
          <Link
            prefetch={false}
            href="/staff/work"
            className="font-medium underline underline-offset-4"
          >
            Show the full work queue
          </Link>
        </p>
      </div>
    );
  }
  if (result.kind !== "OK") refuseAccess("NOT_FOUND", "STAFF");
  const view = result.view;
  const current = (name: string) => {
    const value = search[name];
    return typeof value === "string" ? value : "";
  };
  const params = new URLSearchParams();
  for (const name of [
    "assignment",
    "stage",
    "due",
    "branch",
    "position",
    "workerPath",
    "exception",
  ]) {
    if (current(name)) params.set(name, current(name));
  }
  const firstPage = params.size > 0 ? `?${params}` : "";
  if (view.nextCursor) params.set("after", view.nextCursor);
  const filtered = firstPage !== "" || current("after") !== "";

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <h1 className="text-3xl font-semibold tracking-tight">Work queue</h1>
        <p className="text-muted-foreground">
          Active candidates in your scope, soonest due first. Dates are in UTC.
        </p>
      </div>

      <form method="get" className="flex flex-col gap-4 rounded-lg border p-4">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Filter
            name="assignment"
            label="Assignment"
            value={current("assignment")}
            all="Everyone"
            options={entries(
              view.hasTeamScope
                ? assignmentFilters
                : assignmentFilters.filter((f) => f !== "TEAM"),
              assignmentLabels,
            )}
          />
          <Filter
            name="stage"
            label="Stage"
            value={current("stage")}
            all="All stages"
            options={entries(stageFilters, stageLabels)}
          />
          <Filter
            name="due"
            label="Due date"
            value={current("due")}
            all="Any due date"
            options={entries(dueFilters, dueLabels)}
          />
          <Filter
            name="branch"
            label="Branch"
            value={current("branch")}
            all="All branches"
            options={view.branches.map((b) => ({
              value: b.id,
              label: b.label,
            }))}
          />
          <Filter
            name="position"
            label="Position"
            value={current("position")}
            all="All positions"
            options={view.positions.map((p) => ({
              value: p.id,
              label: p.label,
            }))}
          />
          <Filter
            name="workerPath"
            label="Proposed worker path"
            value={current("workerPath")}
            all="All worker paths"
            options={entries(workerPathFilters, workerPathLabels)}
          />
          <Filter
            name="exception"
            label="Exception"
            value={current("exception")}
            all="Any"
            options={entries(exceptionFilters, exceptionLabels)}
          />
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <button type="submit" className={buttonVariants()}>
            Apply filters
          </button>
          {filtered ? (
            <Link
              prefetch={false}
              href="/staff/work"
              className={buttonVariants({ variant: "outline" })}
            >
              Clear filters
            </Link>
          ) : null}
        </div>
      </form>

      <p role="status">
        {view.total === 1 ? "1 candidate" : `${view.total} candidates`} match.
      </p>

      {view.items.length === 0 ? (
        <p className="rounded-lg border p-4">
          {filtered
            ? "Nothing matches these filters."
            : "Nothing is in your work queue."}
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {view.items.map((item) => (
            <li key={item.id} className="rounded-lg border p-4">
              <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                <h2 className="text-lg font-semibold [overflow-wrap:anywhere]">
                  <Link
                    prefetch={false}
                    href={`/staff/work/${item.id}`}
                    className="underline underline-offset-4"
                  >
                    {item.displayName}
                  </Link>
                </h2>
                <span className="font-mono text-sm">{item.reference}</span>
              </div>
              <dl className="mt-2 grid gap-x-6 gap-y-1 [overflow-wrap:anywhere] sm:grid-cols-2 lg:grid-cols-3">
                {(
                  [
                    ["Stage", item.stage],
                    ["Next action", item.nextAction],
                    ["Owner", item.owner],
                    ["Position", item.position],
                    ["Branch", item.branch],
                    ["Proposed worker path", item.workerPath],
                    [
                      "Due",
                      item.dueDate
                        ? `${item.dueDate}${item.overdue ? " (overdue)" : ""}`
                        : "No due date",
                    ],
                    [
                      "Age",
                      item.ageDays === 1 ? "1 day" : `${item.ageDays} days`,
                    ],
                    ...(item.returned
                      ? ([["Exception", "Returned for correction"]] as const)
                      : []),
                  ] as const
                ).map(([term, value]) => (
                  <div key={term} className="flex gap-2">
                    <dt className="font-medium">{term}:</dt>
                    <dd>{value}</dd>
                  </div>
                ))}
              </dl>
            </li>
          ))}
        </ul>
      )}

      {view.nextCursor || current("after") ? (
        <nav aria-label="Pages" className="flex flex-wrap gap-3">
          {current("after") ? (
            <Link
              prefetch={false}
              href={`/staff/work${firstPage}`}
              className={buttonVariants({ variant: "outline" })}
            >
              First page
            </Link>
          ) : null}
          {view.nextCursor ? (
            <Link
              prefetch={false}
              href={`/staff/work?${params}`}
              className={buttonVariants({ variant: "outline" })}
            >
              Next page
            </Link>
          ) : null}
        </nav>
      ) : null}
    </div>
  );
}

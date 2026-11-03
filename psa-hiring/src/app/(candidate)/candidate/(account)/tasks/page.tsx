import type { Metadata } from "next";
import Link from "next/link";
import { currentRequestHeaders } from "@/app/_auth/auth-messages";
import { buttonVariants } from "@/components/ui/button";
import { queryCandidateTasks, type TaskFilter } from "@/modules/candidates";
import { refuseAccess } from "@/modules/identity-access/delivery/route-authorization";

// Candidate tasks (packet M2.3 §15). Filters are allowlisted on the server.
// Upcoming and Submitted or under review have no source yet, so they show a
// truthful empty state. A finished task is history and offers no action.

export const metadata: Metadata = { title: "My tasks" };
export const dynamic = "force-dynamic";

const filters: readonly Readonly<{
  value: TaskFilter;
  label: string;
  empty: string;
}>[] = [
  {
    value: "action_needed",
    label: "Action needed",
    empty: "You have no tasks that need action.",
  },
  {
    value: "upcoming",
    label: "Upcoming",
    empty: "You have no upcoming tasks.",
  },
  {
    value: "under_review",
    label: "Submitted or under review",
    empty: "You have nothing submitted or under review.",
  },
  {
    value: "completed",
    label: "Completed",
    empty: "You have no completed tasks.",
  },
];

export default async function CandidateTasksPage({
  searchParams,
}: PageProps<"/candidate/tasks">) {
  const { filter } = await searchParams;
  const result = await queryCandidateTasks(
    await currentRequestHeaders(),
    filter,
  );
  if (result.kind === "INVALID_FILTER") {
    return (
      <div className="flex max-w-2xl flex-col gap-6">
        <h1 className="text-3xl font-semibold tracking-tight">My tasks</h1>
        <p role="status" className="rounded-lg border p-4">
          That filter can&apos;t be used.{" "}
          <Link
            prefetch={false}
            href="/candidate/tasks"
            className="underline underline-offset-4"
          >
            Show tasks that need action
          </Link>
          .
        </p>
      </div>
    );
  }
  if (result.kind !== "OK") {
    return refuseAccess(
      result.kind === "UNAUTHENTICATED" ? "UNAUTHENTICATED" : "NOT_FOUND",
      "CANDIDATE",
    );
  }
  const view = result.view;
  const counts: Readonly<Record<TaskFilter, number>> = {
    action_needed: view.counts.actionNeeded,
    upcoming: view.counts.upcoming,
    under_review: view.counts.underReview,
    completed: view.counts.completed,
  };
  const active = filters.find((f) => f.value === view.filter)!;
  return (
    <div className="flex max-w-2xl flex-col gap-6">
      <h1 className="text-3xl font-semibold tracking-tight">My tasks</h1>
      <nav aria-label="Filter tasks">
        <ul className="flex flex-col gap-1 sm:flex-row sm:flex-wrap sm:gap-4">
          {filters.map((f) => (
            <li key={f.value}>
              <Link
                prefetch={false}
                href={`/candidate/tasks?filter=${f.value}`}
                aria-current={f.value === view.filter ? "page" : undefined}
                className={`flex min-h-11 items-center rounded-md px-1 ${f.value === view.filter ? "font-semibold underline underline-offset-4" : "hover:underline"}`}
              >
                {f.label} ({counts[f.value]})
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      <h2 className="text-xl font-semibold">{active.label}</h2>
      {view.tasks.length === 0 ? (
        <p>{active.empty}</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {view.tasks.map((task) => (
            <li
              key={task.key}
              className="flex flex-col gap-1 rounded-lg border p-4 [overflow-wrap:anywhere]"
            >
              <h3 className="font-semibold">{task.title}</h3>
              <p className="text-sm">
                Status: <span className="font-medium">{task.status}</span>
              </p>
              <p className="text-sm">
                {task.opening} ·{" "}
                <span className="font-mono">{task.reference}</span>
              </p>
              {task.instruction ? <p>{task.instruction}</p> : null}
              {task.due ? <p>Due {task.due}</p> : null}
              {task.href && task.actionLabel ? (
                <p className="mt-2">
                  <Link
                    prefetch={false}
                    href={task.href}
                    className={buttonVariants()}
                  >
                    {task.actionLabel}
                    <span className="sr-only"> for {task.reference}</span>
                  </Link>
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

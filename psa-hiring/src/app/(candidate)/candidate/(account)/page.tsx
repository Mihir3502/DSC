import type { Metadata } from "next";
import Link from "next/link";
import { currentRequestHeaders } from "@/app/_auth/auth-messages";
import { buttonVariants } from "@/components/ui/button";
import { queryCandidateHome } from "@/modules/candidates";
import { refuseAccess } from "@/modules/identity-access/delivery/route-authorization";

// Candidate home (packet M2.3 §7, §13): truthful status, one next action, and
// task counts. It shows no percentage, deadline, or downstream panel that real
// data doesn't support. Choosing another application is re-checked against the
// candidate's own records on every request.

export const metadata: Metadata = { title: "Candidate home" };
export const dynamic = "force-dynamic";

export default async function CandidateHomePage({
  searchParams,
}: PageProps<"/candidate">) {
  const { application } = await searchParams;
  const result = await queryCandidateHome(
    await currentRequestHeaders(),
    application,
  );
  if (result.kind !== "OK") {
    return refuseAccess(
      result.kind === "UNAUTHENTICATED" ? "UNAUTHENTICATED" : "NOT_FOUND",
      "CANDIDATE",
    );
  }
  const { current, candidacies, nextAction, taskCounts } = result.view;

  if (!current) {
    return (
      <div className="flex max-w-2xl flex-col gap-6">
        <h1 className="text-3xl font-semibold tracking-tight">Welcome</h1>
        <p>You don&apos;t have an application yet.</p>
        <p>
          <Link
            prefetch={false}
            href="/positions"
            className={buttonVariants({ size: "lg" })}
          >
            See open positions
          </Link>
        </p>
        <p>
          <Link
            prefetch={false}
            href="/candidate/help"
            className="underline underline-offset-4"
          >
            Get help
          </Link>
        </p>
      </div>
    );
  }

  return (
    <div className="flex max-w-2xl flex-col gap-6">
      <h1 className="text-3xl font-semibold tracking-tight">
        Your application
      </h1>

      {candidacies.length > 1 ? (
        <nav aria-label="Your applications" className="flex flex-col gap-2">
          <h2 className="font-semibold">Choose an application</h2>
          <ul className="flex flex-col gap-2">
            {candidacies.map((c) => (
              <li key={c.candidacyId}>
                <Link
                  prefetch={false}
                  href={`/candidate?application=${c.candidacyId}`}
                  aria-current={c.selected ? "true" : undefined}
                  className={`block rounded-lg border p-3 [overflow-wrap:anywhere] ${c.selected ? "border-2 border-foreground" : "hover:underline"}`}
                >
                  <span className="font-medium">{c.title}</span>
                  {c.selected ? " (showing now)" : ""}
                  <span className="block text-sm">
                    {c.location} ·{" "}
                    <span className="font-mono">{c.reference}</span> ·{" "}
                    {c.status}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      ) : null}

      <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-1 [overflow-wrap:anywhere]">
        <dt className="font-medium">Position</dt>
        <dd>{current.title}</dd>
        <dt className="font-medium">Location</dt>
        <dd>{current.location}</dd>
        <dt className="font-medium">Reference</dt>
        <dd className="font-mono">{current.reference}</dd>
        <dt className="font-medium">Status</dt>
        <dd>{current.status.label}</dd>
      </dl>
      <p>{current.status.explanation}</p>

      <section
        aria-labelledby="next-action"
        className="flex flex-col gap-2 rounded-lg border p-4"
      >
        <h2 id="next-action" className="text-xl font-semibold">
          Next step
        </h2>
        {nextAction ? (
          <>
            <p className="font-medium">{nextAction.title}</p>
            <p>{nextAction.instruction}</p>
            {nextAction.due ? <p>Due {nextAction.due}</p> : null}
            <p>
              <Link
                prefetch={false}
                href={nextAction.href}
                className={buttonVariants({ size: "lg" })}
              >
                {nextAction.actionLabel}
              </Link>
            </p>
          </>
        ) : (
          <p>There&apos;s nothing you need to do right now.</p>
        )}
      </section>

      <section aria-labelledby="task-summary" className="flex flex-col gap-2">
        <h2 id="task-summary" className="text-xl font-semibold">
          Your tasks
        </h2>
        <p>
          {taskCounts.actionNeeded} need action · {taskCounts.completed}{" "}
          finished
        </p>
        <p>
          <Link
            prefetch={false}
            href="/candidate/tasks"
            className="underline underline-offset-4"
          >
            See all your tasks
          </Link>
        </p>
      </section>
    </div>
  );
}

import type { Metadata } from "next";
import Link from "next/link";
import { currentRequestHeaders } from "@/app/_auth/auth-messages";
import { queryStaffDashboard } from "@/modules/candidates";
import { refuseAccess } from "@/modules/identity-access/delivery/route-authorization";

// Staff dashboard (packet M3.1; UI_FLOW §9.1). Only measures backed by real
// data, all inside the caller's scope; each opens the same filter in the queue,
// which authorizes again. Cards for later milestones aren't shown.

export const metadata: Metadata = { title: "Dashboard" };
export const dynamic = "force-dynamic";

export default async function StaffDashboardPage() {
  const result = await queryStaffDashboard(await currentRequestHeaders());
  if (result.kind === "UNAUTHENTICATED") {
    refuseAccess("UNAUTHENTICATED", "STAFF");
  }
  if (result.kind === "NO_QUEUE") {
    return (
      <div className="flex max-w-3xl flex-col gap-4">
        <h1 className="text-3xl font-semibold tracking-tight">Staff account</h1>
        <p role="status" className="rounded-lg border p-4">
          Your role doesn&apos;t include a candidate work queue.
        </p>
        <p>
          <Link
            prefetch={false}
            href="/staff/security"
            className="font-medium underline underline-offset-4"
          >
            Security settings
          </Link>
        </p>
      </div>
    );
  }
  if (result.kind !== "OK") refuseAccess("NOT_FOUND", "STAFF");
  const view = result.view;
  const cards = [
    {
      label: "My work due today",
      value: view.myDueToday,
      href: "/staff/work?assignment=MINE&due=TODAY",
    },
    {
      label: "Overdue items",
      value: view.overdue,
      href: "/staff/work?due=OVERDUE",
    },
    {
      label: "Unassigned submitted applications",
      value: view.unassignedSubmitted,
      href: "/staff/work?assignment=UNASSIGNED&stage=APPLICATION_SUBMITTED",
    },
    {
      label: "Returned for correction",
      value: view.returned,
      href: "/staff/work?exception=RETURNED",
    },
  ];
  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <h1 className="text-3xl font-semibold tracking-tight">Dashboard</h1>
      <ul className="grid gap-4 sm:grid-cols-2">
        {cards.map((card) => (
          <li key={card.href} className="rounded-lg border p-4">
            <Link
              prefetch={false}
              href={card.href}
              className="flex flex-col gap-1 font-medium underline underline-offset-4"
            >
              <span className="text-3xl font-semibold">{card.value}</span>
              <span>{card.label}</span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

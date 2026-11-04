"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

// Workspace tabs (packet M3.2; UI_FLOW §10). Plain links in a labelled
// navigation, so each tab has its own URL and the back button works. The
// current one is shown by aria-current and an underline, not by color alone.
// Never a count or badge: a tab says nothing about what's behind it.

export function WorkspaceTabs({
  tabs,
}: {
  tabs: readonly Readonly<{ key: string; label: string; href: string }>[];
}) {
  const pathname = usePathname();
  return (
    <nav aria-label="Candidate workspace" className="border-b">
      <ul className="flex flex-wrap gap-x-2">
        {tabs.map((tab) => {
          const current = pathname === tab.href;
          return (
            <li key={tab.key}>
              <Link
                prefetch={false}
                href={tab.href}
                aria-current={current ? "page" : undefined}
                className={`inline-flex min-h-11 items-center px-3 font-medium md:min-h-8 ${
                  current
                    ? "border-b-2 border-foreground underline underline-offset-4"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {tab.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

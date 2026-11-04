"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";

// Portal navigation, for candidates and staff (packets M2.3 §12, §21; M3). On small screens the list is a
// disclosure: Escape closes it and returns focus to its button, and following
// a link closes it. The current page is conveyed by aria-current and a visible
// underline, not by color alone. Portal links never prefetch: these pages are
// private and uncached, so nothing is fetched until the candidate asks for it.

type Entry = Readonly<{ key: string; label: string; href: string }>;

function isCurrent(pathname: string, href: string, home: string) {
  return href === home
    ? pathname === href
    : pathname === href || pathname.startsWith(`${href}/`);
}

export function CandidateNavigation({
  entries,
  signOut,
  label = "Candidate portal",
  home = "/candidate",
}: {
  entries: readonly Entry[];
  signOut: React.ReactNode;
  label?: string;
  home?: string;
}) {
  const pathname = usePathname();
  const menuId = useId();
  const [open, setOpen] = useState(false);
  const toggle = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        toggle.current?.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <nav aria-label={label} className="border-b pb-3">
      <Button
        ref={toggle}
        type="button"
        variant="outline"
        className="min-h-11 md:hidden"
        aria-expanded={open}
        aria-controls={menuId}
        onClick={() => setOpen((value) => !value)}
      >
        {open ? "Close menu" : "Menu"}
      </Button>
      <div
        id={menuId}
        className={`${open ? "flex" : "hidden"} mt-2 flex-col gap-1 md:mt-0 md:flex md:flex-row md:flex-wrap md:items-center md:gap-4`}
      >
        <ul className="flex flex-col gap-1 md:flex-row md:flex-wrap md:gap-4">
          {entries.map((entry) => {
            const current = isCurrent(pathname, entry.href, home);
            return (
              <li key={entry.key}>
                <Link
                  prefetch={false}
                  href={entry.href}
                  aria-current={current ? "page" : undefined}
                  onClick={() => setOpen(false)}
                  className={`flex min-h-11 items-center rounded-md px-1 outline-none focus-visible:ring-3 focus-visible:ring-ring/50 md:min-h-6 ${current ? "font-semibold underline underline-offset-4" : "hover:underline"}`}
                >
                  {entry.label}
                </Link>
              </li>
            );
          })}
        </ul>
        <div className="md:ml-auto">{signOut}</div>
      </div>
    </nav>
  );
}

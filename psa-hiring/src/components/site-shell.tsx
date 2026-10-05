import type { ReactNode } from "react";
import Link from "next/link";

const productName = "PSA Workforce Hiring System";

export function SiteShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col">
      <a
        href="#main-content"
        className="sr-only rounded-md bg-primary px-3 py-2 text-primary-foreground focus:not-sr-only focus:absolute focus:top-3 focus:left-3"
      >
        Skip to main content
      </a>

      <header className="border-b">
        <div className="mx-auto w-full max-w-3xl px-4 py-4">
          <Link href="/" className="font-semibold">
            {productName}
          </Link>
        </div>
      </header>

      <main
        id="main-content"
        tabIndex={-1}
        className="mx-auto w-full max-w-3xl flex-1 px-4 py-10"
      >
        {children}
      </main>

      <footer className="border-t">
        <p className="mx-auto w-full max-w-3xl px-4 py-4 text-sm text-muted-foreground">
          Local foundation build. Do not enter real personal information.
        </p>
      </footer>
    </div>
  );
}

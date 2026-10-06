"use client";

import "./globals.css";
import { ErrorFallback } from "@/components/error-fallback";

// Fatal fallback when the root layout itself fails. It replaces the whole
// document, so the request-reference context is unavailable. The Next.js
// digest is shown as an "Error reference" because instrumentation.ts logs
// each digest together with the request's correlation ID.

const digestPattern = /^[A-Za-z0-9]{1,64}$/;

export default function GlobalError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  const digest =
    typeof error.digest === "string" && digestPattern.test(error.digest)
      ? error.digest
      : undefined;
  return (
    <html lang="en">
      <body>
        <title>Something went wrong · PSA Workforce Hiring System</title>
        <main className="mx-auto w-full max-w-3xl px-4 py-10">
          <ErrorFallback
            reference={
              digest ? { label: "Error reference", value: digest } : undefined
            }
            onRetry={retry}
          />
        </main>
      </body>
    </html>
  );
}

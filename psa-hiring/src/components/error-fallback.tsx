"use client";

import { useEffect, useRef } from "react";
import { buttonVariants } from "@/components/ui/button";

// Generic, accessible error fallback. Receives only a safe presentation model:
// an optional opaque reference and a retry action. It never renders an error
// message, stack, or any other technical detail.

export type ErrorReference = {
  label: "Request reference" | "Error reference";
  value: string;
};

export function ErrorFallback({
  reference,
  onRetry,
}: {
  reference?: ErrorReference;
  onRetry?: () => void;
}) {
  const heading = useRef<HTMLHeadingElement>(null);

  // Move focus to the heading so keyboard and screen-reader users land on the
  // new content once, without a repeating live announcement.
  useEffect(() => {
    heading.current?.focus();
  }, []);

  return (
    <section aria-labelledby="error-heading" className="flex flex-col gap-4">
      <h1
        id="error-heading"
        ref={heading}
        tabIndex={-1}
        className="text-3xl font-semibold tracking-tight"
      >
        Something went wrong
      </h1>
      <p role="alert">
        We could not complete this request. Please try again. If the problem
        continues, contact support and share the reference below.
      </p>
      <p>
        {reference ? (
          <>
            {reference.label}:{" "}
            <code className="font-mono">{reference.value}</code>
          </>
        ) : (
          "No reference is available for this error."
        )}
      </p>
      {onRetry ? (
        <p>
          <button type="button" onClick={onRetry} className={buttonVariants()}>
            Try again
          </button>
        </p>
      ) : null}
    </section>
  );
}

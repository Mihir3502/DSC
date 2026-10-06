"use client";

import { ErrorFallback } from "@/components/error-fallback";
import { useRequestReference } from "@/components/request-reference";

// Segment error boundary for every route under the root layout. Shows the
// page request's correlation ID; the error object is deliberately ignored.

export default function RouteError({
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  const correlationId = useRequestReference();
  return (
    <ErrorFallback
      reference={
        correlationId
          ? { label: "Request reference", value: correlationId }
          : undefined
      }
      onRetry={retry}
    />
  );
}

import type { Instrumentation } from "next";

// Next.js instrumentation hook for server rendering/route errors. Delegates
// to logRequestError, which never logs the error's message, stack, or cause.

export const onRequestError: Instrumentation.onRequestError = async (
  error,
  request,
  context,
) => {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { logRequestError } = await import("@/shared/logging/request-error");
  const { getLogger } = await import("@/shared/logging/pino-logger");
  logRequestError(getLogger(), {
    error,
    request,
    routePath: context.routePath,
  });
};

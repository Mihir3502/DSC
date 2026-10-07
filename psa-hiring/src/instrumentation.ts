import type { Instrumentation } from "next";

// Server startup (M1.6, ADR-0012): staging and production refuse to start
// without a valid audit integrity key ring and intact append-only
// protections for the runtime identity. Local and test environments use
// the synthetic key and are checked by `pnpm db:check` instead.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const appEnv = process.env.APP_ENV;
  if (appEnv !== "staging" && appEnv !== "production") return;
  const { assertAuditReadiness } = await import("@/modules/audit");
  await assertAuditReadiness();
}

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

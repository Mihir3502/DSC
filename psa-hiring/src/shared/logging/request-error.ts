import { CORRELATION_HEADER, isValidCorrelationId } from "./correlation";
import { toHttpMethod } from "./log-context";
import type { AppLogger } from "./logger";

// Logs a server rendering/route error reported by Next.js instrumentation.
// Records the correlation ID (from the proxy-forwarded header), route path,
// method, a fixed internal code, and the Next.js digest, so a digest shown in
// the global error UI maps to a correlation ID. The error's message, stack,
// and cause are never read or logged.

export type RequestErrorInfo = {
  error: unknown;
  request: {
    method: string;
    headers: Record<string, string | string[] | undefined>;
  };
  routePath: string;
};

export function logRequestError(
  logger: AppLogger,
  info: RequestErrorInfo,
): void {
  const header = info.request.headers[CORRELATION_HEADER];
  const digest =
    typeof info.error === "object" && info.error !== null
      ? (info.error as { digest?: unknown }).digest
      : undefined;
  logger.error("request.error", {
    correlationId:
      typeof header === "string" && isValidCorrelationId(header)
        ? header
        : undefined,
    routeTemplate: info.routePath,
    method: toHttpMethod(info.request.method),
    errorCode: "INTERNAL.UNEXPECTED",
    errorDigest: typeof digest === "string" ? digest : undefined,
  });
}

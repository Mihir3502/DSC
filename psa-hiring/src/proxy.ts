import { NextResponse, type NextRequest } from "next/server";
import {
  CORRELATION_HEADER,
  resolveCorrelationId,
} from "@/shared/logging/correlation";
import { toHttpMethod } from "@/shared/logging/log-context";
import { getLogger } from "@/shared/logging/pino-logger";
import type { AppLogger } from "@/shared/logging/logger";

// Trusted web boundary (Node.js runtime in Next.js 16). Assigns every request
// one validated correlation ID, forwards it to rendering/route handlers as a
// request header, returns it as a response header, and logs that the request
// was received. Status and duration are not observable here, so none are
// logged (route handlers log completion themselves).

/** Low-cardinality route labels; unknown paths are never logged raw. */
const knownRoutes = new Set(["/", "/candidate", "/staff"]);

export function routeLabel(pathname: string): string {
  if (knownRoutes.has(pathname)) return pathname;
  if (pathname.startsWith("/api/")) return "/api/(other)";
  return "/(other)";
}

export function createProxy(logger: () => AppLogger) {
  return function proxy(request: NextRequest) {
    const correlationId = resolveCorrelationId(
      request.headers.get(CORRELATION_HEADER),
    );
    const forwarded = new Headers(request.headers);
    forwarded.set(CORRELATION_HEADER, correlationId);

    const response = NextResponse.next({ request: { headers: forwarded } });
    response.headers.set(CORRELATION_HEADER, correlationId);

    logger().info("request.received", {
      correlationId,
      routeTemplate: routeLabel(request.nextUrl.pathname),
      method: toHttpMethod(request.method),
    });
    return response;
  };
}

export const proxy = createProxy(getLogger);

export const config = {
  // Skip framework assets and static files (anything with a file extension).
  matcher: ["/((?!_next/static|_next/image|.*\\.[A-Za-z0-9]+$).*)"],
};

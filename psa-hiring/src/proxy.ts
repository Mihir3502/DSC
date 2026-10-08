import { NextResponse, type NextRequest } from "next/server";
import {
  CORRELATION_HEADER,
  resolveCorrelationId,
} from "@/shared/logging/correlation";
import { toHttpMethod } from "@/shared/logging/log-context";
import { getLogger } from "@/shared/logging/pino-logger";
import type { AppLogger } from "@/shared/logging/logger";
import {
  applyProtectedHeaders,
  isProtectedPath,
} from "@/shared/security/protected-cache-policy";

// Trusted web boundary (Node.js runtime in Next.js 16). Assigns every request
// one validated correlation ID, forwards it to rendering/route handlers as a
// request header, returns it as a response header, and logs that the request
// was received. Status and duration are not observable here, so none are
// logged (route handlers log completion themselves).
//
// M1.5 (ADR-0011): this proxy is coarse plumbing only. It resolves no
// session, reads no account or record, and makes no authorization
// decision; the route-group guards are navigation conveniences and every
// page, query, action, and handler authorizes itself on the server.

/** Low-cardinality route labels; unknown paths are never logged raw. */
const knownRoutes = new Set([
  "/",
  "/candidate",
  "/staff",
  "/register",
  "/sign-in",
  "/verify-email",
  "/recover",
  "/reset-password",
  "/candidate/security",
  "/staff/activate",
  "/staff/sign-in",
  "/staff/mfa",
  "/staff/recover",
  "/staff/security",
  "/staff/reauthenticate",
  // M2.1 (dynamic segments are labelled by template, never raw).
  "/positions",
  "/staff/admin/positions",
  "/staff/admin/positions/new",
  "/staff/admin/positions/hierarchy",
  "/candidate/applications/new",
]);

/** Dynamic M2.1 routes: label by template so no reference is logged. */
const templateRoutes: readonly (readonly [RegExp, string])[] = [
  [/^\/positions\/[^/]+$/, "/positions/[positionId]"],
  [/^\/apply\/[^/]+$/, "/apply/[positionId]"],
  [
    /^\/staff\/admin\/positions\/[^/]+\/descriptions\/[^/]+$/,
    "/staff/admin/positions/[positionId]/descriptions/[versionId]",
  ],
  [
    /^\/staff\/admin\/positions\/[^/]+\/cycles\/new$/,
    "/staff/admin/positions/[positionId]/cycles/new",
  ],
  [
    /^\/staff\/admin\/positions\/[^/]+\/cycles\/[^/]+$/,
    "/staff/admin/positions/[positionId]/cycles/[cycleId]",
  ],
  [/^\/staff\/admin\/positions\/[^/]+$/, "/staff/admin/positions/[positionId]"],
];

/**
 * Public position pages (ADR-0013): only the public projection is cached
 * on the server; browsers and shared caches must revalidate every time.
 */
export const PUBLIC_POSITIONS_CACHE_CONTROL =
  "public, max-age=0, must-revalidate";

export function isPublicPositionsPath(pathname: string): boolean {
  return pathname === "/positions" || /^\/positions\/[^/]+$/.test(pathname);
}

/**
 * Personal or capability-bearing pages are never cached (packet M1.2
 * §9.2, AC-M1.2-11; M1.5 §18: `private, no-store` plus `Vary: Cookie`).
 * Every response gets Referrer-Policy: no-referrer.
 */
export function isNoStorePath(pathname: string): boolean {
  return isProtectedPath(pathname);
}

export function routeLabel(pathname: string): string {
  if (knownRoutes.has(pathname)) return pathname;
  for (const [pattern, template] of templateRoutes) {
    if (pattern.test(pathname)) return template;
  }
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
    response.headers.set("Referrer-Policy", "no-referrer");
    if (isNoStorePath(request.nextUrl.pathname)) {
      applyProtectedHeaders(response.headers);
    } else if (isPublicPositionsPath(request.nextUrl.pathname)) {
      response.headers.set("Cache-Control", PUBLIC_POSITIONS_CACHE_CONTROL);
    }

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

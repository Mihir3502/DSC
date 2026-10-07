import "server-only";
import { toNextJsHandler } from "better-auth/next-js";
import { publicErrorRegistry, type PublicErrorCode } from "@/shared/errors";
import { problemResponse } from "@/shared/http/route-handler";
import {
  applyProtectedHeaders,
  PROTECTED_CACHE_CONTROL,
} from "@/shared/security/protected-cache-policy";
import { getAuth } from "./runtime";

// HTTP delivery for Better Auth (packet M1.1 §9.1, AC-M1.1-11). Library
// error bodies are replaced with closed public problem codes, and session
// tokens are stripped from JSON bodies so they never reach browser
// JavaScript (the HTTP-only cookie is the only credential).

export function publicCodeForStatus(status: number): PublicErrorCode {
  if (status === 401 || status === 403) return "UNAUTHENTICATED";
  if (status === 404) return "NOT_FOUND";
  if (status === 409) return "CONFLICT";
  if (status === 429) return "RATE_LIMITED";
  if (status >= 500) return "INTERNAL_ERROR";
  return "VALIDATION_FAILED";
}

function stripTokens(body: unknown): unknown {
  if (!body || typeof body !== "object" || Array.isArray(body)) return body;
  const copy = { ...(body as Record<string, unknown>) };
  delete copy.token;
  if (copy.session && typeof copy.session === "object") {
    const session = { ...(copy.session as Record<string, unknown>) };
    delete session.token;
    copy.session = session;
  }
  return copy;
}

export async function toSafeAuthResponse(
  response: Response,
  correlationId: string,
): Promise<Response> {
  const setCookies = response.headers.getSetCookie();

  if (response.status >= 400) {
    const code = publicCodeForStatus(response.status);
    const { status, title } = publicErrorRegistry[code];
    const safe = problemResponse(
      Object.freeze({
        type: "about:blank",
        title,
        status,
        code,
        correlationId,
      }),
    );
    for (const cookie of setCookies) safe.headers.append("set-cookie", cookie);
    applyProtectedHeaders(safe.headers);
    return safe;
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) return response;

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.set("cache-control", PROTECTED_CACHE_CONTROL);
  return new Response(JSON.stringify(stripTokens(body)), {
    status: response.status,
    headers,
  });
}

/**
 * The Better Auth HTTP paths the application forwards (packet M1.2 §6.1,
 * §11; M1.5 §11, §12.2). Registration, verification, sign-in, sign-out,
 * recovery, reset, password change, and session management run as
 * same-origin server actions through auth.api, so no generic, staff, or OTP
 * endpoint is reachable over HTTP.
 *
 * M1.5 closed the last forwarded path, GET /get-session: it serialized
 * Better Auth's own user/session objects (an auth-library object, not an
 * application projection), bypassed the application account-status, MFA,
 * and stale-version checks, and could roll the session expiry on a GET.
 * No application code used it. Every /api/auth/* request is now a closed,
 * side-effect-free 404; session state reaches pages only through the
 * application's own exact projections.
 */
export const forwardedAuthPaths: Readonly<Record<string, readonly string[]>> =
  Object.freeze({ GET: Object.freeze([]), POST: Object.freeze([]) });

export function isForwardedAuthPath(method: string, pathname: string): boolean {
  const prefix = "/api/auth";
  if (!pathname.startsWith(`${prefix}/`)) return false;
  const path = pathname.slice(prefix.length).replace(/\/+$/, "");
  return (forwardedAuthPaths[method] ?? []).includes(path);
}

/** Handles an allowlisted /api/auth/* request through Better Auth. */
export async function handleAuthRequest(
  request: Request,
  correlationId: string,
): Promise<Response> {
  if (!isForwardedAuthPath(request.method, new URL(request.url).pathname)) {
    return toSafeAuthResponse(
      new Response(null, { status: 404 }),
      correlationId,
    );
  }
  const { GET, POST } = toNextJsHandler(getAuth());
  const response = await (request.method === "GET"
    ? GET(request)
    : POST(request));
  return toSafeAuthResponse(response, correlationId);
}

// Protected-response cache policy (packet M1.5 §18, ADR-0011). Pure and
// framework-neutral; used by src/proxy.ts for pages and by the protected
// JSON/download helpers for Route Handlers.
//
// Authenticated, personalized, security, and capability-bearing responses
// are never stored by browsers, proxies, or CDNs. `Vary: Cookie` is added
// as defense in depth only; it is never the privacy control by itself.
// (Next.js 16 owns `Vary` on App Router page responses and replaces it;
// Route Handler responses keep it.)

export const PROTECTED_CACHE_CONTROL = "private, no-store, max-age=0";

export const protectedResponseHeaders: Readonly<Record<string, string>> =
  Object.freeze({
    "Cache-Control": PROTECTED_CACHE_CONTROL,
    Pragma: "no-cache",
    Expires: "0",
    Vary: "Cookie",
  });

/**
 * Path prefixes whose responses are personal or carry one-time
 * capabilities. Each prefix covers the exact path and everything below it.
 * The route manifest test proves every non-public entry is covered.
 */
export const protectedPathPrefixes: readonly string[] = Object.freeze([
  "/register",
  "/sign-in",
  "/verify-email",
  "/recover",
  "/reset-password",
  "/candidate",
  "/staff",
  "/api",
  // M2.1 start-application handoff (sets a short-lived handoff cookie).
  "/apply",
]);

export function isProtectedPath(pathname: string): boolean {
  return protectedPathPrefixes.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

/** Applies the protected headers (overwriting any cacheable values). */
export function applyProtectedHeaders(headers: Headers): void {
  for (const [name, value] of Object.entries(protectedResponseHeaders)) {
    headers.set(name, value);
  }
}

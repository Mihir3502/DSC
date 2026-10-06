import {
  internalErrorCodes,
  type InternalErrorCode,
  type PublicErrorCode,
} from "../errors";
import { isValidCorrelationId } from "./correlation";

// The complete allowlist of operational log fields. Anything not listed here
// is dropped before serialization, whatever the caller passes.

export const httpMethods = [
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
] as const;
export type HttpMethod = (typeof httpMethods)[number];

/** Low-cardinality dotted/kebab token, e.g. "request.completed" or "db.migrate". */
type Token = string;
/** Static route template such as "/candidate" or "/api/[id]", never a raw URL. */
type RouteTemplate = string;
/** Opaque, non-secret internal reference (never an email, name, or SSN). */
type OpaqueRef = string;

export type LogContext = {
  module?: Token;
  action?: Token;
  eventCode?: Token;
  resultCode?: Token;
  errorCode?: InternalErrorCode | PublicErrorCode;
  /** Next.js error digest; explicitly mapped to correlationId in logs. */
  errorDigest?: string;
  correlationId?: string;
  routeTemplate?: RouteTemplate;
  method?: HttpMethod;
  statusCode?: number;
  durationMs?: number;
  actorRef?: OpaqueRef;
  recordRef?: OpaqueRef;
};

export const logContextKeys = [
  "module",
  "action",
  "eventCode",
  "resultCode",
  "errorCode",
  "errorDigest",
  "correlationId",
  "routeTemplate",
  "method",
  "statusCode",
  "durationMs",
  "actorRef",
  "recordRef",
] as const satisfies readonly (keyof LogContext)[];

const tokenPattern = /^[a-z][a-z0-9_.-]{0,63}$/;
const routePattern = /^\/[A-Za-z0-9_\-/[\].()]{0,119}$/;
const refPattern = /^[A-Za-z0-9_-]{1,64}$/;
const digestPattern = /^[A-Za-z0-9]{1,64}$/;
const publicCodes = new Set<string>([
  "VALIDATION_FAILED",
  "UNAUTHENTICATED",
  "NOT_FOUND",
  "CONFLICT",
  "SERVICE_UNAVAILABLE",
  "RATE_LIMITED",
  "INTERNAL_ERROR",
]);
const errorCodes = new Set<string>([...internalErrorCodes, ...publicCodes]);

type Validator = (value: unknown) => string | number | undefined;

const matching =
  (pattern: RegExp): Validator =>
  (value) =>
    typeof value === "string" && pattern.test(value) ? value : undefined;

const boundedInt =
  (min: number, max: number): Validator =>
  (value) =>
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= min &&
    value <= max
      ? Math.round(value)
      : undefined;

const validators: Record<(typeof logContextKeys)[number], Validator> = {
  module: matching(tokenPattern),
  action: matching(tokenPattern),
  eventCode: matching(tokenPattern),
  resultCode: matching(tokenPattern),
  errorCode: (v) =>
    typeof v === "string" && errorCodes.has(v) ? v : undefined,
  errorDigest: matching(digestPattern),
  correlationId: (v) => (isValidCorrelationId(v) ? v.toLowerCase() : undefined),
  routeTemplate: matching(routePattern),
  method: (v) =>
    typeof v === "string" && (httpMethods as readonly string[]).includes(v)
      ? v
      : undefined,
  statusCode: boundedInt(100, 599),
  durationMs: boundedInt(0, 3_600_000),
  actorRef: matching(refPattern),
  recordRef: matching(refPattern),
};

/**
 * Low-level defensive boundary: returns only allowlisted fields whose values
 * pass their bounded validators. Unknown keys, nested objects, Errors,
 * requests, headers, bodies, query strings, and cookies are dropped. Values
 * are never transformed into partial forms (no prefixes, lengths, or hashes).
 */
export function toSafeLogFields(
  input: unknown,
): Record<string, string | number> {
  const safe: Record<string, string | number> = {};
  if (typeof input !== "object" || input === null) return safe;
  for (const key of logContextKeys) {
    if (!Object.hasOwn(input, key)) continue;
    const value = validators[key]((input as Record<string, unknown>)[key]);
    if (value !== undefined) safe[key] = value;
  }
  return safe;
}

/** Normalizes a request method to the allowlist, or undefined. */
export function toHttpMethod(method: string): HttpMethod | undefined {
  const upper = method.toUpperCase();
  return (httpMethods as readonly string[]).includes(upper)
    ? (upper as HttpMethod)
    : undefined;
}

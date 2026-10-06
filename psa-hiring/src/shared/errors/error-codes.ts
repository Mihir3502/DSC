// Closed registries for internal and public error codes. Framework-neutral:
// no Next.js, React, logger, ORM, or provider imports.

/** Stable internal classification codes, safe to log. */
export const internalErrorCodes = [
  "VALIDATION.INVALID_INPUT",
  "RESOURCE.NOT_FOUND",
  "ACCESS.DENIED",
  "AUTH.REQUIRED",
  "STATE.CONFLICT",
  "DOMAIN.RULE_VIOLATED",
  "DEPENDENCY.UNAVAILABLE",
  "INTERNAL.UNEXPECTED",
] as const;

export type InternalErrorCode = (typeof internalErrorCodes)[number];

export type PublicErrorCode =
  | "VALIDATION_FAILED"
  | "UNAUTHENTICATED"
  | "NOT_FOUND"
  | "CONFLICT"
  | "SERVICE_UNAVAILABLE"
  | "INTERNAL_ERROR";

export type PublicErrorDefinition = Readonly<{
  status: number;
  title: string;
}>;

/** Reviewed status and user-visible title for every public code. */
export const publicErrorRegistry: Readonly<
  Record<PublicErrorCode, PublicErrorDefinition>
> = Object.freeze({
  VALIDATION_FAILED: {
    status: 400,
    title: "The request could not be processed",
  },
  UNAUTHENTICATED: { status: 401, title: "Sign-in is required" },
  NOT_FOUND: { status: 404, title: "The requested resource was not found" },
  CONFLICT: {
    status: 409,
    title: "The request conflicts with the current state",
  },
  SERVICE_UNAVAILABLE: {
    status: 503,
    title: "The service is temporarily unavailable",
  },
  INTERNAL_ERROR: { status: 500, title: "Unable to complete the request" },
});

/**
 * Internal → public mapping. Access denial deliberately maps to NOT_FOUND so
 * responses never reveal whether a protected record exists.
 */
export const publicCodeFor: Readonly<
  Record<InternalErrorCode, PublicErrorCode>
> = Object.freeze({
  "VALIDATION.INVALID_INPUT": "VALIDATION_FAILED",
  "RESOURCE.NOT_FOUND": "NOT_FOUND",
  "ACCESS.DENIED": "NOT_FOUND",
  "AUTH.REQUIRED": "UNAUTHENTICATED",
  "STATE.CONFLICT": "CONFLICT",
  "DOMAIN.RULE_VIOLATED": "CONFLICT",
  "DEPENDENCY.UNAVAILABLE": "SERVICE_UNAVAILABLE",
  "INTERNAL.UNEXPECTED": "INTERNAL_ERROR",
});

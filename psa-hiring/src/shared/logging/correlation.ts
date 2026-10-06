// Correlation ID contract. Pure and runtime-neutral (no Node-only imports),
// so it can be shared by the proxy, route handlers, and UI code.

/** The single request/response header carrying the correlation ID. */
export const CORRELATION_HEADER = "x-correlation-id";

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Accepts only a 36-character RFC 4122/9562 UUID; anything else is rejected. */
export function isValidCorrelationId(value: unknown): value is string {
  return (
    typeof value === "string" && value.length === 36 && uuidPattern.test(value)
  );
}

/** Generates a new cryptographically strong correlation ID. */
export function generateCorrelationId(): string {
  return globalThis.crypto.randomUUID();
}

/**
 * Trust rule: an incoming ID is kept only if it is a well-formed UUID
 * (normalized to lowercase). Missing, oversized, malformed, or
 * injection-shaped values are discarded and replaced.
 */
export function resolveCorrelationId(
  incoming: string | null | undefined,
): string {
  return isValidCorrelationId(incoming)
    ? incoming.toLowerCase()
    : generateCorrelationId();
}

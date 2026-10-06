import {
  publicCodeFor,
  publicErrorRegistry,
  type PublicErrorCode,
} from "./error-codes";
import { normalizeError } from "./normalize-error";

/** RFC 9457-style problem details. Every field comes from the registry. */
export type PublicProblem = Readonly<{
  type: "about:blank";
  title: string;
  status: number;
  code: PublicErrorCode;
  correlationId: string;
}>;

/**
 * Maps any thrown value to a safe public model. Reads only the trusted
 * internal code; never message, stack, name, cause, or other properties.
 */
export function toPublicError(
  error: unknown,
  correlationId: string,
): PublicProblem {
  const code = publicCodeFor[normalizeError(error).code];
  const { status, title } = publicErrorRegistry[code];
  return Object.freeze({
    type: "about:blank",
    title,
    status,
    code,
    correlationId,
  });
}

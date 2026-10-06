import { ApplicationError, UnexpectedError } from "./application-error";

/**
 * Converts any thrown value into a trusted ApplicationError. Only real
 * ApplicationError instances keep their classification; everything else
 * (Error, string, plain object, database- or provider-shaped errors) becomes
 * INTERNAL.UNEXPECTED. No property of an unknown value is ever inspected to
 * decide its classification.
 */
export function normalizeError(error: unknown): ApplicationError {
  if (error instanceof ApplicationError) return error;
  return new UnexpectedError({ cause: error });
}

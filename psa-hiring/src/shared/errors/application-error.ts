import type { InternalErrorCode } from "./error-codes";

// Trusted internal errors. Each carries only a stable code and, optionally,
// an internal `cause`. The message is the code itself so no caller-provided
// text (which might contain personal data) is ever stored on the error.

type ErrorOptions = { cause?: unknown };

export abstract class ApplicationError extends Error {
  readonly code: InternalErrorCode;

  protected constructor(code: InternalErrorCode, options: ErrorOptions = {}) {
    super(
      code,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = new.target.name;
    this.code = code;
  }
}

/** Input failed validation at an application boundary. */
export class ValidationError extends ApplicationError {
  constructor(options?: ErrorOptions) {
    super("VALIDATION.INVALID_INPUT", options);
  }
}

/** A requested resource does not exist (or must be treated as absent). */
export class NotFoundError extends ApplicationError {
  constructor(options?: ErrorOptions) {
    super("RESOURCE.NOT_FOUND", options);
  }
}

/**
 * The caller may not access a resource. Mapping contract only (authorization
 * arrives in M1); public responses treat it as NOT_FOUND.
 */
export class AccessDeniedError extends ApplicationError {
  constructor(options?: ErrorOptions) {
    super("ACCESS.DENIED", options);
  }
}

/** Authentication is required. Mapping contract only; auth arrives in M1. */
export class AuthenticationRequiredError extends ApplicationError {
  constructor(options?: ErrorOptions) {
    super("AUTH.REQUIRED", options);
  }
}

/** The command conflicts with the record's current state or version. */
export class ConflictError extends ApplicationError {
  constructor(options?: ErrorOptions) {
    super("STATE.CONFLICT", options);
  }
}

/** A business invariant was violated (created by domain code; not logged there). */
export class DomainRuleError extends ApplicationError {
  constructor(options?: ErrorOptions) {
    super("DOMAIN.RULE_VIOLATED", options);
  }
}

/** A database, provider, or other dependency failed. The raw cause stays internal. */
export class DependencyError extends ApplicationError {
  constructor(options?: ErrorOptions) {
    super("DEPENDENCY.UNAVAILABLE", options);
  }
}

/** Normalized form of any value that is not a trusted ApplicationError. */
export class UnexpectedError extends ApplicationError {
  constructor(options?: ErrorOptions) {
    super("INTERNAL.UNEXPECTED", options);
  }
}

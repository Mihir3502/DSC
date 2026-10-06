import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildCanaryError,
  canaries,
  findCanaryCategories,
} from "../../../tests/fixtures/canaries";
import {
  AccessDeniedError,
  ApplicationError,
  AuthenticationRequiredError,
  ConflictError,
  DependencyError,
  DomainRuleError,
  NotFoundError,
  normalizeError,
  toPublicError,
  UnexpectedError,
  ValidationError,
} from "./index";

const correlationId = "0b9a7a3e-6a55-4c8e-9a3b-2f1d0c4e5a6b";

describe("trusted error taxonomy", () => {
  it.each([
    [
      new ValidationError(),
      "VALIDATION.INVALID_INPUT",
      "VALIDATION_FAILED",
      400,
      "The request could not be processed",
    ],
    [
      new AuthenticationRequiredError(),
      "AUTH.REQUIRED",
      "UNAUTHENTICATED",
      401,
      "Sign-in is required",
    ],
    [
      new NotFoundError(),
      "RESOURCE.NOT_FOUND",
      "NOT_FOUND",
      404,
      "The requested resource was not found",
    ],
    [
      new AccessDeniedError(),
      "ACCESS.DENIED",
      "NOT_FOUND",
      404,
      "The requested resource was not found",
    ],
    [
      new ConflictError(),
      "STATE.CONFLICT",
      "CONFLICT",
      409,
      "The request conflicts with the current state",
    ],
    [
      new DomainRuleError(),
      "DOMAIN.RULE_VIOLATED",
      "CONFLICT",
      409,
      "The request conflicts with the current state",
    ],
    [
      new DependencyError(),
      "DEPENDENCY.UNAVAILABLE",
      "SERVICE_UNAVAILABLE",
      503,
      "The service is temporarily unavailable",
    ],
    [
      new UnexpectedError(),
      "INTERNAL.UNEXPECTED",
      "INTERNAL_ERROR",
      500,
      "Unable to complete the request",
    ],
  ])("%o maps %s → %s %i", (error, internal, publicCode, status, title) => {
    expect(error).toBeInstanceOf(ApplicationError);
    expect(error.code).toBe(internal);
    expect(error.message).toBe(internal);
    expect(toPublicError(error, correlationId)).toEqual({
      type: "about:blank",
      title,
      status,
      code: publicCode,
      correlationId,
    });
  });

  it("keeps the cause internally without exposing it publicly", () => {
    const cause = buildCanaryError();
    const error = new DependencyError({ cause });
    expect(error.cause).toBe(cause);
    const output = JSON.stringify(toPublicError(error, correlationId));
    expect(findCanaryCategories(output)).toEqual([]);
  });

  it("returns a frozen public model with exactly the RFC 9457-style fields", () => {
    const problem = toPublicError(new ValidationError(), correlationId);
    expect(Object.isFrozen(problem)).toBe(true);
    expect(Object.keys(problem).sort()).toEqual([
      "code",
      "correlationId",
      "status",
      "title",
      "type",
    ]);
  });

  it("does not reveal whether a protected record exists (denied looks like missing)", () => {
    const denied = toPublicError(new AccessDeniedError(), correlationId);
    const missing = toPublicError(new NotFoundError(), correlationId);
    expect(denied).toEqual(missing);
  });
});

describe("unknown error normalization", () => {
  const databaseLike = Object.assign(new Error(canaries.sql), {
    code: "23505",
    detail: canaries.ssn,
    query: canaries.sql,
    parameters: [canaries.sqlBinding],
  });
  const providerLike = Object.assign(new Error(canaries.provider), {
    response: {
      status: 502,
      data: { raw: canaries.provider, url: canaries.signedUrl },
    },
  });
  const rejected = Promise.reject(buildCanaryError());
  rejected.catch(() => undefined);

  it.each([
    ["Error with canary message, stack, and cause", buildCanaryError()],
    ["string", canaries.errorMessage],
    [
      "plain object",
      {
        message: canaries.errorMessage,
        code: "ACCESS.DENIED",
        password: canaries.password,
      },
    ],
    ["null", null],
    ["database-like error", databaseLike],
    ["provider-like error", providerLike],
    [
      "error impersonating a trusted code",
      Object.assign(new Error("x"), { code: "RESOURCE.NOT_FOUND" }),
    ],
  ])("maps %s to the generic internal response", (_label, thrown) => {
    expect(normalizeError(thrown)).toBeInstanceOf(UnexpectedError);
    const problem = toPublicError(thrown, correlationId);
    expect(problem.code).toBe("INTERNAL_ERROR");
    expect(problem.status).toBe(500);
    const output = JSON.stringify(problem);
    expect(findCanaryCategories(output)).toEqual([]);
    for (const leak of [
      "stack",
      "cause",
      "23505",
      "/srv/",
      "SELECT",
      "Error",
    ]) {
      expect(output.includes(leak), `public model contains "${leak}"`).toBe(
        false,
      );
    }
  });

  it("maps a caught promise rejection to the generic internal response", async () => {
    const thrown = await rejected.catch((error: unknown) => error);
    expect(toPublicError(thrown, correlationId).code).toBe("INTERNAL_ERROR");
  });
});

describe("framework neutrality", () => {
  it("shared error primitives import no framework, logger, ORM, or provider code", () => {
    const dir = import.meta.dirname;
    const sources = readdirSync(dir).filter(
      (f) => f.endsWith(".ts") && !f.endsWith(".test.ts"),
    );
    expect(sources.length).toBeGreaterThan(0);
    for (const file of sources) {
      const text = readFileSync(path.join(dir, file), "utf8");
      const imports = [...text.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
      expect(
        imports.filter((i) => !i.startsWith("./")),
        file,
      ).toEqual([]);
    }
  });
});

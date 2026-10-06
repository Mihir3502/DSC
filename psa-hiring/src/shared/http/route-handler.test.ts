import { describe, expect, it } from "vitest";
import {
  buildCanaryError,
  canaries,
  createMemoryDestination,
  findCanaryCategories,
} from "../../../tests/fixtures/canaries";
import {
  AccessDeniedError,
  DependencyError,
  NotFoundError,
  ValidationError,
} from "../errors";
import { createLogger, isValidCorrelationId } from "../logging";
import { getRequestContext } from "../logging/request-context";
import { PROBLEM_CONTENT_TYPE, withRouteHandler } from "./route-handler";

const validId = "0b9a7a3e-6a55-4c8e-9a3b-2f1d0c4e5a6b";

function setup(handler: Parameters<typeof withRouteHandler>[1]) {
  const destination = createMemoryDestination();
  const logger = createLogger({ destination });
  const route = withRouteHandler(
    { routeTemplate: "/api/example", logger },
    handler,
  );
  return { destination, route };
}

/** A request carrying canaries in its URL query, headers, cookies, and body. */
function canaryRequest(headers: Record<string, string> = {}) {
  return new Request(
    `https://app.example.test/api/example?q=${canaries.query}`,
    {
      method: "POST",
      headers: {
        authorization: canaries.authorization,
        cookie: canaries.cookie,
        "content-type": "application/json",
        ...headers,
      },
      body: JSON.stringify({
        password: canaries.password,
        ssn: canaries.ssn,
        note: canaries.body,
      }),
    },
  );
}

describe("withRouteHandler", () => {
  it("leaves a successful response unchanged apart from the correlation header", async () => {
    const { destination, route } = setup(async () =>
      Response.json(
        { ok: true },
        { status: 201, headers: { "x-app": "kept" } },
      ),
    );
    const response = await route(canaryRequest());
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ ok: true });
    expect(response.headers.get("x-app")).toBe("kept");
    const id = response.headers.get("x-correlation-id");
    expect(isValidCorrelationId(id)).toBe(true);

    const records = destination.records();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      level: "info",
      msg: "request.completed",
      correlationId: id,
      routeTemplate: "/api/example",
      method: "POST",
      statusCode: 201,
    });
    expect(typeof records[0].durationMs).toBe("number");
    expect(findCanaryCategories(destination.raw())).toEqual([]);
  });

  it("preserves a valid incoming correlation ID and exposes it to the request context", async () => {
    let seen: string | undefined;
    const { route } = setup(async ({ correlationId }) => {
      seen = getRequestContext()?.correlationId;
      expect(correlationId).toBe(validId);
      return new Response(null, { status: 204 });
    });
    const response = await route(
      canaryRequest({ "x-correlation-id": validId }),
    );
    expect(seen).toBe(validId);
    expect(response.headers.get("x-correlation-id")).toBe(validId);
  });

  it("replaces an injection-shaped incoming ID", async () => {
    const { route } = setup(async () => new Response(null, { status: 204 }));
    const forged = `${validId}-forged-extra-text`;
    const response = await route(canaryRequest({ "x-correlation-id": forged }));
    const id = response.headers.get("x-correlation-id");
    expect(id).not.toBe(forged);
    expect(isValidCorrelationId(id)).toBe(true);
  });

  it("maps an unexpected error to one safe problem response and one safe log record", async () => {
    const { destination, route } = setup(async () => {
      throw buildCanaryError();
    });
    const response = await route(canaryRequest());
    const headerId = response.headers.get("x-correlation-id");
    expect(response.status).toBe(500);
    expect(response.headers.get("content-type")).toBe(PROBLEM_CONTENT_TYPE);
    expect(response.headers.get("cache-control")).toBe("no-store");

    const bodyText = await response.text();
    expect(findCanaryCategories(bodyText)).toEqual([]);
    expect(JSON.parse(bodyText)).toEqual({
      type: "about:blank",
      title: "Unable to complete the request",
      status: 500,
      code: "INTERNAL_ERROR",
      correlationId: headerId,
    });

    const records = destination.records();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      level: "error",
      msg: "request.failed",
      errorCode: "INTERNAL.UNEXPECTED",
      statusCode: 500,
      correlationId: headerId,
    });
    expect(findCanaryCategories(destination.raw())).toEqual([]);
    for (const key of [
      "stack",
      "cause",
      "message",
      "body",
      "headers",
      "url",
      "query",
      "cookie",
    ]) {
      expect(destination.raw().includes(`"${key}"`), `log key ${key}`).toBe(
        false,
      );
    }
  });

  it.each([
    [
      new ValidationError(),
      400,
      "VALIDATION_FAILED",
      "VALIDATION.INVALID_INPUT",
    ],
    [new NotFoundError(), 404, "NOT_FOUND", "RESOURCE.NOT_FOUND"],
    [new AccessDeniedError(), 404, "NOT_FOUND", "ACCESS.DENIED"],
    [
      new DependencyError({ cause: buildCanaryError() }),
      503,
      "SERVICE_UNAVAILABLE",
      "DEPENDENCY.UNAVAILABLE",
    ],
  ])("maps trusted %o to %i %s", async (error, status, code, internal) => {
    const { destination, route } = setup(async () => {
      throw error;
    });
    const response = await route(canaryRequest());
    expect(response.status).toBe(status);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.code).toBe(code);
    expect(destination.records()[0].errorCode).toBe(internal);
    expect(
      findCanaryCategories(JSON.stringify(body) + destination.raw()),
    ).toEqual([]);
  });
});

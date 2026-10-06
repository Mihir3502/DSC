import { describe, expect, it } from "vitest";
import {
  buildCanaryError,
  canaries,
  createMemoryDestination,
  findCanaryCategories,
} from "../../../tests/fixtures/canaries";
import { createLogger } from "./pino-logger";
import { logRequestError } from "./request-error";

const correlationId = "0b9a7a3e-6a55-4c8e-9a3b-2f1d0c4e5a6b";

function capture() {
  const destination = createMemoryDestination();
  return { destination, logger: createLogger({ destination }) };
}

describe("logRequestError (instrumentation onRequestError)", () => {
  it("logs correlation ID, route path, method, fixed code, and digest only", () => {
    const { destination, logger } = capture();
    const error = Object.assign(buildCanaryError(), { digest: "4127839201" });
    logRequestError(logger, {
      error,
      request: {
        method: "GET",
        headers: {
          "x-correlation-id": correlationId,
          cookie: canaries.cookie,
          authorization: canaries.authorization,
        },
      },
      routePath: "/candidate",
    });
    const records = destination.records();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      level: "error",
      msg: "request.error",
      correlationId,
      routeTemplate: "/candidate",
      method: "GET",
      errorCode: "INTERNAL.UNEXPECTED",
      errorDigest: "4127839201",
    });
    expect(findCanaryCategories(destination.raw())).toEqual([]);
  });

  it("omits an invalid correlation header and non-string digests", () => {
    const { destination, logger } = capture();
    logRequestError(logger, {
      error: { digest: { nested: canaries.provider } },
      request: {
        method: "POST",
        headers: { "x-correlation-id": "forged\nvalue" },
      },
      routePath: "/staff",
    });
    const [record] = destination.records();
    expect(record).not.toHaveProperty("correlationId");
    expect(record).not.toHaveProperty("errorDigest");
    expect(findCanaryCategories(destination.raw())).toEqual([]);
  });

  it("handles thrown non-objects", () => {
    const { destination, logger } = capture();
    logRequestError(logger, {
      error: canaries.errorMessage,
      request: { method: "GET", headers: {} },
      routePath: "/",
    });
    expect(destination.records()[0].errorCode).toBe("INTERNAL.UNEXPECTED");
    expect(findCanaryCategories(destination.raw())).toEqual([]);
  });
});

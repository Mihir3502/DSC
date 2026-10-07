import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import {
  canaries,
  createMemoryDestination,
  findCanaryCategories,
} from "../tests/fixtures/canaries";
import { createProxy, routeLabel } from "./proxy";
import { createLogger, isValidCorrelationId } from "./shared/logging";

const validId = "0b9a7a3e-6a55-4c8e-9a3b-2f1d0c4e5a6b";

function run(path: string, headers: Record<string, string> = {}) {
  const destination = createMemoryDestination();
  const logger = createLogger({ destination });
  const proxy = createProxy(() => logger);
  const response = proxy(
    new NextRequest(`http://127.0.0.1:3100${path}`, {
      headers: {
        cookie: canaries.cookie,
        authorization: canaries.authorization,
        ...headers,
      },
    }),
  );
  return { response, destination };
}

describe("proxy (trusted web boundary)", () => {
  it("generates an ID, forwards it upstream, returns it, and logs request.received", () => {
    const { response, destination } = run(`/candidate?q=${canaries.query}`);
    const id = response.headers.get("x-correlation-id");
    expect(isValidCorrelationId(id)).toBe(true);
    // Next.js marks overridden upstream request headers with this prefix.
    expect(response.headers.get("x-middleware-request-x-correlation-id")).toBe(
      id,
    );

    const records = destination.records();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      level: "info",
      msg: "request.received",
      correlationId: id,
      routeTemplate: "/candidate",
      method: "GET",
    });
    // Status and duration are not observable in the proxy, so none are logged.
    expect(records[0]).not.toHaveProperty("statusCode");
    expect(records[0]).not.toHaveProperty("durationMs");
    expect(findCanaryCategories(destination.raw())).toEqual([]);
  });

  it("preserves a valid incoming ID", () => {
    const { response } = run("/", { "x-correlation-id": validId });
    expect(response.headers.get("x-correlation-id")).toBe(validId);
  });

  it("replaces an oversized or injection-shaped incoming ID", () => {
    const forged = `${validId}${"x".repeat(300)}`;
    const { response, destination } = run("/staff", {
      "x-correlation-id": forged,
    });
    const id = response.headers.get("x-correlation-id");
    expect(id).not.toBe(forged);
    expect(isValidCorrelationId(id)).toBe(true);
    expect(destination.raw().includes("xxxxxxxx")).toBe(false);
  });

  it.each([
    "/staff/activate",
    "/staff/sign-in",
    "/staff/mfa",
    "/staff/recover",
    "/staff/security",
    "/staff/reauthenticate",
  ])(
    "marks staff page %s private no-store with no referrer (M1.3/M1.5)",
    (path) => {
      const { response } = run(path);
      expect(response.headers.get("cache-control")).toBe(
        "private, no-store, max-age=0",
      );
      expect(response.headers.get("vary")).toBe("Cookie");
      expect(response.headers.get("referrer-policy")).toBe("no-referrer");
      expect(routeLabel(path)).toBe(path);
    },
  );

  // M1.7 §16: every protected prefix, not only staff pages, is private.
  it.each([
    "/register",
    "/sign-in",
    "/verify-email",
    "/recover",
    "/reset-password",
    "/candidate",
    "/candidate/security",
    "/staff",
    "/api/auth/get-session",
  ])("marks protected path %s private no-store (M1.7)", (path) => {
    const { response } = run(path);
    expect(response.headers.get("cache-control")).toBe(
      "private, no-store, max-age=0",
    );
    expect(response.headers.get("pragma")).toBe("no-cache");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("leaves only the public home page cacheable without personal data", () => {
    const { response } = run("/");
    expect(response.headers.get("cache-control")).not.toBe(
      "private, no-store, max-age=0",
    );
  });

  it.each([
    ["/", "/"],
    ["/staff", "/staff"],
    ["/candidate/123", "/(other)"],
    ["/api/anything/else", "/api/(other)"],
    ["/%0Aforged", "/(other)"],
  ])("labels %s as %s (never a raw path)", (path, label) => {
    expect(routeLabel(path)).toBe(label);
  });
});

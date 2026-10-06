import pino from "pino";
import { describe, expect, it } from "vitest";
import {
  buildCanaryError,
  buildCanaryRequestLike,
  buildCanarySensitiveObject,
  createMemoryDestination,
  findCanaryCategories,
} from "../../../tests/fixtures/canaries";
import type { LogContext } from "./log-context";
import { createLogger, pinoOptions } from "./pino-logger";
import { REDACT_MARKER } from "./redaction";

const correlationId = "0b9a7a3e-6a55-4c8e-9a3b-2f1d0c4e5a6b";

function capture(level: "debug" | "info" = "info") {
  const destination = createMemoryDestination();
  return { destination, logger: createLogger({ destination, level }) };
}

describe("structured logger", () => {
  it("emits one JSON record with timestamp, level label, service, and allowlisted context", () => {
    const { destination, logger } = capture();
    logger.info("request.completed", {
      correlationId,
      routeTemplate: "/candidate",
      method: "GET",
      statusCode: 200,
      durationMs: 12.4,
    });
    const [record] = destination.records();
    expect(record).toMatchObject({
      level: "info",
      msg: "request.completed",
      service: "psa-hiring",
      correlationId,
      routeTemplate: "/candidate",
      method: "GET",
      statusCode: 200,
      durationMs: 12,
    });
    expect(new Date(record.time as string).toISOString()).toBe(record.time);
    expect(Object.keys(record).sort()).toEqual(
      [
        "correlationId",
        "durationMs",
        "environment",
        "level",
        "method",
        "msg",
        "routeTemplate",
        "service",
        "statusCode",
        "time",
      ].sort(),
    );
  });

  it("child loggers keep bound correlation and approved fields", () => {
    const { destination, logger } = capture();
    logger
      .child({ correlationId, module: "readiness" })
      .warn("gate.blocked", { resultCode: "missing_tb" });
    expect(destination.records()[0]).toMatchObject({
      level: "warn",
      msg: "gate.blocked",
      correlationId,
      module: "readiness",
      resultCode: "missing_tb",
    });
  });

  it("respects the configured level", () => {
    const { destination, logger } = capture("info");
    logger.debug("debug.event");
    expect(destination.records()).toEqual([]);
  });

  it("drops invalid values instead of logging them, and neutralizes bad event codes", () => {
    const { destination, logger } = capture();
    logger.info('forged\n{"level":"error"}', {
      correlationId: "not-a-uuid",
      routeTemplate: "https://app.example.test/candidate?x=1",
      action: "Bad Action With Spaces",
      statusCode: 99_999,
      durationMs: Number.NaN,
      actorRef: "user@example.test",
    });
    const raw = destination.raw();
    expect(raw.split("\n").filter(Boolean)).toHaveLength(1);
    const [record] = destination.records();
    expect(record.msg).toBe("invalid.event_code");
    for (const key of [
      "correlationId",
      "routeTemplate",
      "action",
      "statusCode",
      "durationMs",
      "actorRef",
    ]) {
      expect(record).not.toHaveProperty(key);
    }
  });

  it("rejects broad objects at the type level", () => {
    const { logger } = capture();
    const request = new Request("https://app.example.test/");
    // @ts-expect-error an Error is not a LogContext
    logger.error("request.failed", new Error("x"));
    // @ts-expect-error a Request is not a LogContext
    logger.info("request.received", request);
    // @ts-expect-error Headers are not a LogContext
    logger.info("request.received", request.headers);
    // @ts-expect-error arbitrary keys are not part of the allowlist
    logger.info("request.received", { body: "x" } satisfies Record<
      string,
      string
    >);
    const ok: LogContext = { correlationId };
    logger.info("request.received", ok);
  });
});

describe("leakage resistance (whole captured output)", () => {
  it("drops a request-like object's body, headers, cookies, query, and URL", () => {
    const { destination, logger } = capture();
    logger.info("request.received", buildCanaryRequestLike() as never);
    logger.child(buildCanaryRequestLike() as never).info("request.received");
    const raw = destination.raw();
    expect(findCanaryCategories(raw)).toEqual([]);
    for (const key of ["body", "headers", "cookies", "query", "url"]) {
      expect(raw.includes(`"${key}"`), `serialized key ${key}`).toBe(false);
    }
  });

  it("drops nested sensitive fields of every category", () => {
    const { destination, logger } = capture();
    logger.error("request.failed", buildCanarySensitiveObject() as never);
    expect(findCanaryCategories(destination.raw())).toEqual([]);
  });

  it("never serializes an Error's message, stack, or cause", () => {
    const { destination, logger } = capture();
    logger.error("request.failed", buildCanaryError() as never);
    logger.error("request.failed", {
      err: buildCanaryError(),
      error: buildCanaryError(),
    } as never);
    expect(findCanaryCategories(destination.raw())).toEqual([]);
  });

  it("outputs machine-readable JSON in test mode without any pretty printer", () => {
    const { destination, logger } = capture();
    logger.info("startup.ready");
    expect(() => destination.records()).not.toThrow();
    expect(destination.raw().startsWith("{")).toBe(true);
  });
});

describe("pino redaction configuration (defense in depth)", () => {
  it("replaces sensitive paths with the constant marker before serialization", () => {
    // Same options as the adapter, minus the allowlist formatter, to prove the
    // redaction layer on its own.
    const destination = createMemoryDestination();
    const options = pinoOptions();
    const raw = pino(
      { ...options, formatters: { level: options.formatters!.level } },
      destination,
    );
    raw.info(buildCanarySensitiveObject(), "redaction.check");
    const output = destination.raw();
    expect(findCanaryCategories(output)).toEqual([]);
    // Boolean assertions so a failure never prints the captured output.
    for (const key of [
      "password",
      "ssn",
      "headers",
      "documentContent",
      "sql",
    ]) {
      expect(
        output.includes(`"${key}":"${REDACT_MARKER}"`),
        `${key} marker`,
      ).toBe(true);
    }
    // No partial forms (prefixes, suffixes, lengths): the canary tag is absent.
    expect(output.includes("9f3c2a"), "partial canary form").toBe(false);
  });
});

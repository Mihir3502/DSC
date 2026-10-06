import { describe, expect, it } from "vitest";
import {
  generateCorrelationId,
  isValidCorrelationId,
  resolveCorrelationId,
} from "./correlation";
import { getRequestContext, runWithRequestContext } from "./request-context";

const valid = "0b9a7a3e-6a55-4c8e-9a3b-2f1d0c4e5a6b";

describe("correlation IDs", () => {
  it.each([null, undefined, ""])(
    "generates a valid ID when the incoming value is %j",
    (incoming) => {
      const id = resolveCorrelationId(incoming);
      expect(isValidCorrelationId(id)).toBe(true);
    },
  );

  it("preserves a valid incoming UUID (normalized to lowercase)", () => {
    expect(resolveCorrelationId(valid)).toBe(valid);
    expect(resolveCorrelationId(valid.toUpperCase())).toBe(valid);
  });

  it.each([
    ["oversized", `${valid}${"a".repeat(500)}`],
    ["leading whitespace", ` ${valid}`],
    ["trailing newline", `${valid}\n`],
    ["log injection", `${valid}\n{"level":"error","msg":"forged"}`],
    ["header injection", `${valid}\r\nset-cookie: x=1`],
    ["not a UUID", "request-12345"],
    ["UUID with suffix", `${valid}-extra`],
    ["control characters", `0b9a7a3e-6a55-4c8e-9a3b-2f1d0c4e5a6\u0000`],
    ["script", "<script>alert(1)</script>"],
  ])("rejects and replaces an %s value", (_label, incoming) => {
    const id = resolveCorrelationId(incoming);
    expect(id).not.toBe(incoming);
    expect(isValidCorrelationId(id)).toBe(true);
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("generates distinct IDs", () => {
    const ids = new Set(
      Array.from({ length: 100 }, () => generateCorrelationId()),
    );
    expect(ids.size).toBe(100);
  });
});

describe("request context isolation", () => {
  it("returns undefined outside a request", () => {
    expect(getRequestContext()).toBeUndefined();
  });

  it("keeps concurrent requests' IDs separate across interleaved awaits", async () => {
    // Deferred gates force the two flows to interleave without sleeps.
    let releaseA!: () => void;
    let releaseB!: () => void;
    const gateA = new Promise<void>((r) => (releaseA = r));
    const gateB = new Promise<void>((r) => (releaseB = r));
    const idA = generateCorrelationId();
    const idB = generateCorrelationId();

    const flowA = runWithRequestContext({ correlationId: idA }, async () => {
      const before = getRequestContext()?.correlationId;
      releaseB();
      await gateA;
      return [before, getRequestContext()?.correlationId];
    });
    const flowB = runWithRequestContext({ correlationId: idB }, async () => {
      await gateB;
      const seen = getRequestContext()?.correlationId;
      releaseA();
      return [seen, getRequestContext()?.correlationId];
    });

    expect(await flowA).toEqual([idA, idA]);
    expect(await flowB).toEqual([idB, idB]);
    expect(getRequestContext()).toBeUndefined();
  });

  it("freezes the stored context", () => {
    runWithRequestContext({ correlationId: valid }, () => {
      expect(Object.isFrozen(getRequestContext())).toBe(true);
    });
  });
});

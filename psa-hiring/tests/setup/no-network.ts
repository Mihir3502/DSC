import { afterEach, beforeEach, vi } from "vitest";

// Unit and component tests must never reach the network. Any fetch fails the
// test immediately with a clear message instead of silently contacting a host.

beforeEach(() => {
  vi.stubGlobal("fetch", (input: unknown) => {
    const target =
      input instanceof URL
        ? input.origin
        : typeof input === "string"
          ? safeOrigin(input)
          : "request";
    throw new Error(
      `Network access is not allowed in unit/component tests (attempted ${target}).`,
    );
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function safeOrigin(value: string): string {
  try {
    return new URL(value).origin;
  } catch {
    return "a relative URL";
  }
}

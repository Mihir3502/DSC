import { describe, expect, it, vi } from "vitest";

// Route Handlers and pages are separate Next.js bundles, so each gets its own
// copy of this module. A transaction bound in one copy must be visible to an
// adapter from another, or the adapter takes a second pooled connection and
// concurrent commands starve the pool (M2.5 defect).

describe("authorization executor", () => {
  it("is shared across separately loaded copies of the module", async () => {
    const first = await import("./authorization-executor");
    vi.resetModules();
    const second = await import("./authorization-executor");
    expect(second).not.toBe(first);
    const tx = { marker: "TEST transaction" };
    await first.withAuthorizationExecutor(tx, async () => {
      expect(second.currentAuthorizationExecutor()).toBe(tx);
    });
    expect(second.currentAuthorizationExecutor()).toBeUndefined();
  });
});

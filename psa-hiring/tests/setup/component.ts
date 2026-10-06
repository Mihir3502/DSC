import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";
import "./no-network";

// Shared setup for the jsdom component project: jest-dom matchers, the
// no-network guard, and DOM cleanup after every test.

afterEach(() => {
  cleanup();
});

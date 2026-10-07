import path from "node:path";
import { defineConfig } from "vitest/config";

// Three disjoint Vitest projects:
//   unit        Node   src/**/*.test.ts, scripts/**/*.test.ts, tests/guards/**/*.test.ts
//   component   jsdom  src/**/*.test.tsx
//   integration Node   tests/integration/**/*.test.ts (owned disposable PostgreSQL)
// Playwright specs (tests/e2e, tests/accessibility) are never picked up here.

const alias = { "@": path.resolve(import.meta.dirname, "src") };
// Server-only modules run in Node for unit/integration tests, so resolve the
// `server-only` guard to its no-op. The jsdom component project keeps the
// real guard, so client components still cannot import server code.
const serverAlias = {
  ...alias,
  "server-only": path.resolve(
    import.meta.dirname,
    "node_modules/server-only/empty.js",
  ),
};

export default defineConfig({
  resolve: { alias },
  // Matches tsconfig "jsx": "react-jsx".
  oxc: { jsx: { runtime: "automatic" } },
  test: {
    // Fail on focused tests everywhere; zero silent retries locally.
    allowOnly: false,
    retry: 0,
    passWithNoTests: false,
    restoreMocks: true,
    unstubEnvs: true,
    unstubGlobals: true,
    coverage: {
      provider: "v8",
      reportsDirectory: "coverage",
      reporter: ["text", "json-summary", "lcov"],
      include: ["src/**/*.{ts,tsx}"],
      exclude: [
        // Test code is not production code.
        "src/**/*.test.{ts,tsx}",
        // Declaration-only files contain no executable code.
        "src/**/*.d.ts",
      ],
    },
    projects: [
      {
        extends: true,
        resolve: { alias: serverAlias },
        test: {
          name: "unit",
          environment: "node",
          include: [
            "src/**/*.test.ts",
            "scripts/**/*.test.ts",
            "tests/guards/**/*.test.ts",
            // M1.7 in-memory authorization/authentication/security matrix.
            "tests/authorization/**/*.test.ts",
            "tests/authentication/**/*.test.ts",
            "tests/security/**/*.test.ts",
          ],
          setupFiles: ["tests/setup/no-network.ts"],
        },
      },
      {
        extends: true,
        test: {
          name: "component",
          environment: "jsdom",
          include: ["src/**/*.test.tsx"],
          setupFiles: ["tests/setup/component.ts"],
        },
      },
      {
        extends: true,
        resolve: { alias: serverAlias },
        test: {
          name: "integration",
          environment: "node",
          include: ["tests/integration/**/*.test.ts"],
          globalSetup: ["tests/integration/support/global-setup.ts"],
          // One owned container, one worker: files run serially so local role
          // bootstrap (cluster-wide) never races between files.
          fileParallelism: false,
          maxWorkers: 1,
          testTimeout: 60_000,
          hookTimeout: 180_000,
        },
      },
    ],
  },
});

import { defineConfig, devices } from "@playwright/test";

// Browser tests run against a production build served on a dedicated
// loopback port. Artifacts go to ignored folders and are kept only on
// failure. No storage state (auth) is used or committed.
//
// Projects: Chromium always. Firefox/WebKit are defined for main/nightly runs
// and enabled with E2E_BROWSERS=chromium,firefox,webkit (after installing
// those browsers with `pnpm exec playwright install firefox webkit`).

const port = 3100;
const baseURL = `http://127.0.0.1:${port}`;
const enabled = new Set(
  (process.env.E2E_BROWSERS ?? "chromium").split(",").map((b) => b.trim()),
);

const allProjects = [
  { name: "chromium", use: { ...devices["Desktop Chrome"] } },
  { name: "firefox", use: { ...devices["Desktop Firefox"] } },
  { name: "webkit", use: { ...devices["Desktop Safari"] } },
];

export default defineConfig({
  testDir: "./tests",
  testMatch: ["e2e/**/*.spec.ts", "accessibility/**/*.a11y.spec.ts"],
  outputDir: "test-results",
  fullyParallel: true,
  forbidOnly: true,
  // No automatic retries locally or in CI: a failure must fail the gate
  // (TEST_STRATEGY §39; M0.6 §8.6).
  retries: 0,
  reporter: [
    ["list"],
    ["html", { outputFolder: "playwright-report", open: "never" }],
  ],
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: allProjects.filter((p) => enabled.has(p.name)),
  webServer: {
    command: `pnpm build && pnpm exec next start --hostname 127.0.0.1 --port ${port}`,
    url: baseURL,
    // Always start a fresh production server on the dedicated port so tests
    // never run against an unknown process.
    reuseExistingServer: false,
    timeout: 180_000,
    stdout: "ignore",
    stderr: "pipe",
    env: { NEXT_TELEMETRY_DISABLED: "1", APP_ENV: "test" },
  },
});

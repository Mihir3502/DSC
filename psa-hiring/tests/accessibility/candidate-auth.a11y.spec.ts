import AxeBuilder from "@axe-core/playwright";
import type { Page, TestInfo } from "@playwright/test";
import {
  PASSWORD,
  readyCandidate,
  signIn,
  useDistinctClient,
} from "../e2e/support/candidate-auth";
import { expect, test } from "../e2e/support/fixtures";

// Automated axe scans for candidate authentication screens (packet M1.2
// §14), including error and authenticated states. Serious/critical
// violations fail; no rules are disabled. Manual keyboard and screen-reader
// review is recorded separately in the completion report.

test.use({ trace: "off" });

const blocking = new Set(["serious", "critical"]);

async function expectNoBlockingViolations(page: Page, testInfo: TestInfo) {
  const results = await new AxeBuilder({ page })
    .withTags([
      "wcag2a",
      "wcag2aa",
      "wcag21a",
      "wcag21aa",
      "wcag22aa",
      "best-practice",
    ])
    .analyze();
  for (const v of results.violations) {
    testInfo.annotations.push({
      type: "axe",
      description: `${v.impact ?? "unknown"} ${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`,
    });
  }
  expect(
    results.violations
      .filter((v) => blocking.has(v.impact ?? ""))
      .map((v) => `${v.impact} ${v.id} (${v.nodes.length} node(s))`),
    "serious/critical axe violations",
  ).toEqual([]);
}

test.beforeEach(async ({ page }) => {
  await useDistinctClient(page);
});

for (const path of [
  "/register",
  "/sign-in",
  "/verify-email",
  "/recover",
  "/reset-password",
]) {
  test(
    `${path} has no serious or critical axe violations`,
    { tag: "@critical" },
    async ({ page }, testInfo) => {
      await page.goto(path);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await expect(page.getByRole("main")).not.toContainText("Preparing");
      await expectNoBlockingViolations(page, testInfo);
    },
  );
}

test(
  "form error states have no serious or critical axe violations",
  { tag: "@critical" },
  async ({ page }, testInfo) => {
    await page.goto("/register");
    await page.getByRole("button", { name: "Create account" }).click();
    await expect(page.getByRole("main").getByRole("alert")).toBeFocused();
    await expectNoBlockingViolations(page, testInfo);

    await page.goto("/sign-in");
    await page.getByLabel("Email address").fill("not-an-email");
    await page.getByLabel("Password").fill("x");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByRole("main").getByRole("alert")).toBeVisible();
    await expectNoBlockingViolations(page, testInfo);
  },
);

test(
  "/candidate/security has no serious or critical axe violations",
  { tag: "@critical" },
  async ({ page }, testInfo) => {
    const email = await readyCandidate(page, "a11y");
    await signIn(page, email, PASSWORD);
    await expect(page).toHaveURL("/candidate/security");
    await expectNoBlockingViolations(page, testInfo);
  },
);

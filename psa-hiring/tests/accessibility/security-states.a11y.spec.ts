import AxeBuilder from "@axe-core/playwright";
import type { Page, TestInfo } from "@playwright/test";
import {
  readyCandidate,
  signIn,
  useDistinctClient,
} from "../e2e/support/candidate-auth";
import { acceptExpectedNotFound, expect, test } from "../e2e/support/fixtures";

// Automated accessibility checks for the M1.5 shared security states
// (packet M1.5 §19, AC-M1.5-10/11): the safe not-found state shown for
// unknown and hidden routes, its keyboard path, and 320 px / 200% zoom
// reflow. Serious/critical violations fail; no rules are disabled.

test.use({ trace: "off", screenshot: "off", video: "off" });

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

async function overflow(page: Page) {
  return page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
}

test.beforeEach(async ({ page }) => {
  await useDistinctClient(page);
});

test.describe("security states", { tag: "@critical" }, () => {
  test("the safe not-found state is accessible and keyboard operable", async ({
    page,
    guards,
  }, testInfo) => {
    await page.goto("/no-such-page");
    const heading = page.getByRole("heading", {
      level: 1,
      name: "Page not found",
    });
    await expect(heading).toBeFocused();
    await expect(page).toHaveTitle(/^Page not found/);
    await expect(page.getByRole("main").getByRole("status")).toBeVisible();
    await expectNoBlockingViolations(page, testInfo);
    // Keyboard: the safe return action is reachable and works.
    const home = page.getByRole("link", { name: "Go to the home page" });
    for (let i = 0; i < 10; i += 1) {
      await page.keyboard.press("Tab");
      if (await home.evaluate((el) => el === document.activeElement)) break;
    }
    await expect(home).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL("/");
    acceptExpectedNotFound(guards, 1);
  });

  test("a hidden staff route shown to a candidate is accessible and reflows", async ({
    page,
    guards,
  }, testInfo) => {
    const email = await readyCandidate(page, "a11y-hidden");
    await signIn(page, email);
    await expect(page).toHaveURL("/candidate/security");
    await page.goto("/staff/security");
    await expect(
      page.getByRole("heading", { level: 1, name: "Page not found" }),
    ).toBeFocused();
    await expectNoBlockingViolations(page, testInfo);
    await page.setViewportSize({ width: 320, height: 800 });
    await page.goto("/staff/security");
    expect(await overflow(page)).toBeLessThanOrEqual(1);
    // 200% zoom at a 1280 px window is a 640 CSS px layout viewport.
    await page.setViewportSize({ width: 640, height: 800 });
    await page.goto("/staff/reauthenticate");
    expect(await overflow(page)).toBeLessThanOrEqual(1);
    acceptExpectedNotFound(guards, 3);
  });
});

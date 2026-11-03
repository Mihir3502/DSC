import AxeBuilder from "@axe-core/playwright";
import { randomBytes } from "node:crypto";
import type { Page, TestInfo } from "@playwright/test";
import { openCycle, startDraft } from "../e2e/support/application-draft";
import { useDistinctClient } from "../e2e/support/candidate-auth";
import { expect, test } from "../e2e/support/fixtures";
import { orgHarness, type Tree } from "../e2e/support/organization";

// M2.3 accessibility (packet M2.3 §21, AC-M2.3-14; WCAG 2.2 AA): axe on home,
// tasks, and help; the mobile menu's name, state, Escape, and focus return;
// reflow at 320 CSS px; and reduced motion.

test.use({
  trace: "off",
  screenshot: "off",
  video: "off",
  contextOptions: { reducedMotion: "reduce" },
});

async function expectNoBlockingViolations(page: Page, testInfo: TestInfo) {
  await expect(page).toHaveTitle(/\S/);
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
  testInfo.annotations.push({
    type: "axe-violation-ids",
    description: results.violations.map((v) => v.id).join(","),
  });
  expect(
    results.violations
      .filter((v) => v.impact === "serious" || v.impact === "critical")
      .map(
        (v) =>
          `${v.impact} ${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`,
      ),
    "serious/critical axe violations",
  ).toEqual([]);
}

async function expectReflow(page: Page) {
  await page.setViewportSize({ width: 320, height: 800 });
  const overflowing = await page.evaluate(() => {
    const limit = document.documentElement.clientWidth;
    return [...document.querySelectorAll("body *")]
      .filter((el) => el.getBoundingClientRect().right > limit + 1)
      .map((el) => el.tagName.toLowerCase())
      .slice(0, 8);
  });
  expect(overflowing, "no element overflows at 320 px").toEqual([]);
  await page.setViewportSize({ width: 1280, height: 800 });
}

test.describe("candidate portal accessibility @critical", () => {
  test("home, tasks, help, and the mobile menu are accessible and reflow @critical", async ({
    page,
  }, testInfo) => {
    test.setTimeout(90_000);
    const id = randomBytes(3).toString("hex").toUpperCase();
    const tree = await orgHarness<Tree>("provision", id);
    const ref = await openCycle(tree, id, `TEST A11y Portal ${id}`);
    await useDistinctClient(page);
    await startDraft(page, ref, "portal-a11y");

    for (const path of [
      "/candidate",
      "/candidate/tasks",
      "/candidate/tasks?filter=completed",
      "/candidate/help",
    ]) {
      await page.goto(path);
      await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
      await expectNoBlockingViolations(page, testInfo);
      await expectReflow(page);
    }

    await page.setViewportSize({ width: 390, height: 800 });
    await page.goto("/candidate");
    const portal = page.getByRole("navigation", { name: "Candidate portal" });
    const menu = portal.getByRole("button", { name: "Menu" });
    await expect(menu).toHaveAttribute("aria-expanded", "false");
    await expect(portal.getByRole("link", { name: "Home" })).toBeHidden();
    await menu.focus();
    await page.keyboard.press("Enter");
    const close = portal.getByRole("button", { name: "Close menu" });
    await expect(close).toHaveAttribute("aria-expanded", "true");
    const home = portal.getByRole("link", { name: "Home" });
    await expect(home).toBeVisible();
    await expect(home).toHaveAttribute("aria-current", "page");
    expect((await home.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await expectNoBlockingViolations(page, testInfo);
    await page.keyboard.press("Escape");
    await expect(menu).toBeFocused();
    await expect(home).toBeHidden();
  });
});

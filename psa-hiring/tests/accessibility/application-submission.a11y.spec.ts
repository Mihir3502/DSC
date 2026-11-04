import AxeBuilder from "@axe-core/playwright";
import { randomBytes } from "node:crypto";
import type { Page, TestInfo } from "@playwright/test";
import {
  completeRequiredSections,
  openCycle,
  startDraft,
} from "../e2e/support/application-draft";
import { useDistinctClient } from "../e2e/support/candidate-auth";
import { expect, test } from "../e2e/support/fixtures";
import { orgHarness, type Tree } from "../e2e/support/organization";

// M2.6 accessibility (packet M2.6 §12; WCAG 2.2 AA): axe on the incomplete and
// complete review page, the confirmation, and the receipt; keyboard operation;
// focus on confirmation; and reflow at 320 CSS px.

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

test.describe("application submission accessibility @critical", () => {
  test("review, confirmation, and receipt are accessible and keyboard operable @critical", async ({
    page,
  }, testInfo) => {
    test.setTimeout(120_000);
    const id = randomBytes(3).toString("hex").toUpperCase();
    const tree = await orgHarness<Tree>("provision", id);
    const ref = await openCycle(tree, id, `TEST A11y Submit ${id}`);
    await useDistinctClient(page);
    const overview = await startDraft(page, ref, "submit-a11y");
    await page.getByRole("button", { name: "Begin application" }).click();
    await expect(
      page.getByRole("link", { name: "Review and submit" }),
    ).toBeVisible();
    await page.goto(`${overview}/review`);
    await expectNoBlockingViolations(page, testInfo);
    await expectReflow(page);

    await completeRequiredSections(page, overview);
    await page.goto(`${overview}/review`);
    await expectNoBlockingViolations(page, testInfo);
    await expectReflow(page);

    const box = page.getByLabel("I certify the statement above.");
    await box.focus();
    await page.keyboard.press("Space");
    await expect(box).toBeChecked();
    await page.getByLabel("Type your full name").fill("TEST Ada Example");
    await page.getByRole("button", { name: "Submit application" }).focus();
    await page.keyboard.press("Enter");
    const confirm = page.getByRole("button", { name: "Confirm and submit" });
    await expect(confirm).toBeFocused();
    await expectNoBlockingViolations(page, testInfo);
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(`${overview}/submitted`);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expectNoBlockingViolations(page, testInfo);
    await expectReflow(page);
  });
});

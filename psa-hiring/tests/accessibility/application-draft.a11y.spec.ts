import AxeBuilder from "@axe-core/playwright";
import { randomBytes } from "node:crypto";
import type { Page, TestInfo } from "@playwright/test";
import { useDistinctClient } from "../e2e/support/candidate-auth";
import { expect, test } from "../e2e/support/fixtures";
import { orgHarness, type Tree } from "../e2e/support/organization";
import { openCycle, startDraft } from "../e2e/support/application-draft";

// M2.4 accessibility (packet M2.4 §12; WCAG 2.2 AA): axe on the overview and
// on a section with its error state; keyboard operation; focus on the error
// summary; targets of at least 24 px; reflow at 320 CSS px.

test.use({ trace: "off", screenshot: "off", video: "off" });

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
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth <=
        document.documentElement.clientWidth,
    ),
    "no horizontal scrolling at 320 px",
  ).toBe(true);
  await page.setViewportSize({ width: 1280, height: 800 });
}

test.describe("application draft accessibility @critical", () => {
  test("the overview and section form are accessible, keyboard operable, and reflow @critical", async ({
    page,
  }, testInfo) => {
    test.setTimeout(90_000);
    const id = randomBytes(3).toString("hex").toUpperCase();
    const tree = await orgHarness<Tree>("provision", id);
    const ref = await openCycle(tree, id, `TEST A11y Draft ${id}`);
    await useDistinctClient(page);
    const overview = await startDraft(page, ref, "draft-a11y");
    await expectNoBlockingViolations(page, testInfo);
    await expectReflow(page);

    await page.getByRole("button", { name: "Begin application" }).focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("link", { name: "References" })).toBeVisible();
    await expectNoBlockingViolations(page, testInfo);
    await expectReflow(page);

    await page.goto(`${overview}/references`);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      "References",
    );
    await expectNoBlockingViolations(page, testInfo);
    await expectReflow(page);

    const email = page.getByLabel(/Reference 1: email address/);
    await email.fill("not-an-email");
    await page.getByRole("button", { name: "Save draft" }).focus();
    await page.keyboard.press("Enter");
    const alert = page.getByRole("main").getByRole("alert");
    await expect(alert).toBeFocused();
    await expect(email).toHaveAttribute("aria-invalid", "true");
    await expect(email).toHaveAccessibleDescription(/valid email address/);
    await expectNoBlockingViolations(page, testInfo);

    await page.goto(`${overview}/availability`);
    const checkbox = page.getByRole("checkbox", { name: "Monday" });
    await checkbox.focus();
    await page.keyboard.press("Space");
    await expect(checkbox).toBeChecked();
    const box = await page
      .getByRole("button", { name: "Save draft" })
      .boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(24);
    await expectNoBlockingViolations(page, testInfo);
  });
});

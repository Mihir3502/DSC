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
import { activateStaff, staffSignIn } from "../e2e/support/staff-auth";

// M3.3 accessibility (packet M3.3 §12; WCAG 2.2 AA): axe on the prescreen screen
// before acceptance, with the checklist, with a confirmation open, and on hold;
// keyboard use of the answers; reflow at 320 CSS px.

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
  ).toEqual([]);
}

test.describe("application prescreen accessibility", () => {
  test("the prescreen screen is accessible and reflows", async ({
    page,
    browser,
  }, testInfo) => {
    test.setTimeout(180_000);
    const id = randomBytes(3).toString("hex").toUpperCase();
    const tree = await orgHarness<Tree>("provision", id);
    const ref = await openCycle(tree, id, `TEST A11y Prescreen ${id}`);
    await useDistinctClient(page);
    const overview = await startDraft(page, ref, "pre-a11y");
    await page.getByRole("button", { name: "Begin application" }).click();
    await expect(
      page.getByRole("link", { name: "Review and submit" }),
    ).toBeVisible();
    await completeRequiredSections(page, overview);
    await page.goto(`${overview}/review`);
    await page.getByLabel("I certify the statement above.").check();
    await page.getByLabel("Type your full name").fill("TEST Ada Example");
    await page.getByRole("button", { name: "Submit application" }).click();
    await page.getByRole("button", { name: "Confirm and submit" }).click();
    await expect(page).toHaveURL(`${overview}/submitted`);
    const screen = `/staff/candidates/${overview.split("/").pop()!}/recruiting/prescreen`;

    const context = await browser.newContext({ reducedMotion: "reduce" });
    const staff = await context.newPage();
    const hr = await activateStaff(staff, "pre-a11y-hr");
    await orgHarness(
      "grant",
      hr.email,
      "HR_SPECIALIST",
      "ORGANIZATION",
      tree.org,
    );
    await staffSignIn(staff, hr);
    const main = staff.getByRole("main");

    await staff.goto(screen);
    await expect(staff.getByRole("heading", { level: 1 })).toHaveCount(1);
    await expectNoBlockingViolations(staff, testInfo);

    await staff.getByRole("button", { name: "Accept for prescreen" }).click();
    await expectNoBlockingViolations(staff, testInfo);
    await staff
      .getByRole("button", { name: "Confirm: Accept for prescreen" })
      .click();
    await expect(main).toContainText("In progress");
    await expectNoBlockingViolations(staff, testInfo);

    // Each item is a labelled radio group that works by keyboard.
    const first = main.getByRole("group").first();
    await first.getByLabel("Met", { exact: true }).focus();
    await staff.keyboard.press("Space");
    await expect(first.getByLabel("Met", { exact: true })).toBeChecked();
    await staff.keyboard.press("ArrowDown");
    await expect(first.getByLabel("Not met", { exact: true })).toBeChecked();

    const opener = staff.getByRole("button", { name: "Place on hold" });
    await opener.click();
    const dialog = staff.getByRole("dialog");
    await expect(dialog.getByLabel(/Internal reason/)).toBeVisible();
    await expectNoBlockingViolations(staff, testInfo);
    await staff.keyboard.press("Escape");
    await expect(opener).toBeFocused();

    await opener.click();
    await dialog
      .getByLabel("Reason", { exact: true })
      .selectOption({ label: "Internal review" });
    await dialog.getByLabel(/Internal reason/).fill("TEST reason");
    await dialog
      .getByLabel(/Review by/)
      .fill(new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10));
    await dialog
      .getByRole("button", { name: "Confirm: Place on hold" })
      .click();
    await expect(main).toContainText("Remove hold");
    await expectNoBlockingViolations(staff, testInfo);

    await staff.setViewportSize({ width: 320, height: 640 });
    await staff.goto(screen);
    await expect(main).toBeVisible();
    const overflowing = await staff.evaluate(
      () =>
        document.documentElement.scrollWidth >
        document.documentElement.clientWidth,
    );
    expect(overflowing, "no sideways scrolling").toBe(false);
    await context.close();
  });
});

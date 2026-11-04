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

// M3.1 accessibility (packet M3.1 §12; WCAG 2.2 AA): axe on the dashboard, the
// queue, its empty state, and the responsibility panel with its dialog open;
// keyboard use of the confirmation; reflow at 320 CSS px.

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

async function expectNoSideways(page: Page) {
  const overflowing = await page.evaluate(
    () =>
      document.documentElement.scrollWidth >
      document.documentElement.clientWidth,
  );
  expect(overflowing, `no sideways scrolling at ${page.url()}`).toBe(false);
}

test.describe("staff work queue accessibility", () => {
  test("the dashboard, queue, and responsibility panel are accessible and reflow", async ({
    page,
    browser,
  }, testInfo) => {
    test.setTimeout(180_000);
    const id = randomBytes(3).toString("hex").toUpperCase();
    const tree = await orgHarness<Tree>("provision", id);
    const ref = await openCycle(tree, id, `TEST A11y Queue ${id}`);
    await useDistinctClient(page);
    const overview = await startDraft(page, ref, "queue-a11y");
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
    const candidacy = overview.split("/").pop()!;

    const context = await browser.newContext({
      reducedMotion: "reduce",
    });
    const staff = await context.newPage();
    const manager = await activateStaff(staff, "queue-a11y-manager");
    await orgHarness(
      "grant",
      manager.email,
      "PSA_MANAGER",
      "ORGANIZATION",
      tree.org,
    );
    await staffSignIn(staff, manager);

    await staff.goto("/staff");
    await expect(staff.getByRole("heading", { level: 1 })).toHaveText(
      "Dashboard",
    );
    await expectNoBlockingViolations(staff, testInfo);

    await staff.goto("/staff/work");
    await expect(staff.getByRole("status")).toContainText("match");
    await expectNoBlockingViolations(staff, testInfo);

    await staff.goto("/staff/work?stage=PROSPECT&due=OVERDUE");
    await expect(staff.getByRole("main")).toContainText(
      "Nothing matches these filters.",
    );
    await expectNoBlockingViolations(staff, testInfo);

    await staff.goto("/staff/work?stage=OFFER");
    await expect(staff.getByRole("main").getByRole("alert")).toContainText(
      "those filters",
    );
    await expectNoBlockingViolations(staff, testInfo);

    await staff.goto(`/staff/work/${candidacy}`);
    await expect(staff.getByRole("heading", { name: "Owner" })).toBeVisible();
    await expectNoBlockingViolations(staff, testInfo);

    // The dialog traps focus, names its fields, and returns focus on close.
    const opener = staff.getByRole("button", { name: "Set due date" });
    await opener.focus();
    await staff.keyboard.press("Enter");
    const dialog = staff.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel(/Due date/)).toBeVisible();
    await expectNoBlockingViolations(staff, testInfo);
    await staff.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(opener).toBeFocused();

    await staff.setViewportSize({ width: 320, height: 640 });
    // On a phone the menu is a disclosure that opens by keyboard and closes on
    // Escape, returning focus to its button.
    const menuButton = staff.getByRole("button", { name: "Menu" });
    await menuButton.focus();
    await staff.keyboard.press("Enter");
    const menu = staff.getByRole("navigation", { name: "Staff" });
    await expect(menu.getByRole("link", { name: "Positions" })).toBeVisible();
    await expectNoBlockingViolations(staff, testInfo);
    await staff.keyboard.press("Escape");
    await expect(menu.getByRole("link", { name: "Positions" })).toBeHidden();
    await expect(menuButton).toBeFocused();
    for (const path of ["/staff", "/staff/work", `/staff/work/${candidacy}`]) {
      await staff.goto(path);
      await expect(staff.getByRole("main")).toBeVisible();
      await expectNoSideways(staff);
    }
    await context.close();
  });
});

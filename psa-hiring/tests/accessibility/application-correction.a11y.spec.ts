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

// M2.7 accessibility (packet M2.7 §12; WCAG 2.2 AA): axe on the staff return
// form and confirmation, and on the candidate's correction view; focus on
// confirmation; reflow at 320 CSS px.

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

test.describe("application correction accessibility @critical", () => {
  test("the staff return form and candidate correction view are accessible @critical", async ({
    page,
    browser,
  }, testInfo) => {
    test.setTimeout(150_000);
    const id = randomBytes(3).toString("hex").toUpperCase();
    const tree = await orgHarness<Tree>("provision", id);
    const ref = await openCycle(tree, id, `TEST A11y Correct ${id}`);
    await useDistinctClient(page);
    const overview = await startDraft(page, ref, "correct-a11y");
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

    const context = await browser.newContext();
    const staffPage = await context.newPage();
    const recruiter = await activateStaff(staffPage, "correct-a11y-staff");
    await orgHarness(
      "grant",
      recruiter.email,
      "RECRUITER",
      "BRANCH",
      tree.branch,
    );
    await staffSignIn(staffPage, recruiter);
    await staffPage.goto(
      `/staff/candidates/${overview.split("/").pop()}/application`,
    );
    await expect(staffPage.getByRole("heading", { level: 1 })).toBeVisible();
    await expectNoBlockingViolations(staffPage, testInfo);
    await expectReflow(staffPage);
    await staffPage.getByRole("checkbox", { name: "Availability" }).check();
    await staffPage
      .getByLabel("Reason (the candidate sees this)")
      .selectOption("OTHER");
    await staffPage
      .getByLabel("Instructions (the candidate sees this)")
      .fill("TEST please review this section.");
    await expectNoBlockingViolations(staffPage, testInfo);
    await staffPage
      .getByRole("button", { name: "Return for correction" })
      .focus();
    await staffPage.keyboard.press("Enter");
    const confirm = staffPage.getByRole("button", { name: "Confirm return" });
    await expect(confirm).toBeFocused();
    await expectNoBlockingViolations(staffPage, testInfo);
    await staffPage.keyboard.press("Enter");
    await expect(staffPage.getByRole("main").getByRole("status")).toBeVisible();
    await context.close();

    await page.goto(overview);
    await expect(
      page.getByRole("button", { name: "Start your correction" }),
    ).toBeVisible();
    await expectNoBlockingViolations(page, testInfo);
    await expectReflow(page);
    await page.getByRole("button", { name: "Start your correction" }).click();
    await expect(
      page.getByRole("link", { name: "Availability" }),
    ).toBeVisible();
    await expectNoBlockingViolations(page, testInfo);
    await page.goto(`${overview}/availability`);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expectNoBlockingViolations(page, testInfo);
    await expectReflow(page);
  });
});

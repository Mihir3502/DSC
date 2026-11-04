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

// M3.2 accessibility (packet M3.2 §12; WCAG 2.2 AA): axe on Overview and
// Application, one level-one heading, tabs as labelled links with a marked
// current page, and reflow at 320 CSS px.

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

test.describe("candidate workspace accessibility", () => {
  test("Overview and Application are accessible and reflow", async ({
    page,
    browser,
  }, testInfo) => {
    test.setTimeout(180_000);
    const id = randomBytes(3).toString("hex").toUpperCase();
    const tree = await orgHarness<Tree>("provision", id);
    const ref = await openCycle(tree, id, `TEST A11y Workspace ${id}`);
    await useDistinctClient(page);
    const overview = await startDraft(page, ref, "ws-a11y");
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
    const workspace = `/staff/candidates/${overview.split("/").pop()!}`;

    const context = await browser.newContext({ reducedMotion: "reduce" });
    const staff = await context.newPage();
    const recruiter = await activateStaff(staff, "ws-a11y-recruiter");
    await orgHarness(
      "grant",
      recruiter.email,
      "RECRUITER",
      "BRANCH",
      tree.branch,
    );
    await staffSignIn(staff, recruiter);

    for (const path of [workspace, `${workspace}/application`]) {
      await staff.goto(path);
      await expect(staff.getByRole("heading", { level: 1 })).toHaveCount(1);
      await expect(
        staff
          .getByRole("navigation", { name: "Candidate workspace" })
          .locator('[aria-current="page"]'),
      ).toHaveCount(1);
      await expectNoBlockingViolations(staff, testInfo);
    }

    await staff.setViewportSize({ width: 320, height: 640 });
    for (const path of [workspace, `${workspace}/application`]) {
      await staff.goto(path);
      await expect(staff.getByRole("main")).toBeVisible();
      const overflowing = await staff.evaluate(
        () =>
          document.documentElement.scrollWidth >
          document.documentElement.clientWidth,
      );
      expect(overflowing, `no sideways scrolling at ${path}`).toBe(false);
    }
    await context.close();
  });
});

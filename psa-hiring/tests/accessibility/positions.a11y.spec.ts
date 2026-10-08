import AxeBuilder from "@axe-core/playwright";
import { randomBytes } from "node:crypto";
import type { Page, TestInfo } from "@playwright/test";
import { expect, tabToLink, test } from "../e2e/support/fixtures";
import { orgHarness, type Tree } from "../e2e/support/organization";
import { activateStaff, staffSignIn } from "../e2e/support/staff-auth";

// M2.1 accessibility (packet M2.1 §16, AC-M2.1-14; WCAG 2.2 AA): axe on the
// public list/detail/handoff and staff position screens (including an
// open confirmation dialog), keyboard reachability, focus return, and
// reflow at 320 CSS px (equivalent to 400% zoom of 1280 px, which also
// covers the 200% requirement) without horizontal scrolling.

test.use({ trace: "off", screenshot: "off", video: "off" });

async function expectNoBlockingViolations(page: Page, testInfo: TestInfo) {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
  await testInfo.attach("axe-violation-ids", {
    body: results.violations
      .map(
        (v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`,
      )
      .join("\n"),
    contentType: "text/plain",
  });
  expect(
    results.violations
      .filter((v) => v.impact === "serious" || v.impact === "critical")
      .map((v) => `${v.impact} ${v.id} (${v.nodes.length} node(s))`),
    "serious/critical axe violations",
  ).toEqual([]);
}

async function expectReflow(page: Page) {
  await page.setViewportSize({ width: 320, height: 800 });
  const overflow = await page.evaluate(
    () =>
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth,
  );
  expect(overflow, "horizontal scrolling at 320 CSS px").toBeLessThanOrEqual(1);
  await page.setViewportSize({ width: 1280, height: 800 });
}

const id = () => randomBytes(3).toString("hex").toUpperCase();

test.describe("positions accessibility @critical", () => {
  test("public list, detail, and start-application pages are accessible, keyboard operable, and reflow @critical", async ({
    page,
  }, testInfo) => {
    const suffix = id();
    const tree = await orgHarness<Tree>("provision", suffix);
    const { position } = await orgHarness<{ position: string }>(
      "position",
      tree.org,
      `A11Y-${suffix}`,
      `TEST Accessible Caregiver ${suffix}`,
    );
    const { ref } = await orgHarness<{ ref: string }>(
      "cycle",
      position,
      tree.branch,
      "open",
      "10080",
    );

    await page.goto("/positions");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      "Open positions",
    );
    await expectNoBlockingViolations(page, testInfo);
    await expectReflow(page);
    const link = await tabToLink(
      page,
      `TEST Accessible Caregiver ${suffix}`,
      40,
    );
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(`/positions/${ref}`);
    await expect(link).toHaveCount(0);
    await expectNoBlockingViolations(page, testInfo);
    await expectReflow(page);

    await page.goto(`/apply/${ref}`);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      "Start your application",
    );
    await expectNoBlockingViolations(page, testInfo);
    await expectReflow(page);

    await page.goto("/positions?type=NOT_A_TYPE");
    await expect(page.getByRole("status")).toContainText("can’t be used");
    await expectNoBlockingViolations(page, testInfo);
  });

  test("staff position screens and confirmation dialogs are accessible and return focus @critical", async ({
    page,
  }, testInfo) => {
    const suffix = id();
    const tree = await orgHarness<Tree>("provision", suffix);
    const { position } = await orgHarness<{ position: string }>(
      "position",
      tree.org,
      `A11YS-${suffix}`,
      `TEST Staff A11y ${suffix}`,
    );
    const { cycle } = await orgHarness<{ cycle: string }>(
      "cycle",
      position,
      tree.branch,
      "draft",
      "10080",
    );
    const staff = await activateStaff(page, "a11y-manager");
    await orgHarness(
      "grant",
      staff.email,
      "PSA_MANAGER",
      "ORGANIZATION",
      tree.org,
    );
    await staffSignIn(page, staff);

    for (const path of [
      "/staff/admin/positions",
      "/staff/admin/positions/new",
      `/staff/admin/positions/${position}`,
      `/staff/admin/positions/${position}/cycles/new`,
      `/staff/admin/positions/${position}/cycles/${cycle}`,
      "/staff/admin/positions/hierarchy",
    ]) {
      await page.goto(path);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await expectNoBlockingViolations(page, testInfo);
      await expectReflow(page);
    }

    // The publish dialog: labelled, described, keyboard closable, focus returns.
    await page.goto(`/staff/admin/positions/${position}/cycles/${cycle}`);
    const opener = page.getByRole("button", {
      name: "Publish cycle",
      exact: true,
    });
    await opener.focus();
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog", {
      name: "Publish this hiring cycle?",
    });
    await expect(dialog).toBeVisible();
    await expectNoBlockingViolations(page, testInfo);
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(opener).toBeFocused();
  });
});

import AxeBuilder from "@axe-core/playwright";
import { randomBytes } from "node:crypto";
import type { Page, TestInfo } from "@playwright/test";
import {
  PASSWORD,
  readyCandidate,
  useDistinctClient,
} from "../e2e/support/candidate-auth";
import { expect, test } from "../e2e/support/fixtures";
import { orgHarness, type Tree } from "../e2e/support/organization";
import { activateStaff, staffSignIn } from "../e2e/support/staff-auth";

// M2.2 accessibility (packet M2.2 §18, AC-M2.2-12; WCAG 2.2 AA): axe on the
// candidate start form and its validation state, the staff prospect form
// with an error summary, the prospect detail, and an open confirmation
// dialog; focus moves to the error summary and returns to the opener; all
// screens reflow at 320 CSS px without horizontal scrolling.

test.use({ trace: "off", screenshot: "off", video: "off" });

async function expectNoBlockingViolations(page: Page, testInfo: TestInfo) {
  // Next streams metadata, so a title can land just after navigation; a page
  // with no title at all still fails here.
  await expect(page).toHaveTitle(/\S/);
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

async function openCycle(tree: Tree, suffix: string, title: string) {
  const { position } = await orgHarness<{ position: string }>(
    "position",
    tree.org,
    `A11Y-${suffix}`,
    title,
  );
  return (
    await orgHarness<{ ref: string }>(
      "cycle",
      position,
      tree.branch,
      "open",
      "10080",
    )
  ).ref;
}

test.describe("person and candidacy accessibility @critical", () => {
  test("the candidate start form and its error state are accessible and reflow @critical", async ({
    page,
  }, testInfo) => {
    const suffix = id();
    const tree = await orgHarness<Tree>("provision", suffix);
    const ref = await openCycle(tree, suffix, `TEST A11y Start ${suffix}`);
    await useDistinctClient(page);
    const email = await readyCandidate(page, "a11y-start");
    await page.goto(`/apply/${ref}`);
    await page.getByRole("button", { name: /Continue/ }).click();
    await page.waitForURL(
      /\/sign-in\?next=APPLICATION_START|\/candidate\/applications\/new/,
    );
    if (page.url().includes("/sign-in")) {
      await page.getByLabel("Email address").fill(email);
      await page.getByLabel("Password").fill(PASSWORD);
      await page.getByRole("button", { name: "Sign in" }).click();
    }
    await expect(page).toHaveURL("/candidate/applications/new");
    await expectNoBlockingViolations(page, testInfo);
    await expectReflow(page);
    await page.getByLabel("Legal first name").fill("<b>TEST</b>");
    await page.getByRole("button", { name: "Start application" }).click();
    const summary = page.getByRole("main").getByRole("alert");
    await expect(summary).toBeFocused();
    await expect(page.getByLabel("Legal first name")).toHaveAttribute(
      "aria-invalid",
      "true",
    );
    await expectNoBlockingViolations(page, testInfo);
  });

  test("staff prospect form, detail, and confirmation dialog are accessible and keyboard operable @critical", async ({
    page,
  }, testInfo) => {
    const suffix = id();
    const tree = await orgHarness<Tree>("provision", suffix);
    const title = `TEST A11y Prospect ${suffix}`;
    await openCycle(tree, suffix, title);
    const staff = await activateStaff(page, "a11y-prospect");
    await orgHarness("grant", staff.email, "RECRUITER", "BRANCH", tree.branch);
    await staffSignIn(page, staff);

    await page.goto("/staff/candidates/new");
    await expectNoBlockingViolations(page, testInfo);
    await expectReflow(page);
    await page.getByRole("button", { name: "Create prospect" }).click();
    await expect(page.getByRole("main").getByRole("alert")).toBeFocused();
    await expectNoBlockingViolations(page, testInfo);

    await page.getByLabel("Legal first name").fill("TEST José");
    await page.getByLabel("Legal last name").fill("Nguyễn");
    await page
      .getByLabel("Email")
      .fill(`test.a11y.${suffix.toLowerCase()}@example.test`);
    await page.getByRole("button", { name: "Create prospect" }).click();
    await expect(page).toHaveURL(
      /\/staff\/candidates\/[0-9a-hjkmnp-tv-z]{12}$/,
    );
    await expectNoBlockingViolations(page, testInfo);
    await expectReflow(page);

    const opener = page.getByRole("button", {
      name: "Close prospect",
      exact: true,
    });
    await opener.focus();
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expectNoBlockingViolations(page, testInfo);
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(opener).toBeFocused();
  });
});

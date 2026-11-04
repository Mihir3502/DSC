import AxeBuilder from "@axe-core/playwright";
import { randomBytes } from "node:crypto";
import type { Page, TestInfo } from "@playwright/test";
import { openCycle, startDraft } from "../e2e/support/application-draft";
import { useDistinctClient } from "../e2e/support/candidate-auth";
import { acceptExpectedRefusals, expect, test } from "../e2e/support/fixtures";
import { orgHarness, type Tree } from "../e2e/support/organization";

// M2.5 accessibility (packet M2.5 §12; WCAG 2.2 AA): axe on the empty page, a
// refusal, and a listed file; focus on the refusal; 320 px reflow; 44 px targets.

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

test.describe("application attachments accessibility @critical", () => {
  test("the attachments page is accessible, keyboard operable, and reflows @critical", async ({
    page,
    guards,
  }, testInfo) => {
    test.setTimeout(90_000);
    const id = randomBytes(3).toString("hex").toUpperCase();
    const tree = await orgHarness<Tree>("provision", id);
    const ref = await openCycle(tree, id, `TEST A11y Attach ${id}`);
    await useDistinctClient(page);
    const overview = await startDraft(page, ref, "attach-a11y");
    await page.getByRole("button", { name: "Begin application" }).click();
    await expect(page.getByRole("link", { name: "Attachments" })).toBeVisible();
    await page.goto(`${overview}/attachments`);
    await expectNoBlockingViolations(page, testInfo);
    await expectReflow(page);

    const file = page.getByLabel("Choose a file");
    await file.setInputFiles({
      name: "TEST macro.docx",
      mimeType: "application/msword",
      buffer: Buffer.from("x"),
    });
    await page.getByRole("button", { name: "Upload file" }).focus();
    await page.keyboard.press("Enter");
    const alert = page.getByRole("main").getByRole("alert");
    await expect(alert).toBeFocused();
    await expectNoBlockingViolations(page, testInfo);

    await file.setInputFiles({
      name: `TEST ${"very long file name ".repeat(4)}.pdf`,
      mimeType: "application/pdf",
      buffer: Buffer.from("%PDF-1.7\nTEST\n"),
    });
    await page.getByRole("button", { name: "Upload file" }).click();
    await expect(page.getByRole("main").getByRole("status")).toContainText(
      "is ready",
    );
    await expectNoBlockingViolations(page, testInfo);
    await expectReflow(page);
    const replace = page.getByRole("button", { name: /Replace/ });
    expect((await replace.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await page.getByRole("button", { name: /Remove/ }).focus();
    await page.keyboard.press("Enter");
    await expect(
      page.getByRole("button", { name: "Confirm removal" }),
    ).toBeFocused();
    await expectNoBlockingViolations(page, testInfo);
    acceptExpectedRefusals(guards, [422]);
  });
});

import { randomBytes } from "node:crypto";
import {
  completeRequiredSections,
  openCycle,
  startDraftWithEmail,
} from "./support/application-draft";
import { useDistinctClient } from "./support/candidate-auth";
import { expect, test } from "./support/fixtures";
import { orgHarness, type Tree } from "./support/organization";
import { activateStaff, staffSignIn } from "./support/staff-auth";

// M3.2 journey (packet M3.2 §14-§18). A recruiter goes from the queue to the
// workspace and between its tabs; a compliance reviewer gets the same shell
// without contact details; an administrator gets nothing. Synthetic data only.

test.use({ trace: "off", screenshot: "off", video: "off" });

test.describe("candidate workspace @critical", () => {
  test("staff open the workspace from the queue, and each role sees only its own view @critical", async ({
    page,
    browser,
  }) => {
    test.setTimeout(180_000);
    const id = randomBytes(3).toString("hex").toUpperCase();
    const tree = await orgHarness<Tree>("provision", id);
    const ref = await openCycle(tree, id, `TEST Workspace Caregiver ${id}`);
    await useDistinctClient(page);
    const { overview } = await startDraftWithEmail(page, ref, "ws");
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
    const workspace = `/staff/candidates/${candidacy}`;

    const recruiterContext = await browser.newContext();
    const recruiterPage = await recruiterContext.newPage();
    const recruiter = await activateStaff(recruiterPage, "ws-recruiter");
    await orgHarness(
      "grant",
      recruiter.email,
      "RECRUITER",
      "BRANCH",
      tree.branch,
    );
    await staffSignIn(recruiterPage, recruiter);
    await recruiterPage.goto("/staff/work?stage=APPLICATION_SUBMITTED");
    await recruiterPage
      .locator("li", { hasText: "Review the submitted" })
      .first()
      .getByRole("link")
      .first()
      .click();
    await expect(recruiterPage).toHaveURL(workspace);
    const response = await recruiterPage.goto(workspace);
    expect(response!.headers()["cache-control"]).toContain("no-store");

    const main = recruiterPage.getByRole("main");
    const tabs = recruiterPage.getByRole("navigation", {
      name: "Candidate workspace",
    });
    await expect(
      recruiterPage.getByRole("heading", { level: 1 }),
    ).toBeVisible();
    await expect(main).toContainText("Review the submitted application");
    await expect(main).toContainText("Nobody owns this record");
    await expect(main).toContainText("Application submitted");
    await expect(tabs.getByRole("link")).toHaveText([
      "Overview",
      "Application",
    ]);
    await expect(tabs.getByRole("link", { name: "Overview" })).toHaveAttribute(
      "aria-current",
      "page",
    );

    // Tabs work by keyboard, keep the header, and move the current marker.
    const heading = await recruiterPage
      .getByRole("heading", { level: 1 })
      .textContent();
    await tabs.getByRole("link", { name: "Application" }).focus();
    await recruiterPage.keyboard.press("Enter");
    await expect(recruiterPage).toHaveURL(`${workspace}/application`);
    await expect(recruiterPage.getByRole("heading", { level: 1 })).toHaveText(
      heading!,
    );
    await expect(
      tabs.getByRole("link", { name: "Application" }),
    ).toHaveAttribute("aria-current", "page");
    await expect(
      recruiterPage.getByRole("heading", { name: "Submitted application" }),
    ).toBeVisible();
    await recruiterContext.close();

    // A compliance reviewer gets the shell, without contact details.
    const reviewerContext = await browser.newContext();
    const reviewerPage = await reviewerContext.newPage();
    const reviewer = await activateStaff(reviewerPage, "ws-compliance");
    await orgHarness(
      "grant",
      reviewer.email,
      "COMPLIANCE_REVIEWER",
      "ORGANIZATION",
      tree.org,
    );
    await staffSignIn(reviewerPage, reviewer);
    await reviewerPage.goto(workspace);
    const reviewerMain = reviewerPage.getByRole("main");
    await expect(reviewerMain).toContainText("Nobody owns this record");
    await expect(reviewerMain).not.toContainText("Email");
    await expect(reviewerMain).not.toContainText("Manage owner and due date");
    await reviewerContext.close();

    // An administrator gets the same not-found as a record that doesn't exist.
    const adminContext = await browser.newContext();
    const adminPage = await adminContext.newPage();
    const administrator = await activateStaff(adminPage, "ws-admin");
    await orgHarness(
      "grant",
      administrator.email,
      "SYSTEM_ADMINISTRATOR",
      "ORGANIZATION",
      tree.org,
    );
    await staffSignIn(adminPage, administrator);
    expect((await adminPage.goto(workspace))!.status()).toBe(404);
    expect(
      (await adminPage.goto("/staff/candidates/0123456789ab"))!.status(),
    ).toBe(404);
    await adminContext.close();
  });
});

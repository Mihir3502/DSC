import { randomBytes } from "node:crypto";
import {
  completeRequiredSections,
  openCycle,
  startDraftWithEmail,
} from "./support/application-draft";
import { useDistinctClient, waitForEmail } from "./support/candidate-auth";
import { expect, test } from "./support/fixtures";
import { orgHarness, type Tree } from "./support/organization";
import { activateStaff, staffSignIn } from "./support/staff-auth";

// M2.6 submission journey (packet M2.6 §15, §18; AC-M2.6-01..06). A candidate
// sees what's missing, completes the application, certifies, confirms, gets a
// receipt and an email, and can't change it; a recruiter sees the queue item.
// Synthetic data only.

test.use({ trace: "off", screenshot: "off", video: "off" });

test.describe("application submission @critical", () => {
  test("a candidate reviews, certifies, submits, and gets a receipt, and a recruiter sees the queue item @critical", async ({
    page,
    browser,
  }) => {
    test.setTimeout(150_000);
    const id = randomBytes(3).toString("hex").toUpperCase();
    const tree = await orgHarness<Tree>("provision", id);
    const title = `TEST Submit Caregiver ${id}`;
    const ref = await openCycle(tree, id, title);
    await useDistinctClient(page);
    const { overview, email } = await startDraftWithEmail(page, ref, "submit");
    await page.getByRole("button", { name: "Begin application" }).click();
    const main = page.getByRole("main");
    await page.getByRole("link", { name: "Review and submit" }).click();
    await expect(page).toHaveURL(`${overview}/review`);

    // An incomplete application names what's missing and can't be submitted.
    await expect(main).toContainText("Still needed:");
    await expect(main).toContainText("Which days can you work?");
    await expect(
      page.getByRole("button", { name: "Submit application" }),
    ).toBeHidden();

    await completeRequiredSections(page, overview);
    await page.goto(`${overview}/review`);
    await expect(main).not.toContainText("Still needed:");
    await expect(main).toContainText("TEST Supervisor");
    await expect(main).toContainText("No files will be included.");

    const submitButton = page.getByRole("button", {
      name: "Submit application",
    });
    await expect(submitButton).toBeDisabled();
    await page.getByLabel("I certify the statement above.").check();
    await page.getByLabel("Type your full name").fill("TEST Ada Example");
    await submitButton.click();
    await expect(
      page.getByRole("button", { name: "Confirm and submit" }),
    ).toBeFocused();
    await expect(main).toContainText("It will be frozen");
    await page.getByRole("button", { name: "Keep editing" }).click();
    await submitButton.click();
    await page.getByRole("button", { name: "Confirm and submit" }).click();

    await expect(page).toHaveURL(`${overview}/submitted`);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      "We received your application",
    );
    await expect(main).toContainText(/R-[0-9A-HJKMNP-TV-Z]{8}/);
    await expect(main).toContainText("TEST Ada Example");

    const message = await waitForEmail(email, "APPLICATION_RECEIVED");
    expect(message.text).toMatch(/C-[0-9A-HJKMNP-TV-Z]{8}/);
    expect(message.text).not.toContain("TEST Ada");
    expect(message.text).not.toContain("TEST Supervisor");

    // Home has nothing left to do, and the application is read-only.
    await page.goto("/candidate");
    await expect(main).toContainText("Application submitted");
    await expect(main).toContainText("nothing you need to do");
    await page.goto("/candidate/tasks?filter=under_review");
    await expect(main).toContainText("Status: Submitted");
    await page.goto(overview);
    await expect(main).toContainText("can't be changed");
    await expect(
      page.getByRole("link", { name: "Review and submit" }),
    ).toBeHidden();

    const context = await browser.newContext();
    const staffPage = await context.newPage();
    const recruiter = await activateStaff(staffPage, "submit-recruiter");
    await orgHarness(
      "grant",
      recruiter.email,
      "RECRUITER",
      "BRANCH",
      tree.branch,
    );
    await staffSignIn(staffPage, recruiter);
    const response = await staffPage.goto("/staff/candidates/submitted");
    expect(response!.headers()["cache-control"]).toContain("no-store");
    await expect(staffPage.getByRole("main")).toContainText(title);
    await expect(staffPage.getByRole("main")).not.toContainText("TEST Ada");
    await context.close();
  });
});

import { randomBytes } from "node:crypto";
import {
  completeRequiredSections,
  openCycle,
  startDraftWithEmail,
} from "./support/application-draft";
import { useDistinctClient, waitForEmail } from "./support/candidate-auth";
import { acceptExpectedNotFound, expect, test } from "./support/fixtures";
import { orgHarness, type Tree } from "./support/organization";
import { activateStaff, staffSignIn } from "./support/staff-auth";

// M2.7 correction journey (packet M2.7 §15, §18; AC-M2.7-01..05). A recruiter
// returns a section with instructions; the candidate is emailed, sees them,
// corrects only that section, and resubmits; the recruiter sees the new version
// and the earlier return. Synthetic data only.

test.use({ trace: "off", screenshot: "off", video: "off" });

const INSTRUCTIONS = "TEST please use your new start date.";

test.describe("application correction @critical", () => {
  test("a recruiter returns a section, and the candidate corrects and resubmits it @critical", async ({
    page,
    browser,
    browserName,
    guards,
  }) => {
    test.setTimeout(180_000);
    const id = randomBytes(3).toString("hex").toUpperCase();
    const tree = await orgHarness<Tree>("provision", id);
    const ref = await openCycle(tree, id, `TEST Correct Caregiver ${id}`);
    await useDistinctClient(page);
    const { overview, email } = await startDraftWithEmail(page, ref, "correct");
    await page.getByRole("button", { name: "Begin application" }).click();
    await expect(
      page.getByRole("link", { name: "Review and submit" }),
    ).toBeVisible();
    await completeRequiredSections(page, overview);
    const certify = async (name: string) => {
      await page.goto(`${overview}/review`);
      await page.getByLabel("I certify the statement above.").check();
      await page.getByLabel("Type your full name").fill(name);
      await page.getByRole("button", { name: "Submit application" }).click();
      await page.getByRole("button", { name: "Confirm and submit" }).click();
      await expect(page).toHaveURL(`${overview}/submitted`);
    };
    await certify("TEST Ada Example");
    const candidacy = overview.split("/").pop()!;

    const context = await browser.newContext();
    const staffPage = await context.newPage();
    const recruiter = await activateStaff(staffPage, "correct-recruiter");
    await orgHarness(
      "grant",
      recruiter.email,
      "RECRUITER",
      "BRANCH",
      tree.branch,
    );
    await staffSignIn(staffPage, recruiter);
    await staffPage.goto("/staff/candidates/submitted");
    await expect(staffPage.getByRole("main")).toContainText("TEST Correct");
    await staffPage.goto(`/staff/candidates/${candidacy}/application`);
    const staffMain = staffPage.getByRole("main");
    await expect(staffMain).toContainText("TEST Supervisor");
    const send = staffPage.getByRole("button", {
      name: "Return for correction",
    });
    await expect(send).toBeDisabled();
    await staffPage.getByRole("checkbox", { name: "Availability" }).check();
    await staffPage
      .getByRole("checkbox", { name: /earliest date you could start/ })
      .check();
    await staffPage
      .getByLabel("Reason (the candidate sees this)")
      .selectOption("INCORRECT_INFORMATION");
    await staffPage
      .getByLabel("Instructions (the candidate sees this)")
      .fill(INSTRUCTIONS);
    await send.click();
    await expect(
      staffPage.getByRole("button", { name: "Confirm return" }),
    ).toBeFocused();
    await staffPage.getByRole("button", { name: "Confirm return" }).click();
    await expect(staffMain.getByRole("status")).toContainText(
      "Application returned",
    );

    const message = await waitForEmail(email, "APPLICATION_RETURNED");
    expect(message.text).not.toContain(INSTRUCTIONS);

    const main = page.getByRole("main");
    await page.goto("/candidate");
    await expect(main).toContainText("Correct your application");
    await page.getByRole("link", { name: "See what to correct" }).click();
    await expect(page).toHaveURL(overview);
    await expect(main).toContainText(INSTRUCTIONS);
    await page.getByRole("button", { name: "Start your correction" }).click();
    await expect(
      page.getByRole("link", { name: "Availability" }),
    ).toBeVisible();
    await expect(page.getByRole("link", { name: "References" })).toBeHidden();

    const closed = await page.goto(`${overview}/references`);
    expect(closed!.status()).toBe(404);
    await page.goto(`${overview}/availability`);
    await expect(main).toContainText("We asked you to check this answer.");
    await expect(page.getByLabel(/earliest date you could start/)).toHaveValue(
      "2026-12-01",
    );
    await page.getByLabel(/earliest date you could start/).fill("2027-01-15");
    await page.getByRole("button", { name: "Save draft" }).click();
    await expect(main.getByRole("status")).toContainText("All changes saved");

    await certify("TEST Ada Example");
    await waitForEmail(email, "APPLICATION_RECEIVED", 2);

    await staffPage.goto(`/staff/candidates/${candidacy}/application`);
    await expect(staffMain).toContainText("2027-01-15");
    await expect(staffMain).toContainText("Earlier returns");
    await expect(staffMain).toContainText(INSTRUCTIONS);
    await context.close();
    acceptExpectedNotFound(guards, browserName === "firefox" ? 0 : 1);
  });
});

import { randomBytes } from "node:crypto";
import type { Browser, Page } from "@playwright/test";
import {
  completeRequiredSections,
  openCycle,
  startDraftWithEmail,
} from "./support/application-draft";
import { useDistinctClient as giveDistinctClient } from "./support/candidate-auth";
import { expect, test } from "./support/fixtures";
import { orgHarness, type Tree } from "./support/organization";
import { activateStaff, staffSignIn } from "./support/staff-auth";

// M3.3 journey (packet M3.3 §14-§18). A recruiter accepts and answers a prescreen,
// HR places and removes a hold, and the recruiter passes one application and marks
// another not selected. The candidate sees only generic status, with no reason or
// note. Synthetic data only.

test.use({ trace: "off", screenshot: "off", video: "off" });

const NOTE = "TEST internal prescreen note";
const REASON = "TEST internal hold reason";

async function submittedApplication(page: Page, ref: string, label: string) {
  await giveDistinctClient(page);
  const { overview } = await startDraftWithEmail(page, ref, label);
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
  return overview.split("/").pop()!;
}

async function staffPage(
  browser: Browser,
  label: string,
  role: string,
  scopeType: string,
  scope: string,
) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await giveDistinctClient(page);
  const member = await activateStaff(page, label);
  await orgHarness("grant", member.email, role, scopeType, scope);
  await staffSignIn(page, member);
  return page;
}

async function confirm(page: Page, label: string, reason?: string) {
  await page.getByRole("button", { name: label, exact: true }).click();
  const dialog = page.getByRole("dialog");
  if (reason)
    await dialog
      .getByLabel("Reason", { exact: true })
      .selectOption({ label: reason });
  return dialog;
}

async function answerAll(page: Page, value: "Met" | "Not met") {
  const main = page.getByRole("main");
  const groups = main.getByRole("group");
  await expect(groups).toHaveCount(4);
  for (let i = 0; i < 4; i += 1) {
    await groups.nth(i).getByLabel(value, { exact: true }).check();
  }
  await main.getByLabel(/Internal notes/).fill(NOTE);
  await main.getByRole("button", { name: "Save answers" }).click();
  await expect(main.getByText("Answers saved.")).toBeVisible();
}

test.describe("application prescreen @critical", () => {
  test("staff accept, hold, and decide a prescreen, and the candidate sees only generic status @critical", async ({
    page,
    browser,
  }) => {
    test.setTimeout(300_000);
    const id = randomBytes(3).toString("hex").toUpperCase();
    const tree = await orgHarness<Tree>("provision", id);
    const ref = await openCycle(tree, id, `TEST Prescreen Caregiver ${id}`);
    const candidacy = await submittedApplication(page, ref, "pre-pass");
    const prescreen = `/staff/candidates/${candidacy}/recruiting/prescreen`;

    const recruiter = await staffPage(
      browser,
      "pre-recruiter",
      "RECRUITER",
      "BRANCH",
      tree.branch,
    );
    await recruiter.goto(`/staff/candidates/${candidacy}`);
    const tabs = recruiter.getByRole("navigation", {
      name: "Candidate workspace",
    });
    await tabs.getByRole("link", { name: "Prescreen" }).click();
    await expect(recruiter).toHaveURL(prescreen);
    const main = recruiter.getByRole("main");
    const accept = await confirm(recruiter, "Accept for prescreen");
    await accept
      .getByRole("button", { name: "Confirm: Accept for prescreen" })
      .click();
    await expect(main).toContainText("In progress");
    await expect(main).toContainText("draft awaiting business review");

    // The candidate sees that it's under review, and nothing else.
    await page.goto("/candidate");
    await expect(page.getByRole("main")).toContainText(
      "Application under review",
    );

    await answerAll(recruiter, "Met");
    await expect(main.getByRole("button", { name: "Pass" })).toBeVisible();
    await expect(
      main.getByRole("button", { name: "Place on hold" }),
    ).toHaveCount(0);

    // HR holds it, which blocks the recruiter's decision until it's removed.
    const hr = await staffPage(
      browser,
      "pre-hr",
      "HR_SPECIALIST",
      "ORGANIZATION",
      tree.org,
    );
    await hr.goto(prescreen);
    const hold = await confirm(hr, "Place on hold", "Internal review");
    await hold.getByLabel(/Internal reason/).fill(REASON);
    await hold
      .getByLabel(/Review by/)
      .fill(new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10));
    await hold.getByRole("button", { name: "Confirm: Place on hold" }).click();
    await expect(hr.getByRole("main")).toContainText(REASON);

    await recruiter.goto(prescreen);
    await expect(main).toContainText(REASON);
    await expect(main.getByRole("button", { name: "Pass" })).toHaveCount(0);
    await recruiter.goto(`/staff/candidates/${candidacy}`);
    await expect(main).toContainText("On hold: Internal review");

    const remove = await confirm(hr, "Remove hold", "Resolved");
    await remove.getByRole("button", { name: "Confirm: Remove hold" }).click();
    await expect(hr.getByRole("main")).not.toContainText(REASON);

    await recruiter.goto(prescreen);
    const passDialog = await confirm(recruiter, "Pass");
    await passDialog.getByRole("button", { name: "Confirm: Pass" }).click();
    await expect(main).toContainText("Passed");
    await recruiter.goto(`/staff/candidates/${candidacy}`);
    await expect(main).toContainText("Interview");

    await page.goto("/candidate");
    const candidateMain = page.getByRole("main");
    await expect(candidateMain).toContainText("Interview step");
    await expect(candidateMain).not.toContainText(NOTE);
    await expect(candidateMain).not.toContainText(REASON);

    // A second application is not selected: the reason stays internal.
    const otherContext = await browser.newContext();
    const other = await otherContext.newPage();
    const rejected = await submittedApplication(other, ref, "pre-reject");
    const rejectedPrescreen = `/staff/candidates/${rejected}/recruiting/prescreen`;
    await recruiter.goto(rejectedPrescreen);
    const second = await confirm(recruiter, "Accept for prescreen");
    await second
      .getByRole("button", { name: "Confirm: Accept for prescreen" })
      .click();
    await expect(main).toContainText("In progress");
    const close = await confirm(recruiter, "Not selected", "Position filled");
    await close.getByRole("button", { name: "Confirm: Not selected" }).click();
    // Wait for the recorded decision: the reason is also an option in the dialog.
    await expect(main.getByText("Decision:")).toBeVisible();
    await expect(main).toContainText("Position filled");
    await other.goto("/candidate");
    const otherMain = other.getByRole("main");
    await expect(otherMain).toContainText("Application not continuing");
    await expect(otherMain).not.toContainText("Position filled");
    await otherContext.close();

    // Someone who can't run prescreens gets a not-found page.
    const reviewer = await staffPage(
      browser,
      "pre-compliance",
      "COMPLIANCE_REVIEWER",
      "ORGANIZATION",
      tree.org,
    );
    expect((await reviewer.goto(prescreen))!.status()).toBe(404);
    await reviewer.context().close();
    await hr.context().close();
    await recruiter.context().close();
  });

  test("an unmet item needs a manager's exception before it can pass @critical", async ({
    page,
    browser,
  }) => {
    test.setTimeout(240_000);
    const id = randomBytes(3).toString("hex").toUpperCase();
    const tree = await orgHarness<Tree>("provision", id);
    const ref = await openCycle(tree, id, `TEST Exception Caregiver ${id}`);
    const candidacy = await submittedApplication(page, ref, "pre-exception");
    const prescreen = `/staff/candidates/${candidacy}/recruiting/prescreen`;

    const recruiter = await staffPage(
      browser,
      "pre-ex-recruiter",
      "RECRUITER",
      "BRANCH",
      tree.branch,
    );
    await recruiter.goto(prescreen);
    const accept = await confirm(recruiter, "Accept for prescreen");
    await accept
      .getByRole("button", { name: "Confirm: Accept for prescreen" })
      .click();
    const main = recruiter.getByRole("main");
    await expect(main).toContainText("In progress");
    await answerAll(recruiter, "Not met");
    await expect(main).toContainText("needs a PSA Manager");
    await expect(main.getByRole("button", { name: "Pass" })).toHaveCount(0);

    const manager = await staffPage(
      browser,
      "pre-ex-manager",
      "PSA_MANAGER",
      "ORGANIZATION",
      tree.org,
    );
    await manager.goto(prescreen);
    const exception = await confirm(
      manager,
      "Approve exception",
      "Equivalent experience",
    );
    await exception
      .getByRole("button", { name: "Confirm: Approve exception" })
      .click();
    // Recent sign-in comes first; this journey stops at that check.
    await expect(manager).toHaveURL(/purpose=PRESCREEN_EXCEPTION/);
    await manager.context().close();
    await recruiter.context().close();
  });
});

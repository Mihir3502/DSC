import { randomBytes } from "node:crypto";
import type { Page } from "@playwright/test";
import {
  completeRequiredSections,
  openCycle,
  startDraftWithEmail,
} from "./support/application-draft";
import {
  readyCandidate,
  signIn,
  useDistinctClient,
} from "./support/candidate-auth";
import { acceptExpectedNotFound, expect, test } from "./support/fixtures";
import { orgHarness, type Tree } from "./support/organization";
import { activateStaff, staffSignIn } from "./support/staff-auth";

// M3.1 journey (packet M3.1 §14-§18). A recruiter finds a submitted application
// in the queue, claims it, and sets a due date; a PSA Manager reassigns it; an
// administrator and a candidate get no queue. Synthetic data only.

test.use({ trace: "off", screenshot: "off", video: "off" });

async function confirm(page: Page, label: string, reason?: string) {
  await page.getByRole("button", { name: label, exact: true }).click();
  const dialog = page.getByRole("dialog");
  if (reason) await dialog.getByLabel("Reason").selectOption({ label: reason });
  return dialog;
}

test.describe("staff work queue @critical", () => {
  test("staff find, claim, date, and reassign work, and nobody else gets the queue @critical", async ({
    page,
    browser,
    browserName,
    guards,
  }) => {
    test.setTimeout(240_000);
    const id = randomBytes(3).toString("hex").toUpperCase();
    const tree = await orgHarness<Tree>("provision", id);
    const ref = await openCycle(tree, id, `TEST Queue Caregiver ${id}`);
    await useDistinctClient(page);
    const { overview } = await startDraftWithEmail(page, ref, "queue");
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

    // The candidate who owns the record still gets no staff screen.
    const own = await page.goto("/staff/work");
    expect(own!.status()).toBe(404);

    // Recruiter: find it, claim it, and set a due date.
    const recruiterContext = await browser.newContext();
    const recruiterPage = await recruiterContext.newPage();
    const recruiter = await activateStaff(recruiterPage, "queue-recruiter");
    await orgHarness(
      "grant",
      recruiter.email,
      "RECRUITER",
      "BRANCH",
      tree.branch,
    );
    await staffSignIn(recruiterPage, recruiter);
    await recruiterPage.goto("/staff");
    const staffNav = recruiterPage.getByRole("navigation", { name: "Staff" });
    await staffNav.getByRole("link", { name: "Work Queue" }).click();
    await expect(recruiterPage).toHaveURL("/staff/work");
    const response = await recruiterPage.goto("/staff/work");
    expect(response!.headers()["cache-control"]).toContain("no-store");

    await recruiterPage.getByLabel("Assignment").selectOption("UNASSIGNED");
    await recruiterPage
      .getByLabel("Stage")
      .selectOption("APPLICATION_SUBMITTED");
    await recruiterPage.getByRole("button", { name: "Apply filters" }).click();
    await expect(recruiterPage).toHaveURL(/assignment=UNASSIGNED/);
    // The URL holds codes only, never a name.
    expect(recruiterPage.url()).not.toContain("Ada");
    const row = recruiterPage.locator("li", {
      hasText: "Review the submitted",
    });
    await row.first().getByRole("link").first().click();
    await expect(recruiterPage).toHaveURL(`/staff/work/${candidacy}`);
    const main = recruiterPage.getByRole("main");
    await expect(main).toContainText("Unassigned");

    const claim = await confirm(recruiterPage, "Assign to me");
    await claim.getByRole("button", { name: "Confirm: Assign to me" }).click();
    await expect(main.getByText("Owner assigned")).toBeVisible();
    await expect(
      recruiterPage.getByRole("button", { name: "Change owner" }),
    ).toHaveCount(0);

    const date = new Date(Date.now() + 3 * 86_400_000)
      .toISOString()
      .slice(0, 10);
    const dueDialog = await confirm(recruiterPage, "Set due date");
    await dueDialog.getByLabel(/Due date/).fill(date);
    await dueDialog
      .getByRole("button", { name: "Confirm: Set due date" })
      .click();
    await expect(main.getByText("Due date set")).toBeVisible();
    await expect(main).toContainText(date);

    await recruiterPage.goto("/staff/work?assignment=MINE&due=NEXT_7");
    await expect(recruiterPage.getByRole("main")).toContainText(date);

    // A stale screen is refused rather than overwriting the newer change.
    const staleContext = await browser.newContext();
    const managerPage = await staleContext.newPage();
    const manager = await activateStaff(managerPage, "queue-manager");
    await orgHarness(
      "grant",
      manager.email,
      "PSA_MANAGER",
      "ORGANIZATION",
      tree.org,
    );
    await staffSignIn(managerPage, manager);
    await managerPage.goto(`/staff/work/${candidacy}`);
    await recruiterPage.goto(`/staff/work/${candidacy}`);
    const release = await confirm(
      recruiterPage,
      "Remove owner",
      "Balancing workload",
    );
    await release
      .getByRole("button", { name: "Confirm: Remove owner" })
      .click();
    await expect(
      recruiterPage.getByRole("main").getByText("Owner removed"),
    ).toBeVisible();
    const stale = await confirm(
      managerPage,
      "Change owner",
      "Covering for someone away",
    );
    await stale.getByLabel("New owner").selectOption({ index: 1 });
    await stale.getByRole("button", { name: "Confirm: Change owner" }).click();
    await expect(stale.getByRole("alert")).toContainText("changed after");

    // After reloading, the manager assigns it to someone else with a reason.
    await managerPage.goto(`/staff/work/${candidacy}`);
    const assign = await confirm(
      managerPage,
      "Assign owner",
      "Covering for someone away",
    );
    await assign.getByLabel("New owner").selectOption({ index: 1 });
    await assign.getByRole("button", { name: "Confirm: Assign owner" }).click();
    await expect(
      managerPage.getByRole("listitem").filter({
        hasText: "Owner assigned (Covering for someone away)",
      }),
    ).toBeVisible();
    await staleContext.close();
    await recruiterContext.close();

    // An administrator has no queue and no record.
    const adminContext = await browser.newContext();
    const adminPage = await adminContext.newPage();
    const administrator = await activateStaff(adminPage, "queue-admin");
    await orgHarness(
      "grant",
      administrator.email,
      "SYSTEM_ADMINISTRATOR",
      "ORGANIZATION",
      tree.org,
    );
    await staffSignIn(adminPage, administrator);
    await adminPage.goto("/staff");
    await expect(adminPage.getByRole("main")).toContainText(
      "doesn't include a candidate work queue",
    );
    await expect(
      adminPage.getByRole("navigation", { name: "Staff" }),
    ).toHaveCount(0);
    expect((await adminPage.goto("/staff/work"))!.status()).toBe(404);
    expect((await adminPage.goto(`/staff/work/${candidacy}`))!.status()).toBe(
      404,
    );
    await adminContext.close();

    // Another candidate gets nothing either.
    const otherContext = await browser.newContext();
    const other = await otherContext.newPage();
    await useDistinctClient(other);
    const email = await readyCandidate(other, "queue-outsider");
    await signIn(other, email);
    await expect(other).toHaveURL("/candidate");
    expect((await other.goto(`/staff/work/${candidacy}`))!.status()).toBe(404);
    await expect(other.getByRole("main")).not.toContainText("TEST Ada");
    await otherContext.close();

    acceptExpectedNotFound(guards, browserName === "firefox" ? 0 : 1);
  });
});

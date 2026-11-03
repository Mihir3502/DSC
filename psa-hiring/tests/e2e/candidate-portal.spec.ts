import { randomBytes } from "node:crypto";
import { openCycle, startDraft } from "./support/application-draft";
import {
  readyCandidate,
  signIn,
  useDistinctClient,
} from "./support/candidate-auth";
import { acceptExpectedNotFound, expect, test } from "./support/fixtures";
import { orgHarness, type Tree } from "./support/organization";

// M2.3 candidate portal journey (packet M2.3 §28, §31; AC-M2.3-01/04/07–12).
// Sign-in lands on the home page, the next action reaches the application,
// tasks filter on the server, and signing out leaves nothing readable by going
// back. Synthetic data only.

test.use({ trace: "off", screenshot: "off", video: "off" });

const suffix = () => randomBytes(3).toString("hex").toUpperCase();

test.describe("candidate portal @critical", () => {
  test("a returning candidate reaches their application from home, and sign-out leaves nothing behind @critical", async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const id = suffix();
    const tree = await orgHarness<Tree>("provision", id);
    const title = `TEST Portal Caregiver ${id}`;
    const ref = await openCycle(tree, id, title);
    await useDistinctClient(page);
    const overview = await startDraft(page, ref, "portal");

    const home = await page.goto("/candidate");
    expect(home!.headers()["cache-control"]).toContain("no-store");
    const main = page.getByRole("main");
    await expect(main).toContainText(title);
    await expect(main).toContainText("Application in progress");
    await expect(main).toContainText("Signed in as TEST Ada");
    await expect(main).not.toContainText(/%|Documents|Messages|Training/);
    await expect(page).toHaveTitle(/^Candidate home/);

    const portal = page.getByRole("navigation", { name: "Candidate portal" });
    await expect(portal.getByRole("link", { name: "Home" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    await expect(portal.getByRole("link")).toHaveText([
      "Home",
      "Application",
      "My Tasks",
      "Security",
      "Help",
    ]);

    await page.getByRole("link", { name: "Continue your application" }).click();
    await expect(page).toHaveURL(overview);
    await expect(
      page.getByRole("button", { name: "Begin application" }),
    ).toBeVisible();

    await portal.getByRole("link", { name: "My Tasks" }).click();
    await expect(page).toHaveURL("/candidate/tasks");
    await expect(main).toContainText("Complete your application");
    await page.getByRole("link", { name: /^Completed/ }).click();
    await expect(page).toHaveURL("/candidate/tasks?filter=completed");
    await expect(main).toContainText("You have no completed tasks.");
    await page.goto("/candidate/tasks?filter=NOT_A_FILTER");
    await expect(main).toContainText("That filter can't be used.");
    await expect(main).not.toContainText("NOT_A_FILTER");

    await portal.getByRole("link", { name: "Help" }).click();
    await expect(page).toHaveURL("/candidate/help");

    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page).toHaveURL("/sign-in");
    await page.goBack();
    await expect(page).toHaveURL(/\/sign-in/);
    await expect(page.getByRole("main")).not.toContainText(title);
  });

  test("a new candidate sees an empty home, and another candidate's reference is a safe not-found @critical", async ({
    page,
    browser,
    browserName,
    guards,
  }) => {
    test.setTimeout(90_000);
    const id = suffix();
    const tree = await orgHarness<Tree>("provision", id);
    const ref = await openCycle(tree, id, `TEST Hidden Portal ${id}`);
    const owner = await browser.newContext();
    const ownerPage = await owner.newPage();
    await useDistinctClient(ownerPage);
    const overview = await startDraft(ownerPage, ref, "portal-owner");
    const theirs = overview.split("/").pop()!;
    await owner.close();

    await useDistinctClient(page);
    const email = await readyCandidate(page, "portal-new");
    await signIn(page, email);
    await expect(page).toHaveURL("/candidate");
    const main = page.getByRole("main");
    await expect(main).toContainText("You don't have an application yet.");
    await expect(
      page.getByRole("navigation", { name: "Candidate portal" }),
    ).not.toContainText("Application");
    for (const path of [
      `/candidate?application=${theirs}`,
      "/candidate?application=abcdefghjkmn",
    ]) {
      const response = await page.goto(path);
      expect(response!.status(), path).toBe(404);
      await expect(page.getByRole("main")).not.toContainText("TEST Hidden");
    }
    acceptExpectedNotFound(guards, browserName === "firefox" ? 0 : 2);
  });
});

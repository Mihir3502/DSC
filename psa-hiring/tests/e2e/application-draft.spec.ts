import { randomBytes } from "node:crypto";
import { openCycle, startDraft } from "./support/application-draft";
import {
  readyCandidate,
  signIn,
  useDistinctClient,
} from "./support/candidate-auth";
import { acceptExpectedNotFound, expect, test } from "./support/fixtures";
import { orgHarness, type Tree } from "./support/organization";

// M2.4 application draft journey (packet M2.4 §15, §18; AC-M2.4-02/03/04/X1).
// A verified candidate begins a draft, autosaves and manually saves a section,
// sees field errors without losing input, resumes after a reload, and another
// candidate gets the same not-found as an unknown reference. Synthetic data.

test.use({ trace: "off", screenshot: "off", video: "off" });

const suffix = () => randomBytes(3).toString("hex").toUpperCase();

test.describe("application draft @critical", () => {
  test("a candidate begins a draft, autosaves, fixes an error, and resumes @critical", async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const id = suffix();
    const tree = await orgHarness<Tree>("provision", id);
    const title = `TEST Draft Caregiver ${id}`;
    const ref = await openCycle(tree, id, title);
    await useDistinctClient(page);
    const overview = await startDraft(page, ref, "draft");

    // Reading the overview starts nothing; the candidate begins explicitly.
    const response = await page.reload();
    expect(response!.headers()["cache-control"]).toContain("no-store");
    await expect(page.getByRole("main")).toContainText(title);
    await page.getByRole("button", { name: "Begin application" }).click();
    await expect(
      page.getByRole("link", { name: "Availability" }),
    ).toBeVisible();
    await expect(page.getByRole("main")).toContainText(
      "0 of 4 sections complete",
    );
    await expect(page.getByRole("main")).not.toContainText(/%/);

    // Autosave after an idle period, with a visible saved time.
    await page.getByRole("link", { name: "Availability" }).click();
    await expect(page).toHaveURL(`${overview}/availability`);
    await expect(page).toHaveTitle(/^Application section/);
    await page
      .getByLabel(/Anything else about your availability/)
      .fill("TEST evenings preferred");
    const status = page.getByRole("status");
    await expect(status).toContainText("All changes saved", {
      timeout: 15_000,
    });
    await expect(status).toContainText("UTC");
    await expect(page.getByRole("main")).toContainText(
      "Section status: In progress",
    );

    // Answers are not in the URL or browser storage.
    expect(page.url()).not.toContain("evenings");
    const stored = await page.evaluate(() =>
      JSON.stringify([{ ...localStorage }, { ...sessionStorage }]),
    );
    expect(stored).not.toContain("evenings");

    // A reload resumes the saved answer; completing it marks it Complete.
    await page.reload();
    await expect(
      page.getByLabel(/Anything else about your availability/),
    ).toHaveValue("TEST evenings preferred");
    await page.getByRole("checkbox", { name: "Monday" }).check();
    await page.getByRole("checkbox", { name: "Morning" }).check();
    await page.getByRole("radio", { name: "Part time" }).check();
    await page.getByLabel(/earliest date you could start/).fill("2026-12-01");
    await page.getByRole("button", { name: "Save draft" }).click();
    await expect(page.getByRole("main")).toContainText(
      "Section status: Complete",
    );

    // Invalid answers are reported by field and stay on the page.
    await page.goto(`${overview}/references`);
    await page.getByLabel(/Reference 1: email address/).fill("not-an-email");
    await page.getByRole("button", { name: "Save draft" }).click();
    const alert = page.getByRole("main").getByRole("alert");
    await expect(alert).toBeFocused();
    await expect(alert).toContainText("enter a valid email address");
    await expect(page.getByLabel(/Reference 1: email address/)).toHaveAttribute(
      "aria-invalid",
      "true",
    );
    await expect(page.getByLabel(/Reference 1: email address/)).toHaveValue(
      "not-an-email",
    );

    await page.goto(overview);
    await expect(page.getByRole("main")).toContainText(
      "1 of 4 sections complete",
    );
    await expect(page.getByRole("main")).toContainText(
      "Nothing has been submitted yet",
    );
  });

  test("another candidate and an unknown reference get the same safe not-found @critical", async ({
    page,
    browser,
    browserName,
    guards,
  }) => {
    test.setTimeout(90_000);
    const id = suffix();
    const tree = await orgHarness<Tree>("provision", id);
    const ref = await openCycle(tree, id, `TEST Hidden Draft ${id}`);
    await useDistinctClient(page);
    const overview = await startDraft(page, ref, "draft-owner");
    await page.getByRole("button", { name: "Begin application" }).click();
    await expect(
      page.getByRole("link", { name: "Availability" }),
    ).toBeVisible();

    const context = await browser.newContext();
    const other = await context.newPage();
    await useDistinctClient(other);
    const otherEmail = await readyCandidate(other, "draft-other");
    await signIn(other, otherEmail);
    await expect(other).toHaveURL("/candidate");
    for (const path of [
      overview,
      `${overview}/availability`,
      "/candidate/applications/abcdefghjkmn",
      "/candidate/applications/abcdefghjkmn/availability",
    ]) {
      const response = await other.goto(path);
      expect(response!.status(), path).toBe(404);
      await expect(other.getByRole("main")).not.toContainText("TEST Hidden");
    }
    await context.close();
    acceptExpectedNotFound(guards, browserName === "firefox" ? 0 : 4);
  });
});

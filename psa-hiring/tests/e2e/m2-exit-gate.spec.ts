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
  waitForEmail,
} from "./support/candidate-auth";
import { acceptExpectedNotFound, expect, test } from "./support/fixtures";
import { orgHarness, type Tree } from "./support/organization";
import { activateStaff, staffSignIn } from "./support/staff-auth";

// M2 exit gate (IMPLEMENTATION_PLAN §11): the candidate happy path and the
// returned-item path on a mobile viewport with touch, and Candidate A's routes,
// files, and APIs closed to Candidate B. Answers, instructions, the file name,
// and the signature carry a marker the runner's leakage scan fails on if it
// reaches server output, email, or audit rows.

test.use({
  trace: "off",
  screenshot: "off",
  video: "off",
  viewport: { width: 390, height: 844 },
  hasTouch: true,
  isMobile: true,
});

const marker = (name: string) =>
  `PSACANARY${name}${randomBytes(3).toString("hex").toUpperCase()}`;

async function expectNoSideways(page: Page) {
  const overflowing = await page.evaluate(
    () =>
      document.documentElement.scrollWidth >
      document.documentElement.clientWidth,
  );
  expect(overflowing, `no sideways scrolling at ${page.url()}`).toBe(false);
}

test.describe("M2 exit gate @critical", () => {
  test("on a phone, a candidate applies, attaches, submits, corrects, and resubmits, and another candidate gets nothing @critical", async ({
    page,
    browser,
    baseURL,
    browserName,
    guards,
  }) => {
    test.setTimeout(240_000);
    const id = randomBytes(3).toString("hex").toUpperCase();
    const tree = await orgHarness<Tree>("provision", id);
    const title = `TEST Exit Caregiver ${id}`;
    const ref = await openCycle(tree, id, title);
    const answer = marker("ANSWER");
    const fileName = `${marker("FILE")}.pdf`;
    const signature = `TEST ${marker("SIGNATURE")}`;
    const instructions = `TEST ${marker("INSTRUCTIONS")}`;

    await useDistinctClient(page);
    const { overview, email } = await startDraftWithEmail(page, ref, "exit");
    const main = page.getByRole("main");
    await expectNoSideways(page);
    await page.getByRole("button", { name: "Begin application" }).tap();
    await expect(
      page.getByRole("link", { name: "Review and submit" }),
    ).toBeVisible();
    await expectNoSideways(page);

    await completeRequiredSections(page, overview);
    await page.goto(`${overview}/availability`);
    await page.getByLabel(/Anything else about your availability/).fill(answer);
    await page.getByRole("button", { name: "Save draft" }).tap();
    await expect(main.getByRole("status")).toContainText("All changes saved");
    await expectNoSideways(page);

    // The attachment that Candidate B will try to reach.
    await page.goto(`${overview}/attachments`);
    await page.getByLabel("Choose a file").setInputFiles({
      name: fileName,
      mimeType: "application/pdf",
      buffer: Buffer.from(`%PDF-1.7\n${answer}\n`),
    });
    await page.getByRole("button", { name: "Upload file" }).tap();
    await expect(main.getByRole("status")).toContainText("is ready");
    await expectNoSideways(page);
    const download = (await page
      .getByRole("link", { name: /Download/ })
      .getAttribute("href"))!;

    const certify = async () => {
      await page.goto(`${overview}/review`);
      await expect(main).toContainText(fileName);
      await expectNoSideways(page);
      await page.getByLabel("I certify the statement above.").check();
      await page.getByLabel("Type your full name").fill(signature);
      await page.getByRole("button", { name: "Submit application" }).tap();
      await page.getByRole("button", { name: "Confirm and submit" }).tap();
      await expect(page).toHaveURL(`${overview}/submitted`);
      await expectNoSideways(page);
    };
    await certify();
    await expect(main).toContainText(/R-[0-9A-HJKMNP-TV-Z]{8}/);

    // The portal menu works by touch.
    await page.goto("/candidate");
    await expect(main).toContainText("Application received");
    await page.getByRole("button", { name: "Menu" }).tap();
    await page.getByRole("link", { name: "My Tasks" }).tap();
    await expect(page).toHaveURL("/candidate/tasks");
    await expectNoSideways(page);

    // Candidate B: routes, files, and APIs all answer as if nothing exists.
    const outsiderContext = await browser.newContext();
    const outsider = await outsiderContext.newPage();
    await useDistinctClient(outsider);
    const outsiderEmail = await readyCandidate(outsider, "exit-outsider");
    await signIn(outsider, outsiderEmail);
    await expect(outsider).toHaveURL("/candidate");
    for (const path of [
      overview,
      `${overview}/availability`,
      `${overview}/review`,
      `${overview}/submitted`,
      `${overview}/attachments`,
      `/candidate?application=${overview.split("/").pop()}`,
    ]) {
      const response = await outsider.goto(path);
      expect(response!.status(), path).toBe(404);
      await expect(outsider.getByRole("main")).not.toContainText(title);
    }
    expect((await outsider.request.get(download)).status()).toBe(404);
    const stolen = await outsider.request.post(
      `/api${overview}/attachments/upload`,
      {
        headers: { origin: baseURL! },
        multipart: {
          commandKey: "00000000-0000-4000-8000-000000000003",
          category: "RESUME",
          file: {
            name: "TEST.pdf",
            mimeType: "application/pdf",
            buffer: Buffer.from("%PDF-1.7\nTEST\n"),
          },
        },
      },
    );
    expect(stolen.status()).toBe(404);
    await outsiderContext.close();

    // A recruiter returns one section from a desktop browser.
    const staffContext = await browser.newContext({
      viewport: { width: 1280, height: 800 },
    });
    const staffPage = await staffContext.newPage();
    const recruiter = await activateStaff(staffPage, "exit-recruiter");
    await orgHarness(
      "grant",
      recruiter.email,
      "RECRUITER",
      "BRANCH",
      tree.branch,
    );
    await staffSignIn(staffPage, recruiter);
    await staffPage.goto(
      `/staff/candidates/${overview.split("/").pop()}/application`,
    );
    await staffPage.getByRole("checkbox", { name: "Availability" }).check();
    await staffPage
      .getByLabel("Reason (the candidate sees this)")
      .selectOption("OTHER");
    await staffPage
      .getByLabel("Instructions (the candidate sees this)")
      .fill(instructions);
    await staffPage
      .getByRole("button", { name: "Return for correction" })
      .click();
    await staffPage.getByRole("button", { name: "Confirm return" }).click();
    await expect(staffPage.getByRole("main").getByRole("status")).toContainText(
      "Application returned",
    );
    await staffContext.close();
    await waitForEmail(email, "APPLICATION_RETURNED");

    // Back on the phone: correct only what reopened, and resubmit.
    await page.goto(overview);
    await expect(main).toContainText(instructions);
    await expectNoSideways(page);
    await page.getByRole("button", { name: "Start your correction" }).tap();
    await expect(
      page.getByRole("link", { name: "Availability" }),
    ).toBeVisible();
    const locked = await page.goto(`${overview}/references`);
    expect(locked!.status()).toBe(404);
    await page.goto(`${overview}/availability`);
    await page.getByLabel(/earliest date you could start/).fill("2027-02-01");
    await page.getByRole("button", { name: "Save draft" }).tap();
    await expect(main.getByRole("status")).toContainText("All changes saved");
    await certify();
    await waitForEmail(email, "APPLICATION_RECEIVED", 2);
    acceptExpectedNotFound(guards, browserName === "firefox" ? 0 : 1);
  });
});

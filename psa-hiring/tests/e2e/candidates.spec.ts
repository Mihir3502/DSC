import { randomBytes } from "node:crypto";
import type { Browser, Page } from "@playwright/test";
import {
  PASSWORD,
  readyCandidate,
  useDistinctClient,
} from "./support/candidate-auth";
import { acceptExpectedNotFound, expect, test } from "./support/fixtures";
import { orgHarness, type Tree } from "./support/organization";
import {
  activateStaff,
  STAFF_PASSWORD,
  staffSignIn,
  type ActivatedStaff,
} from "./support/staff-auth";

// M2.2 critical browser journeys (packet M2.2 §12–§18, §31; AC-M2.2-02/
// 05/06/09/10/12): a candidate starts one application from the handoff; a
// recruiter records a prospect, sees only a generic duplicate warning, and
// must confirm to continue; a PSA manager reviews the case and merges after
// a real identity-review step-up; another organization's recruiter gets the
// same not-found as an unknown record. Synthetic data only; traces and
// screenshots are off (staff setup keys are on screen).

test.use({ trace: "off", screenshot: "off", video: "off" });

const suffix = () => randomBytes(3).toString("hex").toUpperCase();

async function staffPage(
  browser: Browser | Page,
  label: string,
  role: string,
  scopeType: string,
  scopeId: string,
): Promise<{ page: Page; staff: ActivatedStaff }> {
  const page =
    "newContext" in browser
      ? await (await browser.newContext()).newPage()
      : browser;
  const staff = await activateStaff(page, label);
  await orgHarness("grant", staff.email, role, scopeType, scopeId);
  await staffSignIn(page, staff);
  return { page, staff };
}

async function openCycle(tree: Tree, id: string, title: string) {
  const { position } = await orgHarness<{ position: string }>(
    "position",
    tree.org,
    `CAND-${id}`,
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

async function startAsCandidate(page: Page, ref: string, label: string) {
  const email = await readyCandidate(page, label);
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
  await page.getByLabel("Legal first name").fill("TEST Ada");
  await page.getByLabel("Legal last name").fill("Example");
  await page.getByRole("button", { name: "Start application" }).click();
  await expect(page).toHaveURL("/candidate/applications/new?notice=started");
  return email;
}

async function chooseOpening(page: Page, title: string) {
  const value = await page
    .getByLabel("Opening")
    .locator("option", { hasText: title })
    .getAttribute("value");
  await page.getByLabel("Opening").selectOption(value!);
}

async function confirm(page: Page, label: string, reason?: string) {
  await page.getByRole("button", { name: label, exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  if (reason) await dialog.getByLabel("Reason").selectOption({ label: reason });
  await dialog.getByRole("button", { name: `Confirm: ${label}` }).click();
}

test.describe("person and candidacy @critical", () => {
  test("a recruiter records a prospect behind a generic duplicate warning, and a PSA manager reviews and merges after a step-up @critical", async ({
    page,
    browser,
  }) => {
    const id = suffix();
    const tree = await orgHarness<Tree>("provision", id);
    const titleA = `TEST Caregiver A ${id}`;
    const titleB = `TEST Caregiver B ${id}`;
    const refA = await openCycle(tree, `A${id}`, titleA);
    await openCycle(tree, `B${id}`, titleB);
    await useDistinctClient(page);
    const email = await startAsCandidate(page, refA, "dup");

    // Recruiter: same email on another opening → one generic warning.
    const recruiter = await staffPage(
      browser,
      "cand-rec",
      "RECRUITER",
      "BRANCH",
      tree.branch,
    );
    const r = recruiter.page;
    await r.goto("/staff/candidates/new");
    await chooseOpening(r, titleB);
    await r.getByLabel("Legal first name").fill("TEST Ada");
    await r.getByLabel("Legal last name").fill("Example");
    await r.getByLabel("Email").fill(email.toUpperCase());
    await r.getByRole("button", { name: "Create prospect" }).click();
    const alert = r.getByRole("main").getByRole("alert");
    await expect(alert).toBeFocused();
    await expect(alert).toContainText("may already exist");
    // Nothing about the other record is disclosed.
    await expect(alert).not.toContainText(titleA);
    await expect(r.getByRole("main")).not.toContainText(/C-[0-9A-Z]{8}/);
    await expect(r.getByRole("main")).not.toContainText("TEST Ada Example");
    await expect(r.getByLabel("Legal first name")).toHaveValue("TEST Ada");
    // The chosen opening is preserved with the rest of the input.
    await expect(
      r.getByLabel("Opening").locator("option:checked"),
    ).toContainText(titleB);
    await r
      .getByLabel("Create this prospect even if a possible duplicate exists")
      .check();
    await r.getByRole("button", { name: "Create prospect" }).click();
    await expect(r).toHaveURL(/\/staff\/candidates\/[0-9a-hjkmnp-tv-z]{12}$/);
    const prospectUrl = new URL(r.url()).pathname;
    await expect(r.getByText("Possible duplicate:")).toBeVisible();
    await expect(r.getByRole("main")).toContainText("Prospect");
    // Recruiter has no duplicate-review authority.
    const queue = await r.goto("/staff/candidates/duplicates");
    expect(queue!.status()).toBe(404);
    await r.context().close();

    // PSA manager: identity-review step-up, confirm, then merge.
    const manager = await staffPage(
      browser,
      "cand-mgr",
      "PSA_MANAGER",
      "ORGANIZATION",
      tree.org,
    );
    const m = manager.page;
    await m.goto("/staff/candidates/duplicates");
    if (m.url().includes("/staff/reauthenticate")) {
      await expect(m).toHaveURL(
        /\/staff\/reauthenticate\?purpose=CANDIDATE_IDENTITY_REVIEW/,
      );
      await m.getByLabel("Password", { exact: true }).fill(STAFF_PASSWORD);
      await m
        .getByLabel("6-digit code from your authenticator app")
        .fill(await manager.staff.authenticator.code());
      await m.getByRole("button", { name: "Confirm it is you" }).click();
      await expect(m).toHaveURL("/staff/candidates/duplicates");
    }
    await m
      .getByRole("link", { name: /Review case/ })
      .first()
      .click();
    await expect(m).toHaveURL(
      /\/staff\/candidates\/duplicates\/[0-9a-hjkmnp-tv-z]{12}$/,
    );
    await expect(m.getByText("Same email address")).toBeVisible();
    // Contact values are masked on the review screen.
    await expect(m.getByRole("main")).not.toContainText(email);
    await confirm(m, "Confirm same person", "Same person confirmed");
    await expect(
      m.getByText("Confirmed duplicate", { exact: true }),
    ).toBeVisible();
    await confirm(m, "Merge records", "Confirmed duplicate record");
    await expect(m.getByText("Merged", { exact: true })).toBeVisible();
    // The prospect's candidacy still resolves after the merge.
    await m.goto(prospectUrl);
    await expect(m.getByRole("heading", { level: 1 })).toHaveText(
      "TEST Ada Example",
    );
    await m.context().close();
  });

  test("another organization's recruiter and unknown candidacy ids get the same safe not-found @critical", async ({
    page,
    browser,
    guards,
  }) => {
    const id = suffix();
    const tree = await orgHarness<Tree>("provision", id);
    const other = await orgHarness<Tree>("provision", `X${id}`);
    const title = `TEST Hidden Caregiver ${id}`;
    await openCycle(tree, id, title);
    const owner = await staffPage(
      browser,
      "cand-own",
      "RECRUITER",
      "BRANCH",
      tree.branch,
    );
    await owner.page.goto("/staff/candidates/new");
    await chooseOpening(owner.page, title);
    await owner.page.getByLabel("Legal first name").fill("TEST Hidden");
    await owner.page.getByLabel("Legal last name").fill("Person");
    await owner.page
      .getByLabel("Email")
      .fill(`test.hidden.${id.toLowerCase()}@example.test`);
    await owner.page.getByRole("button", { name: "Create prospect" }).click();
    await expect(owner.page).toHaveURL(
      /\/staff\/candidates\/[0-9a-hjkmnp-tv-z]{12}$/,
    );
    const prospectUrl = new URL(owner.page.url()).pathname;
    await owner.page.context().close();

    // The outsider uses the guarded page so the 404s are accounted for.
    const outsider = await staffPage(
      page,
      "cand-out",
      "RECRUITER",
      "BRANCH",
      other.branch,
    );
    const hidden = await outsider.page.goto(prospectUrl);
    const unknown = await outsider.page.goto("/staff/candidates/0123456789ab");
    expect(hidden!.status()).toBe(404);
    expect(unknown!.status()).toBe(404);
    expect(
      await outsider.page.getByRole("heading", { level: 1 }).textContent(),
    ).toBe("Page not found");
    acceptExpectedNotFound(guards, 2);
  });
});

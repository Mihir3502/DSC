import { randomBytes } from "node:crypto";
import {
  PASSWORD,
  readyCandidate,
  useDistinctClient,
} from "./support/candidate-auth";
import { acceptExpectedNotFound, expect, test } from "./support/fixtures";
import { confirmCommand, orgHarness, type Tree } from "./support/organization";
import {
  activateStaff,
  staffSignIn,
  type ActivatedStaff,
} from "./support/staff-auth";

// M2.1 critical browser journeys (packet M2.1 §16–§19, §31; AC-M2.1-09/10/
// 11/14/15). A PSA manager configures, publishes, and opens a hiring cycle
// through accessible confirmation dialogs and a real step-up; the public
// sees only the exact projection; closing removes it at once; HR cannot
// publish; another organization's manager gets the same not-found as an
// unknown record; the start-application handoff reaches the candidate
// boundary without creating any application. Synthetic data only;
// traces/screenshots are off (staff setup keys are on screen).

test.use({ trace: "off", screenshot: "off", video: "off" });

const suffix = () => randomBytes(3).toString("hex").toUpperCase();

async function staffWithRole(
  page: import("@playwright/test").Page,
  label: string,
  role: string,
  scopeType: string,
  scopeId: string,
): Promise<ActivatedStaff> {
  const staff = await activateStaff(page, label);
  // Approval ends the subject's sessions; sign in again afterwards.
  await orgHarness("grant", staff.email, role, scopeType, scopeId);
  await staffSignIn(page, staff);
  return staff;
}

test.describe("position administration and public positions @critical", () => {
  test("a PSA manager publishes and opens a hiring cycle, the public sees only the projection, and closing removes it @critical", async ({
    page,
    browser,
  }) => {
    const id = suffix();
    const tree = await orgHarness<Tree>("provision", id);
    const { position } = await orgHarness<{ position: string }>(
      "position",
      tree.org,
      `CARE-${id}`,
      `TEST Home Caregiver ${id}`,
    );
    const manager = await staffWithRole(
      page,
      "pos-manager",
      "PSA_MANAGER",
      "ORGANIZATION",
      tree.org,
    );

    // Create a draft cycle through the accessible form.
    await page.goto(`/staff/admin/positions/${position}/cycles/new`);
    await page.getByLabel("Branch and team").selectOption({ index: 0 });
    await page.getByLabel("Cycle code").fill(`SPRING-${id}`);
    await page
      .getByLabel("Internal label", { exact: true })
      .fill(`TEST internal spring ${id}`);
    const fmt = (d: Date) =>
      new Intl.DateTimeFormat("sv-SE", {
        timeZone: "America/New_York",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      })
        .format(d)
        .replace(" ", "T");
    await page
      .getByLabel("Applications open (inclusive)")
      .fill(fmt(new Date(Date.now() - 3_600_000)));
    await page
      .getByLabel("Applications close (exclusive)")
      .fill(fmt(new Date(Date.now() + 7 * 86_400_000)));
    await page
      .getByRole("button", { name: "Create draft hiring cycle" })
      .click();
    await expect(page).toHaveURL(/\/cycles\/[0-9a-f-]{36}$/);
    const cycleUrl = new URL(page.url()).pathname;
    await expect(page.getByText("Draft (not public, editable)")).toBeVisible();

    // Publish and open: specific dialogs, a reason, and a configuration step-up.
    await confirmCommand(
      page,
      manager,
      "Publish cycle",
      "Routine configuration",
      cycleUrl,
      "Published (content frozen)",
    );
    await expect(page.getByText("Published (content frozen)")).toBeVisible();
    await confirmCommand(
      page,
      manager,
      "Open cycle",
      "Routine configuration",
      cycleUrl,
      "Open (accepting applications during its window)",
    );
    await expect(
      page.getByText("Open (accepting applications during its window)"),
    ).toBeVisible();
    const reference = (await page
      .locator("dt:has-text('Public reference') + dd")
      .textContent())!.trim();

    // Anonymous visitor: exact public projection only, revalidated every request.
    const visitor = await browser.newPage();
    const listResponse = await visitor.goto("/positions");
    expect(listResponse!.headers()["cache-control"]).not.toMatch(
      /s-maxage|immutable/,
    );
    await expect(
      visitor.getByRole("link", { name: `TEST Home Caregiver ${id}` }),
    ).toBeVisible();
    const listHtml = await visitor.content();
    for (const internal of [
      `SPRING-${id}`,
      `TEST internal spring ${id}`,
      `CARE-${id}`,
      position,
      tree.org,
      tree.branch,
    ]) {
      expect(
        listHtml.includes(internal),
        "internal value on the public list",
      ).toBe(false);
    }
    await visitor
      .getByRole("link", { name: `TEST Home Caregiver ${id}` })
      .click();
    await expect(visitor).toHaveURL(`/positions/${reference}`);
    await expect(visitor).toHaveTitle(new RegExp(`TEST Home Caregiver ${id}`));
    await expect(
      visitor.getByText('Lift < 25 lb with "safe lifting" technique'),
    ).toBeVisible();
    await expect(
      visitor.getByText(/does not decide how any individual is classified/),
    ).toBeVisible();
    await expect(
      visitor.getByRole("link", { name: "Start application" }),
    ).toBeVisible();

    // Close: the public list drops it and the detail becomes generic at once.
    await confirmCommand(
      page,
      manager,
      "Close cycle",
      "Positions filled",
      cycleUrl,
      "Closed (no longer accepting)",
    );
    await expect(page.getByText("Closed (no longer accepting)")).toBeVisible();
    await visitor.goto("/positions");
    await expect(
      visitor.getByRole("link", { name: `TEST Home Caregiver ${id}` }),
    ).toHaveCount(0);
    await visitor.goto(`/positions/${reference}`);
    await expect(visitor.getByRole("heading", { level: 1 })).toHaveText(
      "This position is no longer accepting applications",
    );
    await expect(
      visitor.getByRole("link", { name: "Start application" }),
    ).toHaveCount(0);
    await visitor.close();
  });

  test("HR prepares drafts but cannot publish, and plain-text rules reject markup with preserved input @critical", async ({
    page,
  }) => {
    const id = suffix();
    const tree = await orgHarness<Tree>("provision", id);
    await staffWithRole(
      page,
      "pos-hr",
      "HR_SPECIALIST",
      "ORGANIZATION",
      tree.org,
    );
    await page.goto("/staff/admin/positions");
    await page.getByRole("link", { name: "New position" }).click();
    await expect(page).toHaveURL("/staff/admin/positions/new");
    await page.getByLabel("Position code").fill("bad code!");
    await page.getByLabel("Internal title").fill("TEST HR internal");
    await page.getByLabel("Public title").fill("TEST HR public");
    await page.getByRole("button", { name: "Create draft position" }).click();
    const summary = page.getByRole("main").getByRole("alert");
    await expect(summary).toBeFocused();
    await expect(page.getByLabel("Position code")).toHaveValue("bad code!");
    await page.getByLabel("Position code").fill(`HR-${id}`);
    await page.getByRole("button", { name: "Create draft position" }).click();
    await expect(page).toHaveURL(/\/staff\/admin\/positions\/[0-9a-f-]{36}$/);
    // HR holds edit but none of the approval actions.
    await expect(
      page.getByRole("button", { name: "Activate position" }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Retire position" }),
    ).toHaveCount(0);
    await page
      .getByLabel("Description", { exact: true })
      .fill('<img src=x onerror="alert(1)">');
    await page.getByLabel("Summary", { exact: true }).fill("TEST summary");
    await page
      .getByRole("button", { name: "Create draft description" })
      .click();
    await expect(page.getByRole("main").getByRole("alert")).toContainText(
      "plain text only",
    );
    await expect(page.getByLabel("Description", { exact: true })).toHaveValue(
      '<img src=x onerror="alert(1)">',
    );
  });

  test("another organization's manager and unknown records get the same safe not-found @critical", async ({
    page,
    guards,
  }) => {
    const id = suffix();
    const tree = await orgHarness<Tree>("provision", id);
    const other = await orgHarness<Tree>("provision", `X${id}`);
    const { position } = await orgHarness<{ position: string }>(
      "position",
      tree.org,
      `HIDE-${id}`,
      `TEST Hidden ${id}`,
    );
    await staffWithRole(
      page,
      "pos-other",
      "PSA_MANAGER",
      "ORGANIZATION",
      other.org,
    );
    const hidden = await page.goto(`/staff/admin/positions/${position}`);
    const unknown = await page.goto(
      "/staff/admin/positions/00000000-0000-4000-8000-0000000000aa",
    );
    expect(hidden!.status()).toBe(404);
    expect(unknown!.status()).toBe(404);
    expect(await page.getByRole("heading", { level: 1 }).textContent()).toBe(
      "Page not found",
    );
    acceptExpectedNotFound(guards, 2);
  });

  test("the start-application handoff continues through candidate sign-in to the M2.2 boundary without creating an application @critical", async ({
    page,
  }) => {
    await useDistinctClient(page);
    const id = suffix();
    const tree = await orgHarness<Tree>("provision", id);
    const { position } = await orgHarness<{ position: string }>(
      "position",
      tree.org,
      `HAND-${id}`,
      `TEST Handoff Caregiver ${id}`,
    );
    const { ref } = await orgHarness<{ ref: string }>(
      "cycle",
      position,
      tree.branch,
      "open",
      "10080",
    );
    const email = await readyCandidate(page, "handoff");
    await page.goto(`/positions/${ref}`);
    await page.getByRole("link", { name: "Start application" }).click();
    await expect(page).toHaveURL(`/apply/${ref}`);
    await expect(
      page.getByText(/Continuing does not submit an application/),
    ).toBeVisible();
    await page.getByRole("button", { name: "Continue to sign in" }).click();
    await page.waitForURL(
      /\/sign-in\?next=APPLICATION_START|\/candidate\/applications\/new/,
    );
    if (page.url().includes("/sign-in")) {
      // Sign in on this page so the allowlisted continuation key is kept.
      await page.getByLabel("Email address").fill(email);
      await page.getByLabel("Password").fill(PASSWORD);
      await page.getByRole("button", { name: "Sign in" }).click();
    }
    await expect(page).toHaveURL("/candidate/applications/new");
    await expect(page.getByRole("main").getByRole("status")).toContainText(
      `We have noted your interest in TEST Handoff Caregiver ${id}`,
    );
    await expect(page.getByRole("main")).toContainText(
      "No application has been started or submitted",
    );
    // The handoff cookie never appears in a URL or script-readable storage.
    expect(page.url()).not.toContain("handoff");
    expect(await page.evaluate(() => document.cookie)).not.toContain(
      "application_handoff",
    );
  });
});

import type { Page } from "@playwright/test";
import { PASSWORD, readyCandidate } from "./candidate-auth";
import { expect } from "./fixtures";
import { orgHarness, type Tree } from "./organization";

// Shared M2.4 journey steps: an open cycle, then a verified candidate who
// has started a candidacy and reached their application overview.

export async function openCycle(tree: Tree, id: string, title: string) {
  const { position } = await orgHarness<{ position: string }>(
    "position",
    tree.org,
    `DRAFT-${id}`,
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

export async function startDraft(page: Page, ref: string, label: string) {
  return (await startDraftWithEmail(page, ref, label)).overview;
}

export async function startDraftWithEmail(
  page: Page,
  ref: string,
  label: string,
) {
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
  await page.getByRole("link", { name: "Continue your application" }).click();
  await expect(page).toHaveURL(
    /\/candidate\/applications\/[0-9a-hjkmnp-tv-z]{12}$/,
  );
  return { overview: new URL(page.url()).pathname, email };
}

/** Answers every required question in the four version 1 sections. */
export async function completeRequiredSections(page: Page, overview: string) {
  await page.goto(`${overview}/availability`);
  await page.getByRole("checkbox", { name: "Monday" }).check();
  await page.getByRole("checkbox", { name: "Morning" }).check();
  await page.getByRole("radio", { name: "Part time" }).check();
  await page.getByLabel(/earliest date you could start/).fill("2026-12-01");
  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(page.getByRole("main")).toContainText(
    "Section status: Complete",
  );

  await page.goto(`${overview}/experience`);
  await page.getByRole("radio", { name: "1 to 3 years" }).check();
  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(page.getByRole("main")).toContainText(
    "Section status: Complete",
  );

  await page.goto(`${overview}/education`);
  await page
    .getByRole("radio", { name: "High school diploma or equivalent" })
    .check();
  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(page.getByRole("main")).toContainText(
    "Section status: Complete",
  );

  await page.goto(`${overview}/references`);
  await page.getByLabel(/Reference 1: full name/).fill("TEST Reference");
  await page
    .getByLabel(/Reference 1: how you know them/)
    .fill("TEST Supervisor");
  await page.getByLabel(/Reference 1: phone number/).fill("555-0100");
  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(page.getByRole("main")).toContainText(
    "Section status: Complete",
  );
}

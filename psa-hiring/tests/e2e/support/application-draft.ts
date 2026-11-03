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
  return new URL(page.url()).pathname;
}

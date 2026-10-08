import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { expect, type Page } from "@playwright/test";
import { STAFF_PASSWORD, type ActivatedStaff } from "./staff-auth";

// Browser-test helpers for M2.1 position administration. Provisioning and
// role grants go through the real commands in a separate APP_ENV=test
// harness process (organization-harness.ts); values are synthetic.

const run = promisify(execFile);
const projectRoot = process.cwd();

export async function orgHarness<T>(...args: string[]): Promise<T> {
  const { stdout } = await run(
    path.join(projectRoot, "node_modules/.bin/tsx"),
    [
      "--conditions=react-server",
      "tests/e2e/support/organization-harness.ts",
      ...args,
    ],
    { cwd: projectRoot, env: process.env, timeout: 60_000 },
  );
  return JSON.parse(stdout.trim().split("\n").at(-1)!) as T;
}

export type Tree = { org: string; branch: string; team: string };

/** Password + TOTP on the reauthentication page for the configuration purpose. */
export async function reauthenticate(page: Page, staff: ActivatedStaff) {
  await expect(page).toHaveURL(
    /\/staff\/reauthenticate\?purpose=CONFIGURATION_CHANGE/,
  );
  await page.getByLabel("Password", { exact: true }).fill(STAFF_PASSWORD);
  await page
    .getByLabel("6-digit code from your authenticator app")
    .fill(await staff.authenticator.code());
  await page.getByRole("button", { name: "Confirm it is you" }).click();
  await expect(page).toHaveURL("/staff/admin/positions");
}

/**
 * Opens a confirmation dialog, chooses a reason, and confirms, then waits
 * deterministically for one of the two server outcomes: the configuration
 * step-up page, or the record showing `resultStatus`. After a step-up it
 * returns to the record's page and retries once.
 */
export async function confirmCommand(
  page: Page,
  staff: ActivatedStaff,
  label: string,
  reason: string,
  recordUrl: string,
  resultStatus: string,
) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await page.getByRole("button", { name: label, exact: true }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await dialog.getByLabel("Reason").selectOption({ label: reason });
    await dialog.getByRole("button", { name: `Confirm: ${label}` }).click();
    const stepUp = page
      .waitForURL(/\/staff\/reauthenticate\?purpose=CONFIGURATION_CHANGE/)
      .then(() => "STEP_UP" as const)
      .catch(() => "TIMEOUT" as const);
    const applied = page
      .getByText(resultStatus, { exact: true })
      .waitFor({ state: "visible" })
      .then(() => "APPLIED" as const)
      .catch(() => "TIMEOUT" as const);
    const outcome = await Promise.race([stepUp, applied]);
    if (outcome === "TIMEOUT") break;
    if (outcome === "STEP_UP") {
      await reauthenticate(page, staff);
      await page.goto(recordUrl);
      continue;
    }
    return;
  }
  throw new Error(`"${label}" did not complete after a step-up`);
}

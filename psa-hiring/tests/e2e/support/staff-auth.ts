import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { promisify } from "node:util";
import { expect, type Page } from "@playwright/test";
import { Client } from "pg";
import { secretFromManualKey, totpCode } from "../../fixtures/auth/totp";
import { waitForEmail } from "./candidate-auth";

// Browser-test helpers for staff authentication (packet M1.3 §17.8).
// Invitations are issued through the real nonproduction harness script
// (APP_ENV=test, file capture); TOTP codes come from the maintained OTP
// library in tests/fixtures/auth/totp.ts using the manual key the page
// shows. Values are never logged, and traces/screenshots/videos are off in
// the specs that use these helpers.

const run = promisify(execFile);
const projectRoot = process.cwd();

export const STAFF_PASSWORD = "TEST e2e staff passphrase 0001";
export const NEW_STAFF_PASSWORD = "TEST e2e staff passphrase 0002";

export function syntheticStaffEmail(label: string): string {
  return `test.e2e.staff.${label}.${randomBytes(4).toString("hex")}@example.test`;
}

async function harness(args: string[]): Promise<string> {
  const { stdout } = await run(
    path.join(projectRoot, "node_modules/.bin/tsx"),
    [
      "--conditions=react-server",
      "scripts/auth/create-local-staff-invitation.ts",
      "--reason=TEST_HARNESS",
      ...args,
    ],
    { cwd: projectRoot, env: process.env, timeout: 60_000 },
  );
  return stdout.trim();
}

/** Issues (or reissues) an invitation through the local/test harness. */
export async function inviteStaff(email: string): Promise<void> {
  await harness([email]);
}

export async function revokeStaffInvitationFor(email: string): Promise<string> {
  return harness(["--revoke", email]);
}

/** Expires the pending invitation for an email (test database only). */
export async function expireStaffInvitationFor(email: string): Promise<void> {
  const url = process.env.DATABASE_ADMIN_URL;
  if (!url || process.env.APP_ENV !== "test") {
    throw new Error(
      "expiring invitations is a disposable-test-database helper",
    );
  }
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await client.query(
      "UPDATE auth.staff_invitation SET issued_at = now() - interval '2 days', expires_at = now() - interval '1 second' WHERE email = $1 AND status = 'PENDING'",
      [email],
    );
  } finally {
    await client.end();
  }
}

export async function invitationLink(email: string, count = 1) {
  const message = await waitForEmail(email, "STAFF_INVITATION", count);
  return /(http:\/\/\S+\/staff\/activate#invite=[A-Za-z0-9_-]{43})/.exec(
    message.text,
  )![1];
}

/** Hands out each TOTP code at most once (the server rejects replays). */
export class TestAuthenticator {
  readonly #used = new Set<string>();
  constructor(readonly secret: string) {}

  async code(): Promise<string> {
    for (let wait = 0; wait < 40; wait += 1) {
      for (const offset of [0, 1, -1]) {
        const code = await totpCode(this.secret, offset);
        if (!this.#used.has(code)) {
          this.#used.add(code);
          return code;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    throw new Error("no unused TOTP code became available");
  }
}

export type ActivatedStaff = Readonly<{
  email: string;
  authenticator: TestAuthenticator;
  backupCodes: string[];
}>;

/** Reads the manual setup key from the enrollment step. */
export async function readManualKey(page: Page): Promise<string> {
  const key = await page
    .getByRole("definition")
    .locator("code")
    .first()
    .textContent();
  expect(key).toMatch(/^[A-Z2-7 ]+$/);
  return key!;
}

export async function readBackupCodes(page: Page): Promise<string[]> {
  const items = page
    .getByRole("list", { name: "Backup codes" })
    .getByRole("listitem");
  await expect(items).toHaveCount(10);
  const codes = await items.allTextContents();
  return codes.map((c) => c.trim());
}

/** Invite → activate (password, TOTP, backup codes) → /staff/security. */
export async function activateStaff(
  page: Page,
  label: string,
): Promise<ActivatedStaff> {
  const email = syntheticStaffEmail(label);
  await inviteStaff(email);
  await page.goto(await invitationLink(email));
  await expect(page).toHaveURL("/staff/activate");
  await page.getByLabel("Password", { exact: true }).fill(STAFF_PASSWORD);
  await page.getByLabel("Confirm password").fill(STAFF_PASSWORD);
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(
    page.getByRole("heading", { name: /Step 2 of 3/ }),
  ).toBeVisible();
  const authenticator = new TestAuthenticator(
    secretFromManualKey(await readManualKey(page)),
  );
  await page
    .getByLabel("6-digit code from your authenticator app")
    .fill(await authenticator.code());
  await page.getByLabel("Your new password").fill(STAFF_PASSWORD);
  await page.getByRole("button", { name: "Verify code" }).click();
  await expect(
    page.getByRole("heading", { name: /Step 3 of 3/ }),
  ).toBeVisible();
  const backupCodes = await readBackupCodes(page);
  await page.getByLabel("I have saved my backup codes somewhere safe.").check();
  await page.getByRole("button", { name: "Finish activation" }).click();
  await expect(page).toHaveURL("/staff/security");
  return { email, authenticator, backupCodes };
}

export async function staffFirstFactor(
  page: Page,
  email: string,
  password = STAFF_PASSWORD,
) {
  await page.goto("/staff/sign-in");
  await page.getByLabel("Work email address").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Continue" }).click();
}

export async function submitTotp(page: Page, code: string) {
  await page.getByLabel("6-digit code from your authenticator app").fill(code);
  await page.getByRole("button", { name: "Verify and sign in" }).click();
}

export async function submitBackupCode(page: Page, code: string) {
  await page.getByLabel("One of my backup codes").check();
  await page.getByLabel("Backup code", { exact: true }).fill(code);
  await page.getByRole("button", { name: "Verify and sign in" }).click();
}

export async function staffSignIn(page: Page, staff: ActivatedStaff) {
  await staffFirstFactor(page, staff.email);
  await expect(page).toHaveURL("/staff/mfa");
  await submitTotp(page, await staff.authenticator.code());
  await expect(page).toHaveURL("/staff/security");
}

export async function staffSignOut(page: Page) {
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page).toHaveURL(/\/staff\/sign-in/);
}

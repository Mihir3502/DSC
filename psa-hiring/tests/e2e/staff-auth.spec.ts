import {
  PASSWORD,
  readyCandidate,
  signIn,
  useDistinctClient,
} from "./support/candidate-auth";
import { acceptExpectedNotFound, expect, test } from "./support/fixtures";
import {
  activateStaff,
  expireStaffInvitationFor,
  invitationLink,
  inviteStaff,
  NEW_STAFF_PASSWORD,
  revokeStaffInvitationFor,
  STAFF_PASSWORD,
  staffFirstFactor,
  staffSignIn,
  staffSignOut,
  submitBackupCode,
  submitTotp,
  syntheticStaffEmail,
} from "./support/staff-auth";

// Staff invitation, activation, MFA, recent authentication, and session
// journeys (packet M1.3 §17.8) against a production build with its own
// disposable PostgreSQL and captured email. Pages in these journeys show
// one-time setup keys, QR codes, and backup codes, so traces, screenshots,
// and videos are all off for this file; nothing is stored or committed.

test.use({ trace: "off", screenshot: "off", video: "off" });

test.beforeEach(async ({ page }) => {
  await useDistinctClient(page);
});

test.describe("staff authentication", { tag: "@critical" }, () => {
  // Several journeys wait out test-configured lockout/recent-auth windows.
  test.describe.configure({ timeout: 60_000 });

  test("invite → activate → TOTP → backup codes → staff security, with no secret left behind", async ({
    page,
  }) => {
    const staff = await activateStaff(page, "journey");
    await expect(
      page.getByRole("heading", { level: 1, name: "Staff account security" }),
    ).toBeVisible();
    // Minimal surface: no roles, scopes, records, or administration.
    const main = page.getByRole("main");
    await expect(main).not.toContainText(
      /\brole\b|permission|scope|branch|team|candidate record|dashboard|queue|report|administration/i,
    );
    await expect(main).toContainText("Two-step verification");
    // The setup key and backup codes are gone; the URL never held them.
    await expect(page.getByRole("list", { name: "Backup codes" })).toHaveCount(
      0,
    );
    const html = await page.content();
    for (const code of staff.backupCodes) expect(html).not.toContain(code);
    expect(html).not.toMatch(/otpauth:|#invite=/);
    expect(page.url()).toBe(new URL("/staff/security", page.url()).href);
    const storage = await page.evaluate(() =>
      JSON.stringify({ ...localStorage, ...sessionStorage }),
    );
    expect(storage).toBe("{}");
    // Session cookie is HttpOnly (not readable by page script).
    expect(await page.evaluate(() => document.cookie)).not.toMatch(
      /session_token|two_factor/,
    );
  });

  test("password alone never reaches staff pages", async ({ page }) => {
    const staff = await activateStaff(page, "password-only");
    await staffSignOut(page);
    await staffFirstFactor(page, staff.email);
    await expect(page).toHaveURL("/staff/mfa");
    await page.goto("/staff/security");
    await expect(page).toHaveURL("/staff/sign-in");
    await page.goto("/staff/reauthenticate");
    await expect(page).toHaveURL("/staff/sign-in");
  });

  test("signs in with password and TOTP", async ({ page }) => {
    const staff = await activateStaff(page, "sign-in");
    await staffSignOut(page);
    await expect(page.getByRole("main").getByRole("status")).toContainText(
      "You are signed out",
    );
    await staffSignIn(page, staff);
    await expect(
      page.getByText(/using your password and authenticator app code/),
    ).toBeVisible();
  });

  test("bounds invalid codes with a temporary lockout that recovers", async ({
    page,
  }) => {
    const staff = await activateStaff(page, "lockout");
    await staffSignOut(page);
    await staffFirstFactor(page, staff.email);
    for (const wrong of ["000001", "000002", "000003", "000004", "000005"]) {
      await submitTotp(page, wrong);
      await expect(page.getByRole("main").getByRole("alert")).toContainText(
        /code is incorrect/,
      );
      await expect(page.getByRole("main").getByRole("alert")).toBeFocused();
    }
    await submitTotp(page, await staff.authenticator.code());
    await expect(page.getByRole("main").getByRole("alert")).toContainText(
      /sign-in is paused/,
    );
    // After the (test-configured 5 s) interval a fresh sign-in succeeds.
    await page.waitForTimeout(6_000);
    await staffSignIn(page, staff);
  });

  test("accepts a backup code once; replay fails", async ({ page }) => {
    const staff = await activateStaff(page, "backup");
    await staffSignOut(page);
    await staffFirstFactor(page, staff.email);
    await submitBackupCode(page, staff.backupCodes[0]);
    await expect(page).toHaveURL("/staff/security");
    await expect(
      page.getByText(/using your password and a backup code/),
    ).toBeVisible();
    await staffSignOut(page);
    await staffFirstFactor(page, staff.email);
    await submitBackupCode(page, staff.backupCodes[0]);
    await expect(page.getByRole("main").getByRole("alert")).toContainText(
      /already used/,
    );
  });

  test("regenerated backup codes invalidate every earlier code", async ({
    page,
  }) => {
    const staff = await activateStaff(page, "regenerate");
    const regenerate = page.locator("section", {
      has: page.getByRole("heading", { name: "Two-step verification" }),
    });
    await regenerate.getByLabel("Password").fill(STAFF_PASSWORD);
    await regenerate
      .getByLabel("6-digit code from your authenticator app")
      .fill(await staff.authenticator.code());
    await regenerate
      .getByRole("button", { name: "Create new backup codes" })
      .click();
    const list = regenerate.getByRole("list", { name: "Backup codes" });
    await expect(list.getByRole("listitem")).toHaveCount(10);
    const fresh = await list.getByRole("listitem").allTextContents();
    expect(fresh).toHaveLength(10);
    await regenerate
      .getByRole("button", { name: "I have saved these codes" })
      .click();
    await expect(
      regenerate.getByRole("list", { name: "Backup codes" }),
    ).toHaveCount(0);

    await staffSignOut(page);
    await staffFirstFactor(page, staff.email);
    await submitBackupCode(page, staff.backupCodes[1]);
    await expect(page.getByRole("main").getByRole("alert")).toContainText(
      /already used/,
    );
    await submitBackupCode(page, fresh[0].trim());
    await expect(page).toHaveURL("/staff/security");
  });

  test("recent-auth challenge after expiry, then password change ends every session", async ({
    page,
  }) => {
    // Waits out the 20 s test window on purpose, so allow more than the
    // default per-test budget.
    test.setTimeout(90_000);
    const staff = await activateStaff(page, "recent");
    // Test-configured recent window is 20 s.
    await page.waitForTimeout(21_000);
    await page.goto("/staff/security");
    await expect(
      page.getByText(/You have not confirmed your identity in the last/),
    ).toBeVisible();
    const password = page.locator("#password");
    await password.getByLabel("Current password").fill(STAFF_PASSWORD);
    await password
      .getByLabel("New password", { exact: true })
      .fill(NEW_STAFF_PASSWORD);
    await password.getByLabel("Confirm new password").fill(NEW_STAFF_PASSWORD);
    await password.getByRole("button", { name: "Change password" }).click();
    await expect(page).toHaveURL(
      "/staff/reauthenticate?purpose=CHANGE_PASSWORD",
    );

    // Wrong code: generic failure, then success returns to the password form.
    await page.getByLabel("Password").fill(STAFF_PASSWORD);
    await page
      .getByLabel("6-digit code from your authenticator app")
      .fill("000000");
    await page.getByRole("button", { name: "Confirm it is you" }).click();
    await expect(page.getByRole("main").getByRole("alert")).toContainText(
      /password or authenticator code is incorrect/,
    );
    await page.getByLabel("Password").fill(STAFF_PASSWORD);
    await page
      .getByLabel("6-digit code from your authenticator app")
      .fill(await staff.authenticator.code());
    await page.getByRole("button", { name: "Confirm it is you" }).click();
    await expect(page).toHaveURL("/staff/security#password");
    await expect(
      page.getByText(/^You confirmed your identity recently/),
    ).toBeVisible();

    await password.getByLabel("Current password").fill(STAFF_PASSWORD);
    await password
      .getByLabel("New password", { exact: true })
      .fill(NEW_STAFF_PASSWORD);
    await password.getByLabel("Confirm new password").fill(NEW_STAFF_PASSWORD);
    await password.getByRole("button", { name: "Change password" }).click();
    await expect(page).toHaveURL("/staff/sign-in?notice=password-changed");
    await page.goto("/staff/security");
    await expect(page).toHaveURL("/staff/sign-in");
    await staffFirstFactor(page, staff.email, NEW_STAFF_PASSWORD);
    await expect(page).toHaveURL("/staff/mfa");
  });

  test("resent, revoked, and expired invitations fail safely", async ({
    page,
  }) => {
    const email = syntheticStaffEmail("invites");
    await inviteStaff(email);
    const first = await invitationLink(email, 1);
    await inviteStaff(email);
    const second = await invitationLink(email, 2);
    const tryLink = async (link: string) => {
      await page.goto(link);
      await page.getByLabel("Password", { exact: true }).fill(STAFF_PASSWORD);
      await page.getByLabel("Confirm password").fill(STAFF_PASSWORD);
      await page.getByRole("button", { name: "Continue" }).click();
    };
    await tryLink(first);
    await expect(page.getByRole("main").getByRole("alert")).toContainText(
      /invalid, has expired, was replaced/,
    );
    expect(page.url()).not.toContain("#invite=");

    expect(await revokeStaffInvitationFor(email)).toContain("REVOKED");
    await tryLink(second);
    await expect(page.getByRole("main").getByRole("alert")).toContainText(
      /invalid, has expired, was replaced/,
    );

    await inviteStaff(email);
    const third = await invitationLink(email, 3);
    await expireStaffInvitationFor(email);
    await tryLink(third);
    await expect(page.getByRole("main").getByRole("alert")).toContainText(
      /invalid, has expired, was replaced/,
    );

    await page.goto("/staff/activate");
    await expect(page.getByRole("main").getByRole("alert")).toContainText(
      "cannot be used",
    );
  });

  test("candidates cannot use staff sign-in, MFA, or staff pages", async ({
    page,
    guards,
  }) => {
    const email = await readyCandidate(page, "staff-boundary");
    await staffFirstFactor(page, email, PASSWORD);
    await expect(page.getByRole("main").getByRole("alert")).toContainText(
      "cannot use staff sign-in",
    );
    await signIn(page, email);
    await expect(page).toHaveURL("/candidate/security");
    // M1.5: a signed-in candidate sees the same safe not-found as an
    // unknown page on staff-only routes (packet §25: hidden, not
    // redirected). The public MFA step still requires a staff challenge.
    for (const path of ["/staff/security", "/staff/reauthenticate"]) {
      const response = await page.goto(path);
      expect(response?.status(), path).toBe(404);
      await expect(page).toHaveURL(path);
      await expect(
        page.getByRole("heading", { level: 1, name: "Page not found" }),
      ).toBeVisible();
    }
    acceptExpectedNotFound(guards, 2);
    await page.goto("/staff/mfa");
    await expect(page).toHaveURL("/staff/sign-in");
  });
});

import AxeBuilder from "@axe-core/playwright";
import type { Page, TestInfo } from "@playwright/test";
import { expect, test } from "../e2e/support/fixtures";
import { useDistinctClient } from "../e2e/support/candidate-auth";
import {
  invitationLink,
  inviteStaff,
  readManualKey,
  STAFF_PASSWORD,
  staffFirstFactor,
  staffSignOut,
  syntheticStaffEmail,
  TestAuthenticator,
  activateStaff,
} from "../e2e/support/staff-auth";
import { secretFromManualKey } from "../fixtures/auth/totp";

// Automated axe scans for every M1.3 staff screen and step, including error
// and authenticated states (packet M1.3 §16, §17.7, §17.8 item 10).
// Serious/critical violations fail; no rules are disabled. Pages show
// one-time setup keys and codes, so traces/screenshots/videos are off.

test.use({ trace: "off", screenshot: "off", video: "off" });

const blocking = new Set(["serious", "critical"]);

async function expectNoBlockingViolations(page: Page, testInfo: TestInfo) {
  const results = await new AxeBuilder({ page })
    .withTags([
      "wcag2a",
      "wcag2aa",
      "wcag21a",
      "wcag21aa",
      "wcag22aa",
      "best-practice",
    ])
    .analyze();
  for (const v of results.violations) {
    testInfo.annotations.push({
      type: "axe",
      description: `${v.impact ?? "unknown"} ${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`,
    });
  }
  expect(
    results.violations
      .filter((v) => blocking.has(v.impact ?? ""))
      .map((v) => `${v.impact} ${v.id} (${v.nodes.length} node(s))`),
    "serious/critical axe violations",
  ).toEqual([]);
}

test.beforeEach(async ({ page }) => {
  await useDistinctClient(page);
});

test.describe("staff screens", { tag: "@critical" }, () => {
  for (const path of ["/staff/sign-in", "/staff/recover", "/staff/activate"]) {
    test(`${path} has no serious or critical axe violations`, async ({
      page,
    }, testInfo) => {
      await page.goto(path);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await expectNoBlockingViolations(page, testInfo);
    });
  }

  test("activation steps, errors, and backup codes are accessible", async ({
    page,
  }, testInfo) => {
    const email = syntheticStaffEmail("a11y-activate");
    await inviteStaff(email);
    await page.goto(await invitationLink(email));
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.getByRole("main").getByRole("alert")).toBeFocused();
    await expectNoBlockingViolations(page, testInfo);

    await page.getByLabel("Password", { exact: true }).fill(STAFF_PASSWORD);
    await page.getByLabel("Confirm password").fill(STAFF_PASSWORD);
    await page.getByRole("button", { name: "Continue" }).click();
    const heading = page.getByRole("heading", { name: /Step 2 of 3/ });
    await expect(heading).toBeFocused();
    // The QR code is never the only path: a text setup key is present.
    await expect(
      page.getByRole("img", { name: /QR code .* use the setup key instead/ }),
    ).toBeVisible();
    const authenticator = new TestAuthenticator(
      secretFromManualKey(await readManualKey(page)),
    );
    // The page keeps a generic title that never contains the setup key.
    await expect(page).toHaveTitle(/^Activate staff account/);
    await expectNoBlockingViolations(page, testInfo);

    // Keyboard-only: tab into the code field and paste a spaced code.
    const codeField = page.getByLabel(
      "6-digit code from your authenticator app",
    );
    await codeField.focus();
    const code = await authenticator.code();
    await page.keyboard.insertText(`${code.slice(0, 3)} ${code.slice(3)}`);
    await page.getByLabel("Your new password").fill(STAFF_PASSWORD);
    await page.keyboard.press("Enter");
    await expect(
      page.getByRole("heading", { name: /Step 3 of 3/ }),
    ).toBeFocused();
    await page.getByRole("button", { name: "Finish activation" }).click();
    await expect(page.getByRole("main").getByRole("alert")).toContainText(
      /saved your backup codes/,
    );
    await expectNoBlockingViolations(page, testInfo);
  });

  test("MFA, security, and reauthentication screens are accessible", async ({
    page,
  }, testInfo) => {
    const staff = await activateStaff(page, "a11y-signed-in");
    await expectNoBlockingViolations(page, testInfo);
    await page.goto("/staff/reauthenticate?purpose=CHANGE_PASSWORD");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      "Confirm it is you",
    );
    await expectNoBlockingViolations(page, testInfo);
    await page.goto("/staff/security");
    await staffSignOut(page);
    await staffFirstFactor(page, staff.email);
    await expect(page).toHaveURL("/staff/mfa");
    await expectNoBlockingViolations(page, testInfo);
    await page.getByLabel("One of my backup codes").check();
    await page.getByRole("button", { name: "Verify and sign in" }).click();
    await expect(page.getByRole("main").getByRole("alert")).toBeFocused();
    await expectNoBlockingViolations(page, testInfo);
    await page.getByLabel("Authenticator app code").check();
    await page
      .getByLabel("6-digit code from your authenticator app")
      .fill(await staff.authenticator.code());
    await page.getByRole("button", { name: "Verify and sign in" }).click();
    await expect(page).toHaveURL("/staff/security");
  });

  test("staff screens reflow at a narrow (320 px) viewport without horizontal scrolling", async ({
    page,
  }) => {
    await activateStaff(page, "a11y-reflow");
    await page.setViewportSize({ width: 320, height: 800 });
    for (const path of ["/staff/reauthenticate", "/staff/security"]) {
      await page.goto(path);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth,
      );
      expect(overflow, path).toBeLessThanOrEqual(1);
    }
    await staffSignOut(page);
    for (const path of ["/staff/sign-in", "/staff/recover"]) {
      await page.goto(path);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth,
      );
      expect(overflow, path).toBeLessThanOrEqual(1);
    }
  });
});

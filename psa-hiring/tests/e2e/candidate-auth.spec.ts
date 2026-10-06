import {
  emailCount,
  issueInvitation,
  NEW_PASSWORD,
  PASSWORD,
  readyCandidate,
  register,
  resetLink,
  signIn,
  syntheticEmail,
  useDistinctClient,
  verificationCode,
  verify,
} from "./support/candidate-auth";
import { expect, test } from "./support/fixtures";

// Candidate registration and recovery journeys (packet M1.2 §16.6) against
// a production build with its own disposable PostgreSQL and captured email.
// Traces are off for this file because journeys handle one-time
// capabilities (codes and reset/invitation links); screenshots and videos
// on failure never show them (fragments are removed before rendering and
// hidden inputs are not visible).

test.use({ trace: "off" });

test.beforeEach(async ({ page }) => {
  await useDistinctClient(page);
});

test.describe("candidate authentication", { tag: "@critical" }, () => {
  test("registers, verifies with a code, signs in, and reaches account security", async ({
    page,
  }) => {
    const email = syntheticEmail("journey");
    await register(page, email);
    await expect(page).toHaveURL("/register");
    const code = await verificationCode(email);

    // Unverified candidates cannot sign in; the message is generic.
    await signIn(page, email);
    await expect(page.getByRole("main").getByRole("alert")).toContainText(
      "email address or password is incorrect",
    );

    await verify(page, email, code);
    await expect(page.getByRole("main").getByRole("status")).toContainText(
      "Email verified",
    );
    expect(page.url()).not.toContain(code);

    await signIn(page, email);
    await expect(page).toHaveURL("/candidate/security");
    await expect(
      page.getByRole("heading", { level: 1, name: "Account security" }),
    ).toBeVisible();
    await expect(
      page.getByText(/Signed in as t•••@example\.test/),
    ).toBeVisible();
    await expect(page.getByText("Verified", { exact: true })).toBeVisible();
    await expect(page.getByText(/\(this session\)/)).toBeVisible();
    await expect(page.locator("body")).not.toContainText(email);

    const cookies = await page.context().cookies();
    const session = cookies.find((c) => c.name === "psa.session_token");
    expect(session).toMatchObject({
      httpOnly: true,
      sameSite: "Lax",
      path: "/",
    });
  });

  test("resend replaces the previous code", async ({ page }) => {
    const email = syntheticEmail("resend");
    await register(page, email);
    const first = await verificationCode(email, 1);
    await page.goto("/verify-email");
    await page.getByLabel("Email address").fill(email);
    await page.getByRole("button", { name: "Send a new code" }).click();
    await expect(page.getByRole("main").getByRole("status")).toContainText(
      "Any earlier code",
    );
    const second = await verificationCode(email, 2);
    expect(second).not.toBe(first);

    await verify(page, email, first);
    const alert = page.getByRole("main").getByRole("alert");
    await expect(alert).toContainText("incorrect, has expired");
    await expect(alert).toBeFocused();
    await verify(page, email, second);
    await expect(page.getByRole("main").getByRole("status")).toContainText(
      "Email verified",
    );
  });

  test("recovers by email link, strips the token from the URL, ends old sessions, and refuses replay", async ({
    page,
    browser,
  }) => {
    const email = await readyCandidate(page, "reset");
    await signIn(page, email);
    await expect(page).toHaveURL("/candidate/security");

    const other = await browser.newContext();
    const recoverPage = await other.newPage();
    await recoverPage.goto("/recover");
    await recoverPage.getByLabel("Email address").fill(email);
    await recoverPage.getByRole("button", { name: "Send reset link" }).click();
    await expect(
      recoverPage.getByRole("main").getByRole("status"),
    ).toContainText("Check your email");

    const link = await resetLink(email);
    const token = new URL(link).hash.replace("#token=", "");
    const response = await recoverPage.goto(link);
    expect(response?.headers()["referrer-policy"]).toBe("no-referrer");
    expect(response?.headers()["cache-control"]).toContain("no-store");
    await expect(
      recoverPage.getByLabel("New password", { exact: true }),
    ).toBeVisible();
    expect(recoverPage.url()).toMatch(/\/reset-password$/);
    expect(
      await recoverPage.evaluate(() => window.location.href),
    ).not.toContain(token);
    expect(await recoverPage.title()).not.toContain(token);

    await recoverPage
      .getByLabel("New password", { exact: true })
      .fill(NEW_PASSWORD);
    await recoverPage.getByLabel("Confirm new password").fill(NEW_PASSWORD);
    await recoverPage.getByRole("button", { name: "Change password" }).click();
    await expect(
      recoverPage.getByRole("main").getByRole("status"),
    ).toContainText("Password changed");
    await expect
      .poll(() => emailCount(email, "PASSWORD_CHANGED"))
      .toBeGreaterThanOrEqual(1);

    // The old session was revoked.
    await page.goto("/candidate/security");
    await expect(page).toHaveURL("/sign-in");

    // Replay fails safely.
    await recoverPage.goto("/");
    await recoverPage.goto(link);
    await recoverPage
      .getByLabel("New password", { exact: true })
      .fill(PASSWORD);
    await recoverPage.getByLabel("Confirm new password").fill(PASSWORD);
    await recoverPage.getByRole("button", { name: "Change password" }).click();
    await expect(
      recoverPage.getByRole("main").getByRole("alert"),
    ).toContainText("invalid, has expired, or was already used");
    await other.close();

    await signIn(page, email, PASSWORD);
    await expect(page.getByRole("main").getByRole("alert")).toBeVisible();
    await signIn(page, email, NEW_PASSWORD);
    await expect(page).toHaveURL("/candidate/security");
  });

  test("changes the password and signs out other sessions", async ({
    page,
    browser,
  }) => {
    const email = await readyCandidate(page, "change");
    await signIn(page, email);
    const other = await browser.newContext();
    const otherPage = await other.newPage();
    await signIn(otherPage, email);
    await expect(otherPage).toHaveURL("/candidate/security");

    await page.goto("/candidate/security");
    await page.getByLabel("Current password").fill(PASSWORD);
    await page.getByLabel("New password", { exact: true }).fill(NEW_PASSWORD);
    await page.getByLabel("Confirm new password").fill(NEW_PASSWORD);
    await page.getByRole("button", { name: "Change password" }).click();
    await expect(
      page.getByRole("main").getByRole("status").first(),
    ).toContainText("Other signed-in sessions were ended");
    await page.reload();
    await expect(page).toHaveURL("/candidate/security");
    await otherPage.reload();
    await expect(otherPage).toHaveURL("/sign-in");
    await other.close();
  });

  test("lists sessions and revokes another session", async ({
    page,
    browser,
  }) => {
    const email = await readyCandidate(page, "sessions");
    await signIn(page, email);
    const other = await browser.newContext();
    const otherPage = await other.newPage();
    await signIn(otherPage, email);
    await expect(otherPage).toHaveURL("/candidate/security");

    await page.goto("/candidate/security");
    const items = page.getByRole("listitem");
    await expect(items).toHaveCount(2);
    await page
      .getByRole("button", { name: /^Sign out .* session$/ })
      .filter({ hasNotText: "this session" })
      .first()
      .click();
    await expect(page.getByRole("main").getByRole("status")).toContainText(
      "The session was signed out",
    );
    await expect(page.getByRole("listitem")).toHaveCount(1);
    await otherPage.reload();
    await expect(otherPage).toHaveURL("/sign-in");
    await other.close();
  });

  test("signs out with a POST action and protects the security page", async ({
    page,
    request,
  }) => {
    const email = await readyCandidate(page, "signout");
    await signIn(page, email);
    await expect(page).toHaveURL("/candidate/security");
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await expect(page).toHaveURL("/sign-in");
    await page.goto("/candidate/security");
    await expect(page).toHaveURL("/sign-in");

    // No HTTP sign-in, sign-up, or sign-out endpoint is reachable.
    for (const path of [
      "/api/auth/sign-in/email",
      "/api/auth/sign-up/email",
      "/api/auth/sign-out",
      "/api/auth/email-otp/send-verification-otp",
    ]) {
      const response = await request.post(path, {
        data: { email, password: PASSWORD },
      });
      expect(response.status(), path).toBe(404);
    }
  });

  test("registers from an invitation bound to its email", async ({ page }) => {
    const invited = syntheticEmail("invited");
    const link = await issueInvitation(invited);
    const token = new URL(link).hash.replace("#intent=", "");
    await page.goto(link.replace(/^http:\/\/[^/]+/, ""));
    await expect(
      page.getByText(/registering from an invitation/),
    ).toBeVisible();
    expect(await page.evaluate(() => window.location.href)).not.toContain(
      token,
    );

    await page.getByLabel("Email address").fill(syntheticEmail("intruder"));
    await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
    await page.getByLabel("Confirm password").fill(PASSWORD);
    await page.getByRole("button", { name: "Create account" }).click();
    await expect(page.getByRole("main").getByRole("alert")).toContainText(
      "registration link is invalid",
    );

    await page.getByLabel("Email address").fill(invited);
    await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
    await page.getByLabel("Confirm password").fill(PASSWORD);
    await page.getByRole("button", { name: "Create account" }).click();
    await expect(page.getByRole("main").getByRole("status")).toContainText(
      "Check your email",
    );
    await verificationCode(invited);
  });

  test("gives generic outcomes and ignores unsafe redirects", async ({
    page,
  }) => {
    const email = await readyCandidate(page, "generic");

    await signIn(page, syntheticEmail("nobody"));
    const unknown = await page
      .getByRole("main")
      .getByRole("alert")
      .textContent();
    await signIn(page, email, "TEST e2e wrong passphrase 0009");
    const wrong = await page.getByRole("main").getByRole("alert").textContent();
    expect(unknown).toBe(wrong);

    for (const target of [email, syntheticEmail("nobody")]) {
      await page.goto("/recover");
      await page.getByLabel("Email address").fill(target);
      await page.getByRole("button", { name: "Send reset link" }).click();
      await expect(page.getByRole("main").getByRole("status")).toContainText(
        "If this email address belongs to a candidate account",
      );
    }

    await page.goto("/sign-in?next=https://evil.example.test/");
    await page.getByLabel("Email address").fill(email);
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL("/candidate/security");
  });

  test("rejects a cross-origin server action submission", async ({
    page,
    guards,
  }) => {
    const email = await readyCandidate(page, "csrf");
    await page.goto("/sign-in");
    // Replay the real action request with a foreign Origin header.
    let status = 0;
    await page.route("**/sign-in", async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      const response = await route.fetch({
        headers: {
          ...route.request().headers(),
          origin: "https://evil.example.test",
        },
      });
      status = response.status();
      await route.fulfill({ response });
    });
    await page.getByLabel("Email address").fill(email);
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect.poll(() => status).toBeGreaterThanOrEqual(400);
    expect(
      (await page.context().cookies()).some(
        (c) => c.name === "psa.session_token",
      ),
    ).toBe(false);
    await page.unroute("**/sign-in");
    // The rejected action surfaces in the browser as exactly these two
    // expected errors (HTTP 500 from Next.js, React action error #441).
    const expected = [/status of 500/, /React error #441/];
    const unexpected = guards.pageErrors.filter(
      (e) => !expected.some((pattern) => pattern.test(e)),
    );
    expect(unexpected).toEqual([]);
    guards.pageErrors.length = 0;
  });
});

import { Client } from "pg";
import {
  PASSWORD,
  readyCandidate,
  signIn,
  syntheticEmail,
  useDistinctClient,
} from "./support/candidate-auth";
import { acceptExpectedNotFound, expect, test } from "./support/fixtures";
import { activateStaff, staffSignIn } from "./support/staff-auth";

// M1.5 route, object, and field authorization in a production build with
// its own disposable PostgreSQL (packet M1.5 §25, §27, §28; AC-M1.5-15).
// Direct-route denial, account-type separation, stale access, object
// denial, field filtering, mass-assignment rejection, redirects, cache
// headers, and leakage checks. Staff setup keys/backup codes appear in
// some pages, so traces, screenshots, and videos are off for this file.

test.use({ trace: "off", screenshot: "off", video: "off" });

test.beforeEach(async ({ page }) => {
  await useDistinctClient(page);
});

async function adminQuery<T>(sql: string, params: unknown[]): Promise<T[]> {
  const url = process.env.DATABASE_ADMIN_URL;
  if (!url || process.env.APP_ENV !== "test") {
    throw new Error("admin queries are a disposable-test-database helper");
  }
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    return (await client.query(sql, params)).rows as T[];
  } finally {
    await client.end();
  }
}

function expectPrivateNoStore(headers: Record<string, string>) {
  const cache = headers["cache-control"] ?? "";
  expect(cache).toContain("no-store");
  expect(cache).toContain("private");
  expect(cache).not.toMatch(/public|s-maxage/);
}

test.describe("route and field authorization", { tag: "@critical" }, () => {
  test.describe.configure({ timeout: 60_000 });

  test("anonymous direct requests to protected pages go to the right sign-in, privately", async ({
    page,
  }) => {
    for (const [path, signInPath] of [
      ["/candidate/security", "/sign-in"],
      ["/staff/security", "/staff/sign-in"],
      ["/staff/reauthenticate", "/staff/sign-in"],
    ] as const) {
      await page.goto(path);
      await expect(page, path).toHaveURL(signInPath);
    }
    const response = await page.goto("/sign-in");
    expectPrivateNoStore(response!.headers());
    expect(response!.headers()["referrer-policy"]).toBe("no-referrer");
  });

  test("an unknown route and a hidden route look the same", async ({
    page,
    guards,
  }) => {
    const email = await readyCandidate(page, "hidden");
    await signIn(page, email);
    await expect(page).toHaveURL("/candidate/security");
    const hidden = await page.goto("/staff/security");
    const hiddenText = await page.getByRole("main").innerText();
    const unknown = await page.goto("/staff/does-not-exist");
    const unknownText = await page.getByRole("main").innerText();
    expect(hidden!.status()).toBe(404);
    expect(unknown!.status()).toBe(404);
    expect(hiddenText).toBe(unknownText);
    await expect(page.getByRole("heading", { level: 1 })).toBeFocused();
    acceptExpectedNotFound(guards, 2);
  });

  test("staff cannot enter candidate pages; candidate pages carry only the exact projection", async ({
    page,
    browser,
    guards,
  }) => {
    const staff = await activateStaff(page, "no-candidate-pages");
    await expect(page).toHaveURL("/staff/security");
    const response = await page.goto("/candidate/security");
    expect(response!.status()).toBe(404);
    await expect(
      page.getByRole("heading", { name: "Page not found" }),
    ).toBeVisible();
    acceptExpectedNotFound(guards, 1);
    void staff;

    // A candidate's own page: masked email and opaque refs only, in the
    // HTML and in the RSC payload.
    const context = await browser.newContext();
    const candidatePage = await context.newPage();
    await useDistinctClient(candidatePage);
    const email = await readyCandidate(candidatePage, "projection");
    await signIn(candidatePage, email);
    await expect(candidatePage).toHaveURL("/candidate/security");
    const html = await candidatePage.content();
    const rsc = await candidatePage.evaluate(async () => {
      const r = await fetch("/candidate/security", { headers: { RSC: "1" } });
      return {
        status: r.status,
        cache: r.headers.get("cache-control"),
        body: await r.text(),
      };
    });
    expect(rsc.cache).toContain("no-store");
    const [account] = await adminQuery<{ id: string }>(
      'SELECT id FROM auth."user" WHERE email = $1',
      [email],
    );
    const sessions = await adminQuery<{ id: string; token: string }>(
      "SELECT id, token FROM auth.session WHERE user_id = $1",
      [account.id],
    );
    for (const text of [html, rsc.body]) {
      expect(text).not.toContain(email);
      expect(text).not.toContain(account.id);
      for (const s of sessions) {
        expect(text).not.toContain(s.id);
        expect(text).not.toContain(s.token);
      }
      expect(text).not.toMatch(
        /Mozilla\/5\.0|HeadlessChrome|accountType|twoFactor|passwordHash|permissionCode|scopeReference/,
      );
    }
    await expect(
      candidatePage.getByText(/^Signed in as t•••@example\.test$/),
    ).toBeVisible();
    await context.close();
  });

  test("two principals never receive each other's protected page", async ({
    page,
    browser,
  }) => {
    const first = await readyCandidate(page, "cache-a");
    await signIn(page, first);
    await expect(page).toHaveURL("/candidate/security");
    const firstResponse = await page.goto("/candidate/security");
    // The privacy control: no browser, proxy, or CDN may store the page.
    // (Next.js owns `Vary` on App Router pages; it is defense in depth only,
    // and protected Route Handler responses carry `Vary: Cookie`.)
    expectPrivateNoStore(firstResponse!.headers());
    expect(firstResponse!.headers()["cache-control"]).not.toMatch(
      /max-age=[1-9]/,
    );

    const context = await browser.newContext();
    const other = await context.newPage();
    await useDistinctClient(other);
    const second = await readyCandidate(other, "cache-b");
    await signIn(other, second);
    await expect(other).toHaveURL("/candidate/security");
    await other.reload();
    const otherSessions = other.getByRole("heading", {
      name: "Signed-in sessions",
    });
    await expect(otherSessions).toBeVisible();
    // Each sees only its own sessions (one each) and masked email.
    await expect(page.getByRole("listitem")).toHaveCount(1);
    await expect(other.getByRole("listitem")).toHaveCount(1);
    expect(await other.content()).not.toContain(first);
    await context.close();
  });

  test("injected server-owned fields reject the whole submission with no state change", async ({
    page,
  }) => {
    const email = await readyCandidate(page, "mass-assign");
    await signIn(page, email);
    await expect(page).toHaveURL("/candidate/security");
    const form = page.locator("form", {
      has: page.getByLabel("Current password"),
    });
    await form.evaluate((element) => {
      for (const [name, value] of [
        ["accountType", "STAFF"],
        ["status", "ACTIVE"],
        ["role", "SYSTEM_ADMINISTRATOR"],
      ]) {
        const input = document.createElement("input");
        input.type = "hidden";
        input.name = name;
        input.value = value;
        element.appendChild(input);
      }
    });
    await page.getByLabel("Current password").fill(PASSWORD);
    await page
      .getByLabel("New password", { exact: true })
      .fill("TEST e2e mass passphrase 0003");
    await page
      .getByLabel("Confirm new password")
      .fill("TEST e2e mass passphrase 0003");
    await page.getByRole("button", { name: "Change password" }).click();
    await expect(page.getByRole("main").getByRole("alert")).toContainText(
      "This form could not be processed",
    );
    const [row] = await adminQuery<{ account_type: string; status: string }>(
      'SELECT account_type, status FROM auth."user" WHERE email = $1',
      [email],
    );
    expect(row).toEqual({ account_type: "CANDIDATE", status: "ACTIVE" });
    // The password did not change: the original still signs in.
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await signIn(page, email, PASSWORD);
    await expect(page).toHaveURL("/candidate/security");
  });

  test("malicious continuation values never reach the page or the redirect", async ({
    page,
  }) => {
    const email = await readyCandidate(page, "redirects");
    for (const next of [
      "//evil.example.test",
      "https://evil.example.test",
      "/\\evil.example.test",
      "%2F%2Fevil.example.test",
      "CANDIDATE_SECURITY\r\nLocation: //evil",
      "javascript:alert(1)",
    ]) {
      await page.goto(`/sign-in?next=${encodeURIComponent(next)}`);
      expect(await page.locator('input[name="next"]').count(), next).toBe(0);
    }
    await page.goto(
      `/sign-in?next=${encodeURIComponent("//evil.example.test")}`,
    );
    await page.getByLabel("Email address").fill(email);
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL("/candidate/security");
  });

  test("the auth HTTP surface is closed: no session object, no GET side effects", async ({
    page,
    guards,
  }) => {
    const email = await readyCandidate(page, "auth-http");
    await signIn(page, email);
    await expect(page).toHaveURL("/candidate/security");
    for (const path of [
      "/api/auth/get-session",
      "/api/auth/sign-out",
      "/api/auth/list-sessions",
    ]) {
      const result = await page.evaluate(async (p) => {
        const r = await fetch(p, { credentials: "same-origin" });
        return {
          status: r.status,
          cache: r.headers.get("cache-control"),
          body: await r.text(),
        };
      }, path);
      expect(result.status, path).toBe(404);
      expect(result.cache).toContain("no-store");
      expect(result.body).not.toMatch(/"(user|session|email)"/);
    }
    acceptExpectedNotFound(guards, 3);
    // The GETs changed nothing: still signed in.
    await page.reload();
    await expect(page).toHaveURL("/candidate/security");
  });

  test("a security change behind an open browser session takes effect on the next request", async ({
    page,
  }) => {
    const staff = await activateStaff(page, "stale");
    await expect(page).toHaveURL("/staff/security");
    // Simulate a role/MFA/security change committed elsewhere.
    await adminQuery(
      'UPDATE auth."user" SET version = version + 1 WHERE email = $1',
      [staff.email],
    );
    await page.reload();
    await expect(page).toHaveURL("/staff/sign-in");
    await staffSignIn(page, staff);
  });

  test("reauthentication cannot be pointed at an arbitrary destination", async ({
    page,
  }) => {
    const staff = await activateStaff(page, "reauth-redirect");
    await page.goto(
      `/staff/reauthenticate?purpose=${encodeURIComponent("https://evil.example.test/")}`,
    );
    expect(await page.locator('input[name="purpose"]').inputValue()).toBe(
      "STAFF_SECURITY",
    );
    await page.getByLabel("Password").fill("TEST e2e staff passphrase 0001");
    await page
      .getByLabel("6-digit code from your authenticator app")
      .fill(await staff.authenticator.code());
    await page.getByRole("button", { name: "Confirm it is you" }).click();
    await expect(page).toHaveURL("/staff/security");
  });

  test("an unverified or unknown visitor never sees a protected surface", async ({
    page,
  }) => {
    // Generic sign-in failure for an unknown account; no redirect.
    await signIn(page, syntheticEmail("nobody"));
    await expect(page).toHaveURL("/sign-in");
    await page.goto("/candidate/security");
    await expect(page).toHaveURL("/sign-in");
  });
});

import { expect, tabToLink, test } from "./support/fixtures";

// Critical smoke journeys for the three foundation routes. Each test uses its
// own browser context (Playwright default) and synthetic content only.

test.describe("foundation routes", { tag: "@critical" }, () => {
  test("public home page offers both portals and reaches them by keyboard", async ({
    page,
  }) => {
    const response = await page.goto("/");
    expect(response?.status()).toBe(200);
    await expect(page.getByRole("main")).toBeVisible();
    await expect(
      page.getByRole("heading", {
        level: 1,
        name: "PSA Workforce Hiring System",
      }),
    ).toBeVisible();
    await expect(page.getByText(/through Ready for Assignment/)).toBeVisible();

    const portals = page.getByRole("navigation", { name: "Portals" });
    await expect(
      portals.getByRole("link", { name: "Candidate Portal" }),
    ).toHaveAttribute("href", "/candidate");
    await expect(
      portals.getByRole("link", { name: "Staff Portal" }),
    ).toHaveAttribute("href", "/staff");

    const link = await tabToLink(page, "Candidate Portal");
    await expect(link).toBeFocused();
    await page.keyboard.press("Enter");
    // The portal is authenticated, so an anonymous visitor is asked to sign in.
    await expect(page).toHaveURL("/sign-in");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  });

  test("the staff portal is authenticated, so an anonymous visitor is asked to sign in", async ({
    page,
  }) => {
    await page.goto("/");
    const link = await tabToLink(page, "Staff Portal");
    await expect(link).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL("/staff/sign-in");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  });

  test("skip link is the first keyboard stop and moves focus to main", async ({
    page,
  }) => {
    await page.goto("/staff/sign-in");
    await page.keyboard.press("Tab");
    const skip = page.getByRole("link", { name: "Skip to main content" });
    await expect(skip).toBeFocused();
    await expect(skip).toBeVisible();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("main")).toBeFocused();
  });

  test("every page response carries a valid correlation ID", async ({
    page,
  }) => {
    const uuid =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    const seen = new Set<string>();
    for (const path of ["/", "/sign-in", "/staff/sign-in"]) {
      const response = await page.goto(path);
      const id = response?.headers()["x-correlation-id"] ?? "";
      expect(id, `${path} correlation header`).toMatch(uuid);
      seen.add(id);
    }
    expect(seen.size).toBe(3);
  });

  test("keeps a valid incoming correlation ID and replaces a forged one", async ({
    request,
  }) => {
    const valid = "0b9a7a3e-6a55-4c8e-9a3b-2f1d0c4e5a6b";
    const kept = await request.get("/", {
      headers: { "x-correlation-id": valid },
    });
    expect(kept.headers()["x-correlation-id"]).toBe(valid);

    const forged = `${valid}-injected-${"x".repeat(200)}`;
    const replaced = await request.get("/staff/sign-in", {
      headers: { "x-correlation-id": forged },
    });
    const id = replaced.headers()["x-correlation-id"];
    expect(id).not.toBe(forged);
    expect(id).toHaveLength(36);
  });
});

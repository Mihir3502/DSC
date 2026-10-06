import { expect, test as base, type Page } from "@playwright/test";

// Shared browser guards for critical and accessibility tests:
// - requests to any origin other than the local test server are aborted and
//   reported (origin only, never full URLs or bodies);
// - uncaught page errors and console errors fail the test.

type Guards = { unexpectedRequests: string[]; pageErrors: string[] };

export const test = base.extend<{ guards: Guards }>({
  guards: [
    async ({ page, baseURL }, use) => {
      const allowedOrigin = new URL(baseURL ?? "http://127.0.0.1:3100").origin;
      const guards: Guards = { unexpectedRequests: [], pageErrors: [] };

      await page.route("**/*", (route) => {
        const url = route.request().url();
        if (url.startsWith("data:") || new URL(url).origin === allowedOrigin) {
          return route.continue();
        }
        guards.unexpectedRequests.push(new URL(url).origin);
        return route.abort("blockedbyclient");
      });
      page.on("pageerror", (error) =>
        guards.pageErrors.push(
          `pageerror: ${error.name}: ${error.message.split("\n")[0]}`,
        ),
      );
      page.on("console", (message) => {
        if (message.type() === "error") {
          guards.pageErrors.push(
            `console.error: ${message.text().split("\n")[0].slice(0, 200)}`,
          );
        }
      });

      await use(guards);

      expect(
        guards.unexpectedRequests,
        "unexpected third-party requests",
      ).toEqual([]);
      expect(guards.pageErrors, "uncaught page or console errors").toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };

/** Presses Tab until the named link has focus (bounded), then returns it. */
export async function tabToLink(page: Page, name: string, maxTabs = 10) {
  const link = page.getByRole("link", { name, exact: true });
  for (let i = 0; i < maxTabs; i += 1) {
    await page.keyboard.press("Tab");
    if (await link.evaluate((el) => el === document.activeElement)) return link;
  }
  throw new Error(`"${name}" was not reachable within ${maxTabs} Tab presses`);
}

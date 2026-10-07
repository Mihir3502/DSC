import { readFileSync } from "node:fs";
import path from "node:path";
import { Client } from "pg";
import { routeManifest } from "../../../src/app/_security/route-manifest";
import {
  PASSWORD,
  readyCandidate,
  signIn,
  useDistinctClient,
} from "../support/candidate-auth";
import { acceptExpectedNotFound, expect, test } from "../support/fixtures";
import {
  STAFF_PASSWORD,
  activateStaff,
  staffFirstFactor,
  syntheticStaffEmail,
} from "../support/staff-auth";

// M1.7 §16 delivery-boundary rows that no earlier spec proves, against the
// production build and its own disposable PostgreSQL (Chromium, @critical):
// unsupported methods, cross-origin refusal for EVERY Server Action in the
// manifest, and staff routes refusing candidate, service, and password-only
// principals. Staff setup material appears on some pages, so traces,
// screenshots, and videos are off. Action IDs are never printed: failures
// name the reviewed manifest entry only.

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

/** Built Server Actions joined to their reviewed manifest entries. */
function builtActions() {
  // Playwright runs from the project root, after `pnpm build`.
  const file = path.join(
    process.cwd(),
    ".next/server/server-reference-manifest.json",
  );
  const node = (
    JSON.parse(readFileSync(file, "utf8")) as {
      node: Record<string, { filename?: string; exportedName?: string }>;
    }
  ).node;
  return Object.entries(node).map(([actionId, built]) => {
    const entry = routeManifest.find(
      (e) =>
        e.kind === "SERVER_ACTION" &&
        e.file === built.filename &&
        e.export === built.exportedName,
    );
    return { actionId, entry };
  });
}

test.describe("M1 gate delivery boundaries", { tag: "@critical" }, () => {
  test.describe.configure({ timeout: 90_000 });

  test("refuses unsupported methods on the auth surface and protected pages", async ({
    request,
  }) => {
    const targets = [
      "/api/auth/get-session",
      "/api/auth/sign-in/email",
      "/api/auth/sign-up/email",
      "/candidate/security",
      "/staff/security",
      "/sign-in",
    ];
    for (const target of targets) {
      for (const method of ["PUT", "PATCH", "DELETE"]) {
        const response = await request.fetch(target, {
          method,
          data: { email: "test.x@example.test", accountType: "STAFF" },
          maxRedirects: 0,
          failOnStatusCode: false,
        });
        const status = response.status();
        const audience = routeManifest.find(
          (e) => e.kind === "PAGE" && e.route === target,
        )?.audience;
        if (target.startsWith("/api/")) {
          // The closed auth surface refuses outright.
          expect(status, `${method} ${target}`).toBeGreaterThanOrEqual(400);
        } else if (audience === "PUBLIC") {
          // A public page may render for any method; it never mutates.
          expect([200, 404, 405], `${method} ${target}`).toContain(status);
        } else {
          // Pages never mutate: an unauthenticated non-GET is the same
          // guard redirect to a registered sign-in page (or a refusal).
          expect(
            status >= 400 ||
              (status === 307 &&
                ["/sign-in", "/staff/sign-in"].includes(
                  new URL(response.headers()["location"] ?? "/", "http://x")
                    .pathname,
                )),
            `${method} ${target} → ${status}`,
          ).toBe(true);
        }
        expect(
          response.headers()["set-cookie"] ?? "",
          `${method} ${target}`,
        ).not.toContain("psa.session_token");
      }
      const options = await request.fetch(target, {
        method: "OPTIONS",
        maxRedirects: 0,
        failOnStatusCode: false,
      });
      // No permissive cross-origin policy on any protected surface.
      expect(options.headers()["access-control-allow-origin"] ?? "").not.toBe(
        "*",
      );
      expect(
        options.headers()["access-control-allow-credentials"] ?? "",
      ).not.toBe("true");
    }
    const sessions = await adminQuery<{ n: number }>(
      "SELECT count(*)::int AS n FROM auth.user WHERE email = $1",
      ["test.x@example.test"],
    );
    expect(sessions[0]!.n).toBe(0);
  });

  test("refuses a cross-origin submission for every server action page", async ({
    request,
  }) => {
    const actions = builtActions();
    const manifestActions = routeManifest.filter(
      (e) => e.kind === "SERVER_ACTION",
    );
    expect(actions.length).toBe(manifestActions.length);
    for (const { actionId, entry } of actions) {
      expect(
        entry,
        "every built action is a reviewed manifest entry",
      ).toBeDefined();
      const response = await request.fetch(entry!.route!, {
        method: "POST",
        headers: {
          "next-action": actionId,
          origin: "https://evil.example.test",
          "content-type": "text/plain;charset=UTF-8",
        },
        data: "[]",
        maxRedirects: 0,
        failOnStatusCode: false,
      });
      expect(response.status(), entry!.id).toBeGreaterThanOrEqual(400);
      expect(response.headers()["set-cookie"] ?? "", entry!.id).not.toContain(
        "psa.session_token",
      );
    }
  });

  test("staff routes refuse candidate, service, and password-only principals", async ({
    page,
    guards,
  }) => {
    // Candidate: hidden, the same not-found as an unknown route.
    const email = await readyCandidate(page, "gate-candidate");
    await signIn(page, email);
    await expect(page).toHaveURL("/candidate/security");
    const hidden = await page.goto("/staff/security");
    expect(hidden?.status()).toBe(404);
    acceptExpectedNotFound(guards, 1);
    await page.context().clearCookies();

    // Service account: never an interactive session at the staff entry.
    const serviceEmail = syntheticStaffEmail("gate-service");
    await adminQuery(
      `INSERT INTO auth."user" (name, email, email_display, email_verified, account_type, status)
       VALUES ('TEST service', $1, $2, true, 'SERVICE', 'ACTIVE')`,
      [serviceEmail, serviceEmail],
    );
    await staffFirstFactor(page, serviceEmail, STAFF_PASSWORD);
    await expect(page.getByRole("main").getByRole("alert")).toBeVisible();
    expect(
      (await page.context().cookies()).some(
        (c) => c.name === "psa.session_token",
      ),
    ).toBe(false);

    // Password-only staff (MFA pending): no staff surface.
    const staff = await activateStaff(page, "gate-password-only");
    await page.context().clearCookies();
    await staffFirstFactor(page, staff.email, STAFF_PASSWORD);
    await expect(page).toHaveURL("/staff/mfa");
    await page.goto("/staff/security");
    await expect(page).toHaveURL("/staff/sign-in");
    void PASSWORD;
  });
});

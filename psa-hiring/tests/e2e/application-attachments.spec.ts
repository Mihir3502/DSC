import { randomBytes } from "node:crypto";
import type { Page } from "@playwright/test";
import { openCycle, startDraft } from "./support/application-draft";
import { useDistinctClient } from "./support/candidate-auth";
import { acceptExpectedRefusals, expect, test } from "./support/fixtures";
import { orgHarness, type Tree } from "./support/organization";

// M2.5 attachment journey (packet M2.5 §15, §18; AC-M2.5-03/04/X1). A candidate
// uploads, is told when a file is refused, downloads with safe headers, replaces
// and removes; direct requests from elsewhere get nothing. The malware sample
// is the harmless EICAR test string. Synthetic data only.

test.use({ trace: "off", screenshot: "off", video: "off" });

const suffix = () => randomBytes(3).toString("hex").toUpperCase();
const pdf = (text: string) => Buffer.from(`%PDF-1.7\n${text}\n`);
const EICAR = [
  "X5O!P%@AP[4\\PZX54(P^)7CC)7}",
  "$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*",
].join("");

async function attachmentsPage(page: Page, id: string, label: string) {
  const tree = await orgHarness<Tree>("provision", id);
  const ref = await openCycle(tree, id, `TEST Attach Caregiver ${id}`);
  const overview = await startDraft(page, ref, label);
  await page.getByRole("button", { name: "Begin application" }).click();
  await page.getByRole("link", { name: "Attachments" }).click();
  await expect(page).toHaveURL(`${overview}/attachments`);
  await expect(page).toHaveTitle(/^Application attachments/);
  return overview;
}

const choose = (page: Page, name: string, buffer: Buffer, mimeType: string) =>
  page.getByLabel("Choose a file").setInputFiles({ name, mimeType, buffer });
const send = (page: Page) =>
  page.getByRole("button", { name: "Upload file" }).click();

test.describe("application attachments @critical", () => {
  test("a candidate uploads, sees refusals, downloads safely, replaces, and removes @critical", async ({
    page,
    guards,
  }) => {
    test.setTimeout(120_000);
    await useDistinctClient(page);
    const overview = await attachmentsPage(page, suffix(), "attach");
    const main = page.getByRole("main");
    await expect(main).toContainText("You haven't added any files yet.");

    await choose(page, "TEST resume.pdf", pdf("TEST one"), "application/pdf");
    await send(page);
    await expect(main.getByRole("status")).toContainText("is ready");
    await expect(main).toContainText("TEST resume.pdf");
    await expect(main).toContainText("Status: Ready");
    expect(page.url()).not.toContain("resume");

    // A disguised file and malware are refused with a focused message.
    await choose(
      page,
      "TEST page.pdf",
      Buffer.from("<script>"),
      "application/pdf",
    );
    await send(page);
    const alert = main.getByRole("alert");
    await expect(alert).toBeFocused();
    await expect(alert).toContainText("don't match");
    await choose(page, "TEST macro.docx", pdf("x"), "application/msword");
    await send(page);
    await expect(alert).toContainText("Choose a PDF, JPEG, or PNG file.");
    await choose(page, "TEST sample.pdf", pdf(EICAR), "application/pdf");
    await send(page);
    await expect(alert).toContainText("may be unsafe");
    await expect(main).toContainText("Status: Not accepted");

    // The download is an attachment, uncached, typed, and sandboxed.
    const download = page
      .getByRole("listitem")
      .filter({ hasText: "TEST resume.pdf" })
      .getByRole("link", { name: /Download/ });
    const href = (await download.getAttribute("href"))!;
    const response = await page.request.get(href);
    expect(response.status()).toBe(200);
    const headers = response.headers();
    expect(headers["content-type"]).toBe("application/pdf");
    expect(headers["content-disposition"]).toMatch(/^attachment;/);
    expect(headers["cache-control"]).toContain("no-store");
    expect(headers["x-content-type-options"]).toBe("nosniff");
    expect(headers["content-security-policy"]).toContain("sandbox");
    expect((await response.body()).toString()).toContain("TEST one");

    // Replacing keeps the same entry; removing asks first.
    const row = page
      .getByRole("listitem")
      .filter({ hasText: "TEST resume.pdf" });
    await row.getByRole("button", { name: /Replace/ }).click();
    await expect(page.getByLabel("Choose a file")).toBeFocused();
    await choose(
      page,
      "TEST resume two.pdf",
      pdf("TEST two"),
      "application/pdf",
    );
    await send(page);
    const replaced = page
      .getByRole("listitem")
      .filter({ hasText: "TEST resume two.pdf" });
    await expect(replaced).toBeVisible();
    await replaced.getByRole("button", { name: /Remove/ }).click();
    await expect(
      replaced.getByRole("button", { name: "Confirm removal" }),
    ).toBeFocused();
    await replaced.getByRole("button", { name: "Keep this file" }).click();
    await expect(replaced).toBeVisible();
    await replaced.getByRole("button", { name: /Remove/ }).click();
    await replaced.getByRole("button", { name: "Confirm removal" }).click();
    await expect(main.getByRole("status")).toContainText("was removed");
    await expect(replaced).toBeHidden();

    // A removed file's old link is gone.
    const gone = await page.request.get(href);
    expect(gone.status()).toBe(404);
    expect(page.url()).toContain(overview);
    acceptExpectedRefusals(guards, [422]);
  });

  test("direct requests from elsewhere get nothing, and oversized or cross-site uploads are refused @critical", async ({
    page,
    browser,
    baseURL,
  }) => {
    test.setTimeout(120_000);
    await useDistinctClient(page);
    const overview = await attachmentsPage(page, suffix(), "attach-direct");
    await choose(page, "TEST held.pdf", pdf("TEST held"), "application/pdf");
    await send(page);
    await expect(page.getByRole("main").getByRole("status")).toContainText(
      "is ready",
    );
    const href = (await page
      .getByRole("link", { name: /Download/ })
      .getAttribute("href"))!;
    const upload = `/api${overview}/attachments/upload`;
    const multipart = {
      commandKey: "00000000-0000-4000-8000-000000000001",
      category: "RESUME",
      file: {
        name: "TEST x.pdf",
        mimeType: "application/pdf",
        buffer: pdf("x"),
      },
    };

    // Signed in, but the origin is another site.
    const crossSite = await page.request.post(upload, {
      headers: { origin: "https://evil.example.test" },
      multipart,
    });
    expect(crossSite.status()).toBe(403);

    // Signed in and same origin, but declaring more than the limit.
    const big = await page.request.post(upload, {
      headers: { origin: baseURL! },
      multipart: {
        ...multipart,
        file: {
          name: "TEST big.pdf",
          mimeType: "application/pdf",
          buffer: Buffer.alloc(11 * 1024 * 1024, 0x25),
        },
      },
    });
    expect(big.status()).toBe(413);

    // A file exactly at the advertised limit is accepted whole.
    const atLimit = Buffer.alloc(10 * 1024 * 1024, 0x20);
    atLimit.write("%PDF-1.7\n");
    const limit = await page.request.post(upload, {
      headers: { origin: baseURL! },
      multipart: {
        ...multipart,
        commandKey: "00000000-0000-4000-8000-000000000002",
        file: {
          name: "TEST limit.pdf",
          mimeType: "application/pdf",
          buffer: atLimit,
        },
      },
    });
    expect(limit.status()).toBe(200);
    expect(await limit.json()).toEqual({ result: "CLEAN" });

    // Unknown field: rejected as a whole.
    const injected = await page.request.post(upload, {
      headers: { origin: baseURL! },
      multipart: { ...multipart, scanStatus: "CLEAN" },
    });
    expect(injected.status()).toBe(400);

    // Nobody signed in.
    const anonymous = await browser.newContext({ baseURL: baseURL! });
    expect((await anonymous.request.get(href)).status()).toBe(401);
    expect(
      (
        await anonymous.request.post(upload, {
          headers: { origin: baseURL! },
          multipart,
        })
      ).status(),
    ).toBe(401);
    await anonymous.close();
  });
});

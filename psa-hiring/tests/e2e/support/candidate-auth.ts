import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { expect, type Page } from "@playwright/test";

// Browser-test helpers for candidate authentication. Email is read from the
// file capture written by the APP_ENV=test server into a private temp
// directory (see run-with-database.ts). Values are never logged.

const run = promisify(execFile);
// Playwright loads helpers as CommonJS; the runner starts it in the project root.
const projectRoot = process.cwd();

export const PASSWORD = "TEST e2e long passphrase 0001";
export const NEW_PASSWORD = "TEST e2e another passphrase 0002";

type CapturedEmail = {
  template: string;
  to: string;
  subject: string;
  text: string;
};

function captureDir(): string {
  const dir = process.env.E2E_EMAIL_CAPTURE_DIR;
  if (!dir) {
    throw new Error(
      "candidate-auth browser tests must run through tests/e2e/support/run-with-database.ts",
    );
  }
  return dir;
}

export function syntheticEmail(label: string): string {
  return `test.e2e.${label}.${randomBytes(4).toString("hex")}@example.test`;
}

function captured(to: string, template: string): CapturedEmail[] {
  return readdirSync(captureDir())
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map(
      (name) =>
        JSON.parse(
          readFileSync(path.join(captureDir(), name), "utf8"),
        ) as CapturedEmail,
    )
    .filter((m) => m.to === to && m.template === template);
}

/** Waits (bounded, polling the capture) for the nth email of a template. */
export async function waitForEmail(
  to: string,
  template: string,
  count = 1,
): Promise<CapturedEmail> {
  await expect
    .poll(() => captured(to, template).length, { timeout: 10_000 })
    .toBeGreaterThanOrEqual(count);
  return captured(to, template)[count - 1];
}

export async function verificationCode(to: string, count = 1) {
  const email = await waitForEmail(to, "EMAIL_VERIFICATION_CODE", count);
  return /code is: (\d+)/.exec(email.text)![1];
}

export async function resetLink(to: string, count = 1) {
  const email = await waitForEmail(to, "PASSWORD_RESET", count);
  return /(http:\/\/\S+\/reset-password#token=[A-Za-z0-9]+)/.exec(
    email.text,
  )![1];
}

export function emailCount(to: string, template: string): number {
  return captured(to, template).length;
}

/** A unique synthetic client per test keeps per-client limits independent. */
export async function useDistinctClient(page: Page) {
  await page.setExtraHTTPHeaders({
    "x-forwarded-for": `198.51.100.${randomBytes(2).readUInt16BE() % 250}-${randomBytes(4).toString("hex")}`,
  });
}

export async function register(page: Page, email: string) {
  await page.goto("/register");
  await page.getByLabel("Email address").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByLabel("Confirm password").fill(PASSWORD);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("main").getByRole("status")).toContainText(
    "Check your email",
  );
}

export async function verify(page: Page, email: string, code: string) {
  await page.goto("/verify-email");
  await page.getByLabel("Email address").fill(email);
  await page.getByLabel("Verification code").fill(code);
  await page.getByRole("button", { name: "Verify email" }).click();
}

export async function signIn(page: Page, email: string, password = PASSWORD) {
  await page.goto("/sign-in");
  await page.getByLabel("Email address").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
}

/** Registers, verifies, and returns a ready candidate email. */
export async function readyCandidate(page: Page, label: string) {
  const email = syntheticEmail(label);
  await register(page, email);
  await verify(page, email, await verificationCode(email));
  await expect(page.getByRole("main").getByRole("status")).toContainText(
    "Email verified",
  );
  return email;
}

/** Issues an invitation through the local/test-only script. */
export async function issueInvitation(email: string): Promise<string> {
  const { stdout } = await run(
    path.join(projectRoot, "node_modules/.bin/tsx"),
    [
      "--conditions=react-server",
      "scripts/auth/issue-candidate-invitation.ts",
      email,
    ],
    { cwd: projectRoot, env: process.env, timeout: 60_000 },
  );
  return stdout.trim();
}

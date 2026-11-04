import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { chromium, type Browser, type Page } from "@playwright/test";
import { totpCode } from "../../fixtures/auth/totp";
import { startOwnedPostgres } from "../../integration/support/container";
import {
  buildHarnessEnv,
  createOwnedDatabase,
  dropOwnedDatabase,
  runDbScript,
} from "../../integration/support/harness";
import {
  completeRequiredSections,
  openCycle,
  startDraft,
} from "./application-draft";
import { useDistinctClient as giveDistinctClient } from "./candidate-auth";
import { orgHarness, type Tree } from "./organization";
import {
  activateStaff,
  staffSignIn,
  STAFF_PASSWORD,
  type ActivatedStaff,
} from "./staff-auth";

// A throwaway demo of the staff work queue, for clicking through by hand.
//
//   pnpm exec tsx --conditions=react-server tests/e2e/support/demo-server.ts
//     (Ctrl+C to stop; add --check to set up and then exit)
//
// It starts its own disposable PostgreSQL and runs the production build with
// APP_ENV=test on port 3100, the only environment where the role-assignment
// harness is allowed (ADR-0005). It never reads or writes the local database,
// and everything is deleted on exit. All data goes through the real commands
// and real pages. Every value is synthetic, and the printed passwords and keys
// are for accounts that stop existing when this exits.

const projectRoot = path.resolve(import.meta.dirname, "../../..");
const baseURL = "http://127.0.0.1:3100";

async function waitForServer(server: ChildProcess) {
  for (let i = 0; i < 360; i += 1) {
    if (server.exitCode !== null) throw new Error("the demo server stopped");
    const up = await fetch(`${baseURL}/`).then(
      (response) => response.ok,
      () => false,
    );
    if (up) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("the demo server didn't start in time");
}

async function submitApplication(page: Page, overview: string) {
  await page.goto(`${overview}/review`);
  await page.getByLabel("I certify the statement above.").check();
  await page.getByLabel("Type your full name").fill("TEST Ada Example");
  await page.getByRole("button", { name: "Submit application" }).click();
  await page.getByRole("button", { name: "Confirm and submit" }).click();
  await page.waitForURL(`**${overview}/submitted`);
}

/** A verified candidate with a draft; optionally completed and submitted. */
async function candidate(
  browser: Browser,
  ref: string,
  label: string,
  submit: boolean,
): Promise<string> {
  const context = await browser.newContext({ baseURL });
  const page = await context.newPage();
  await giveDistinctClient(page);
  const overview = await startDraft(page, ref, label);
  await page.getByRole("button", { name: "Begin application" }).click();
  await page.getByRole("link", { name: "Review and submit" }).waitFor();
  if (submit) {
    await completeRequiredSections(page, overview);
    await submitApplication(page, overview);
  }
  await context.close();
  return overview.split("/").pop()!;
}

async function staffMember(
  browser: Browser,
  label: string,
  role: string,
  scopeType: string,
  scope: string,
): Promise<ActivatedStaff> {
  const context = await browser.newContext({ baseURL });
  const page = await context.newPage();
  const member = await activateStaff(page, label);
  await orgHarness("grant", member.email, role, scopeType, scope);
  await context.close();
  return member;
}

async function returnForCorrection(
  browser: Browser,
  recruiter: ActivatedStaff,
  candidacy: string,
) {
  const context = await browser.newContext({ baseURL });
  const page = await context.newPage();
  await staffSignIn(page, recruiter);
  await page.goto(`/staff/candidates/${candidacy}/application`);
  await page.getByRole("checkbox", { name: "Availability" }).check();
  await page
    .getByLabel("Reason (the candidate sees this)")
    .selectOption("OTHER");
  await page
    .getByLabel("Instructions (the candidate sees this)")
    .fill("TEST please check your availability.");
  await page.getByRole("button", { name: "Return for correction" }).click();
  await page.getByRole("button", { name: "Confirm return" }).click();
  await page
    .getByRole("main")
    .getByRole("status")
    .filter({ hasText: "Application returned" })
    .waitFor();
  await context.close();
}

async function main() {
  const check = process.argv.includes("--check");
  console.log("Starting a temporary database…");
  const owned = await startOwnedPostgres();
  const captureDir = mkdtempSync(path.join(os.tmpdir(), "psa-demo-mail-"));
  let databaseName: string | undefined;
  let server: ChildProcess | undefined;
  let browser: Browser | undefined;
  const cleanup = async () => {
    await browser?.close().catch(() => {});
    if (server?.pid) {
      try {
        process.kill(-server.pid, "SIGTERM");
      } catch {
        // Already stopped.
      }
    }
    if (databaseName) {
      await dropOwnedDatabase(owned.context, databaseName).catch(() => {});
    }
    await owned.stop().catch(() => {});
    rmSync(captureDir, { recursive: true, force: true });
  };
  try {
    const database = await createOwnedDatabase(owned.context, "demo");
    databaseName = database.name;
    const harnessEnv = buildHarnessEnv(database);
    for (const step of [
      "bootstrap",
      "migrate",
      "bootstrap",
      "catalog",
    ] as const) {
      const result = await runDbScript(step, harnessEnv);
      if (result.code !== 0) throw new Error(`database ${step} failed`);
    }
    // `next build` and `next start` manage NODE_ENV themselves.
    const { NODE_ENV: _nodeEnv, ...serverEnv } = harnessEnv;
    void _nodeEnv;
    Object.assign(process.env, serverEnv, {
      APP_ENV: "test",
      BETTER_AUTH_SECRET: `TEST-demo-${randomBytes(24).toString("hex")}`,
      AUTH_EMAIL_TRANSPORT: "capture-file",
      AUTH_EMAIL_CAPTURE_DIR: captureDir,
      E2E_EMAIL_CAPTURE_DIR: captureDir,
      NEXT_TELEMETRY_DISABLED: "1",
    });

    console.log("Building and starting the app (about a minute)…");
    server = spawn(
      "sh",
      [
        "-c",
        "pnpm build && pnpm exec next start --hostname 127.0.0.1 --port 3100",
      ],
      {
        cwd: projectRoot,
        env: process.env,
        stdio: "ignore",
        detached: true,
      },
    );
    await waitForServer(server);

    console.log("Creating synthetic staff and candidates (a few minutes)…");
    const id = randomBytes(3).toString("hex").toUpperCase();
    const tree = await orgHarness<Tree>("provision", id);
    browser = await chromium.launch();
    const caregiver = await openCycle(tree, id, `TEST Caregiver ${id}`);
    const companion = await openCycle(tree, `${id}B`, `TEST Companion ${id}`);

    const manager = await staffMember(
      browser,
      "manager",
      "PSA_MANAGER",
      "ORGANIZATION",
      tree.org,
    );
    const recruiter = await staffMember(
      browser,
      "recruiter",
      "RECRUITER",
      "BRANCH",
      tree.branch,
    );
    const hr = await staffMember(
      browser,
      "hr",
      "HR_SPECIALIST",
      "ORGANIZATION",
      tree.org,
    );

    const returned = await candidate(browser, caregiver, "demo-a", true);
    await candidate(browser, caregiver, "demo-b", true);
    await candidate(browser, companion, "demo-c", true);
    await candidate(browser, caregiver, "demo-d", false);
    await candidate(browser, companion, "demo-e", false);
    await returnForCorrection(browser, recruiter, returned);
    await browser.close();
    browser = undefined;

    const accounts = [
      ["PSA Manager (can assign others)", manager],
      ["Recruiter (can claim and set due dates)", recruiter],
      ["HR Specialist (read only here)", hr],
    ] as const;
    console.log(`
Ready: ${baseURL}/staff/sign-in
Use 127.0.0.1 as shown, not localhost, in a private browser window.

Password for every account: ${STAFF_PASSWORD}
`);
    for (const [label, member] of accounts) {
      console.log(`${label}\n  ${member.email}`);
    }
    if (check) return;

    console.log(`
You don't need an authenticator app: press Enter here for each account's
current 6-digit code. A code works once, so wait for a new one if it's refused.
Candidates in the queue: 3 submitted (1 returned for correction), 2 in progress.
Press Ctrl+C to stop. Everything is deleted when it stops.
`);
    const prompt = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    await new Promise<void>((resolve) => {
      process.once("SIGINT", () => resolve());
      process.once("SIGTERM", () => resolve());
      prompt.on("close", () => resolve());
      prompt.on("line", () => {
        void Promise.all(
          accounts.map(async ([label, member]) => {
            const code = await totpCode(member.authenticator.secret, 0);
            return `${code}  ${label}`;
          }),
        ).then((lines) => console.log(lines.join("\n")));
      });
    });
    prompt.close();
  } finally {
    console.log("Deleting the demo…");
    await cleanup();
  }
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    console.error(`demo: ${String((error as Error).message).split("\n")[0]}`);
    process.exit(1);
  },
);

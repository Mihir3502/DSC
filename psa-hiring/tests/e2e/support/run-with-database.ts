import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { startOwnedPostgres } from "../../integration/support/container";
import {
  adminClient,
  assertNoSecrets,
  buildHarnessEnv,
  createOwnedDatabase,
  dropOwnedDatabase,
  runDbScript,
} from "../../integration/support/harness";

// Runs Playwright against a production build backed by its own disposable
// PostgreSQL (packet M1.2 §16.6). Starts an owned container, applies the
// real bootstrap → migrate → bootstrap sequence, points the server at it
// with APP_ENV=test, and captures auth email as files in a private temp
// directory (outside Playwright report/trace folders). Everything is
// removed afterwards. Arguments are passed through to `playwright test`.
//
// M1.7 §20: before cleanup, the Playwright/server output, every captured
// email file, and every durable audit/security row are scanned for
// prohibited synthetic values. A hit fails the run and reports only the
// category and location, never the value.

/** Category → predicate; never returns or prints the matched value. */
function leakCategories(
  text: string,
  secrets: Readonly<Record<string, string>>,
  rules: Readonly<Record<string, RegExp>>,
): string[] {
  const found: string[] = [];
  for (const [category, value] of Object.entries(secrets)) {
    if (value && text.includes(value)) found.push(category);
  }
  for (const [category, pattern] of Object.entries(rules)) {
    if (pattern.test(text)) found.push(category);
  }
  return found;
}

const outputRules = {
  canary: /TESTCANARY/,
  sessionCookie: /psa\.(session_token|two_factor)=[A-Za-z0-9]/,
  totpSeed: /otpauth:\/\//,
  testPassphrase: /TEST e2e (staff )?(long |another )?passphrase/,
};
const mailRules = {
  canary: /TESTCANARY/,
  sessionCookie: /psa\.(session_token|two_factor)=/,
  totpSeed: /otpauth:\/\//,
  testPassphrase: /TEST e2e (staff )?(long |another )?passphrase/,
};
const auditRules = {
  ...mailRules,
  email: /@example\.test/,
  ipAddress: /\b198\.51\.100\.\d+/,
  userAgent: /Mozilla\/5\.0/,
  invitationOrResetLink: /#(invite|token)=/,
};

const projectRoot = path.resolve(import.meta.dirname, "../../..");

async function main() {
  const owned = await startOwnedPostgres();
  const captureDir = mkdtempSync(path.join(os.tmpdir(), "psa-e2e-mail-"));
  let databaseName: string | undefined;
  let exitCode = 1;
  try {
    const database = await createOwnedDatabase(owned.context, "e2e");
    databaseName = database.name;
    const harnessEnv = buildHarnessEnv(database);
    // M2.1: the reviewed authorization catalog (version 2) is applied as
    // in every deployment, so business permissions decide real requests.
    for (const step of [
      "bootstrap",
      "migrate",
      "bootstrap",
      "catalog",
    ] as const) {
      const result = await runDbScript(step, harnessEnv);
      assertNoSecrets(owned.context, result.output);
      if (result.code !== 0) throw new Error(`database ${step} failed`);
    }

    // `next build`/`next start` manage NODE_ENV themselves.
    const { NODE_ENV: _nodeEnv, ...serverEnv } = harnessEnv;
    void _nodeEnv;
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...serverEnv,
      // A fresh random secret per run (test marker allowed only in test).
      BETTER_AUTH_SECRET: `TEST-e2e-${randomBytes(24).toString("hex")}`,
      AUTH_EMAIL_TRANSPORT: "capture-file",
      // M1.3: short, test-only lockout and recent-auth windows so browser
      // tests observe recovery and expiry (rejected outside APP_ENV=test).
      AUTH_STAFF_MFA_LOCKOUT_SECONDS: "5",
      AUTH_STAFF_RECENT_AUTH_SECONDS: "20",
      AUTH_EMAIL_CAPTURE_DIR: captureDir,
      E2E_EMAIL_CAPTURE_DIR: captureDir,
    };
    const output: string[] = [];
    exitCode = await new Promise<number>((resolve) => {
      const child = spawn(
        path.join(projectRoot, "node_modules/.bin/playwright"),
        ["test", ...process.argv.slice(2)],
        { cwd: projectRoot, env, stdio: ["inherit", "pipe", "pipe"] },
      );
      child.stdout.on("data", (chunk: Buffer) => {
        output.push(chunk.toString("utf8"));
        process.stdout.write(chunk);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        output.push(chunk.toString("utf8"));
        process.stderr.write(chunk);
      });
      child.on("exit", (code) => resolve(code ?? 1));
      child.on("error", () => resolve(1));
    });

    const secrets = {
      authSecret: env.BETTER_AUTH_SECRET!,
      adminPassword: owned.context.adminPassword,
      appPassword: owned.context.appPassword,
      migratorPassword: owned.context.migratorPassword,
    };
    const leaks: string[] = [];
    for (const c of leakCategories(output.join(""), secrets, outputRules)) {
      leaks.push(`playwright/server output: ${c}`);
    }
    for (const name of readdirSync(captureDir)) {
      const text = readFileSync(path.join(captureDir, name), "utf8");
      for (const c of leakCategories(text, secrets, mailRules)) {
        leaks.push(`captured email: ${c}`);
      }
    }
    const admin = await adminClient(owned.context, database.name);
    try {
      const { rows } = await admin.query<{ t: string }>(
        `SELECT coalesce((SELECT string_agg(e::text, E'\\n') FROM audit.audit_event e), '')
             || coalesce((SELECT string_agg(s::text, E'\\n') FROM audit.security_event s), '') AS t`,
      );
      for (const c of leakCategories(rows[0]?.t ?? "", secrets, auditRules)) {
        leaks.push(`audit/security rows: ${c}`);
      }
    } finally {
      await admin.end();
    }
    if (leaks.length > 0) {
      console.error(
        `e2e leakage scan failed: ${[...new Set(leaks)].join("; ")}`,
      );
      exitCode = 1;
    } else {
      console.log(
        "e2e leakage scan passed (output, captured email, audit/security rows).",
      );
    }
  } finally {
    if (databaseName) {
      await dropOwnedDatabase(owned.context, databaseName).catch(() => {});
    }
    await owned.stop().catch(() => {});
    rmSync(captureDir, { recursive: true, force: true });
  }
  process.exitCode = exitCode;
}

main().catch((error: unknown) => {
  console.error(`e2e: ${String((error as Error).message).split("\n")[0]}`);
  process.exitCode = 1;
});

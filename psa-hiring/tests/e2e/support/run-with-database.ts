import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { startOwnedPostgres } from "../../integration/support/container";
import {
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
    for (const step of ["bootstrap", "migrate", "bootstrap"] as const) {
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
    exitCode = await new Promise<number>((resolve) => {
      const child = spawn(
        path.join(projectRoot, "node_modules/.bin/playwright"),
        ["test", ...process.argv.slice(2)],
        { cwd: projectRoot, env, stdio: "inherit" },
      );
      child.on("exit", (code) => resolve(code ?? 1));
      child.on("error", () => resolve(1));
    });
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

import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

// Schema-drift guard (packet M1.1 §18.12). Fails if the committed TypeScript
// schema and the committed migration snapshots disagree, i.e. a schema change
// was made without generating and committing its migration. It never deletes
// or reverts files: if drift exists, the generated migration is left in
// drizzle/ for review and the check fails.

const run = promisify(execFile);
const root = path.resolve(import.meta.dirname, "../..");
const kit = path.join(root, "node_modules/.bin/drizzle-kit");

async function main() {
  const env = { ...process.env };
  delete env.DATABASE_MIGRATION_URL; // generate/check need no connection

  // Migration folder consistency (journal, snapshots, ordering).
  await run(kit, ["check"], { cwd: root, env });

  const { stdout, stderr } = await run(
    kit,
    ["generate", "--name=drift_check"],
    {
      cwd: root,
      env,
    },
  );
  const output = `${stdout}\n${stderr}`;
  if (/No schema changes/i.test(output)) {
    console.log("db:check-drift passed (schema matches committed migrations).");
    return;
  }
  console.error(
    "db:check-drift failed: the TypeScript schema differs from the committed migrations.\n" +
      "A new migration was generated in drizzle/ for review. Review it, rename it,\n" +
      "and commit it with the schema change (never use drizzle-kit push).",
  );
  process.exitCode = 1;
}

main().catch((error: unknown) => {
  const message = String((error as Error).message ?? error).split("\n")[0];
  console.error(`db:check-drift: drizzle-kit failed (${message})`);
  process.exitCode = 1;
});

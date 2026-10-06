import { execFile } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { promisify } from "node:util";

// Verifies local PostgreSQL and Mailpit. Uses bounded timeouts, prints no
// credentials, and needs no PostgreSQL driver (that arrives in M0.3).

const run = promisify(execFile);
const projectRoot = path.resolve(import.meta.dirname, "..");
const timeoutMs = 5000;

const postgresPort = Number(process.env.POSTGRES_HOST_PORT ?? 5432);
const mailpitUiPort = Number(process.env.MAILPIT_UI_HOST_PORT ?? 8025);

type Check = { name: string; run: () => Promise<void> };

async function compose(...args: string[]) {
  return run("docker", ["compose", ...args], {
    cwd: projectRoot,
    timeout: timeoutMs,
  });
}

async function servicesHealthy() {
  const { stdout } = await compose("ps", "--format", "json");
  const rows = stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { Service: string; Health: string });
  for (const service of ["postgres", "mailpit"]) {
    const row = rows.find((r) => r.Service === service);
    if (!row) throw new Error(`${service} is not running (run pnpm infra:up)`);
    if (row.Health !== "healthy") {
      throw new Error(`${service} health is "${row.Health || "unknown"}"`);
    }
  }
}

async function postgresReady() {
  await compose(
    "exec",
    "-T",
    "postgres",
    "sh",
    "-c",
    'pg_isready -q -U "$POSTGRES_USER" -d "$POSTGRES_DB"',
  );
}

function postgresPortOpen() {
  return new Promise<void>((resolve, reject) => {
    const socket = net.connect({ host: "127.0.0.1", port: postgresPort });
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => {
      socket.end();
      resolve();
    });
    socket.once("timeout", () => {
      socket.destroy();
      reject(new Error(`timed out connecting to 127.0.0.1:${postgresPort}`));
    });
    socket.once("error", () =>
      reject(new Error(`cannot connect to 127.0.0.1:${postgresPort}`)),
    );
  });
}

async function mailpitReady() {
  const url = `http://127.0.0.1:${mailpitUiPort}/readyz`;
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
}

const checks: Check[] = [
  { name: "Docker Compose services healthy", run: servicesHealthy },
  { name: "PostgreSQL pg_isready", run: postgresReady },
  { name: `PostgreSQL port 127.0.0.1:${postgresPort}`, run: postgresPortOpen },
  { name: `Mailpit /readyz on 127.0.0.1:${mailpitUiPort}`, run: mailpitReady },
];

async function main() {
  let failed = false;
  for (const check of checks) {
    try {
      await check.run();
      console.log(`ok    ${check.name}`);
    } catch (error) {
      failed = true;
      const reason =
        (error as NodeJS.ErrnoException).code === "ENOENT"
          ? "docker command not found (is Docker Desktop running and on PATH?)"
          : (error as Error).message.split("\n")[0];
      console.error(`FAIL  ${check.name}: ${reason}`);
    }
  }

  if (failed) {
    console.error("Infrastructure check failed. See README troubleshooting.");
    process.exit(1);
  }
  console.log("Local infrastructure is healthy.");
}

void main();

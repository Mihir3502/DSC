import { Client } from "pg";
import { ServerEnvError } from "../../../src/config/env-schema";

// Shared helpers for database scripts. Output never contains connection
// strings or passwords.

type PgLikeError = Error & { code?: string; cause?: unknown };

/** Returns the PostgreSQL SQLSTATE from a pg or Drizzle-wrapped error. */
export function pgErrorCode(error: unknown): string | undefined {
  const e = error as PgLikeError | undefined;
  return e?.code ?? (e?.cause as PgLikeError | undefined)?.code;
}

/** A one-line, credential-free description of an error. */
export function describeError(error: unknown): string {
  if (error instanceof ServerEnvError) return error.message;
  const e = error as PgLikeError;
  const root = (e?.cause as PgLikeError | undefined) ?? e;
  const code = pgErrorCode(error);
  const message = String(root?.message ?? error)
    .split("\n")[0]
    .replace(/postgres(ql)?:\/\/\S+/gi, "<redacted-url>")
    .replace(/password=\S+/gi, "password=<redacted>");
  return code ? `${message} (${code})` : message;
}

/**
 * Runs a script body. Failures set a nonzero exit code; the process then
 * exits naturally, which also proves every pool/client was closed.
 */
export async function runScript(
  name: string,
  main: () => Promise<void>,
): Promise<void> {
  try {
    await main();
  } catch (error) {
    console.error(`${name} failed: ${describeError(error)}`);
    process.exitCode = 1;
  }
}

/** Opens a single tool connection. The caller must end it in `finally`. */
export async function connectTool(options: {
  url: string;
  applicationName: string;
  timeoutMs: number;
}): Promise<Client> {
  const client = new Client({
    connectionString: options.url,
    connectionTimeoutMillis: options.timeoutMs,
    application_name: options.applicationName,
    options: "-c TimeZone=UTC",
  });
  client.on("error", () => {
    // Connection-level errors surface through the awaited query instead.
  });
  await client.connect();
  return client;
}

/** Returns `url` pointing at another database on the same server. */
export function withDatabase(url: string, database: string): string {
  const next = new URL(url);
  next.pathname = `/${encodeURIComponent(database)}`;
  return next.toString();
}

export class CheckFailure extends Error {}

export function assertCheck(condition: unknown, message: string): void {
  if (!condition) throw new CheckFailure(message);
}

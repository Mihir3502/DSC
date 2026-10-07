// SQLSTATE extraction for application code that must classify a database
// failure (conflict, serialization, constraint) without ever surfacing the
// raw error, SQL, or bound values. Mirrors scripts/db/lib/tooling.ts.

type PgLikeError = { code?: unknown; cause?: unknown };

/** The PostgreSQL SQLSTATE from a pg or Drizzle-wrapped error, if any. */
export function pgErrorCode(error: unknown): string | undefined {
  const e = error as PgLikeError | undefined;
  const code = e?.code ?? (e?.cause as PgLikeError | undefined)?.code;
  return typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)
    ? code
    : undefined;
}

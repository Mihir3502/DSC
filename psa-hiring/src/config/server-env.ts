import "server-only";
import { parseServerEnv, type ServerEnv } from "./env-schema";

export type { ServerEnv };

let cached: ServerEnv | undefined;

/**
 * Returns the validated server configuration. Parsed on first call rather
 * than at import time so Next.js build phases do not require runtime values.
 */
export function getServerEnv(): ServerEnv {
  cached ??= parseServerEnv(process.env);
  return cached;
}

import { z } from "zod";

// Single source of truth for server configuration. Imported by the
// server-only accessor (src/config/server-env.ts) and by the scripts in
// scripts/. Do not import this from client components.

const appEnvs = ["local", "test", "staging", "production"] as const;
const providerModes = ["fake", "production"] as const;

// Reserved domains that can never deliver real mail (RFC 2606 / RFC 6761).
const reservedMailDomain =
  /(^|\.)(test|example|invalid|localhost)$|^example\.(com|net|org)$/i;

const serverEnvSchema = z
  .object({
    APP_ENV: z.enum(appEnvs, {
      error: `must be one of: ${appEnvs.join(", ")}`,
    }),
    DATABASE_URL: z
      .string({ error: "is required" })
      .min(1, { error: "is required" })
      .refine(isPostgresUrl, {
        error: "must be a postgres:// or postgresql:// URL",
      }),
    SMTP_HOST: z
      .string({ error: "is required" })
      .trim()
      .min(1, { error: "is required" }),
    SMTP_PORT: z.coerce
      .number({ error: "must be an integer between 1 and 65535" })
      .int({ error: "must be an integer between 1 and 65535" })
      .min(1, { error: "must be an integer between 1 and 65535" })
      .max(65535, { error: "must be an integer between 1 and 65535" }),
    SMTP_FROM: z.email({ error: "must be a valid email address" }),
    DOCUMENT_STORAGE_ROOT: z
      .string({ error: "is required" })
      .trim()
      .min(1, { error: "is required" }),
    PROVIDER_MODE: z.enum(providerModes, {
      error: `must be one of: ${providerModes.join(", ")}`,
    }),
  })
  .superRefine((env, ctx) => {
    const fail = (path: keyof typeof env, message: string) =>
      ctx.addIssue({ code: "custom", path: [path], message });

    if (env.APP_ENV === "production") {
      if (env.PROVIDER_MODE === "fake") {
        fail("PROVIDER_MODE", "fake providers are not allowed in production");
      }
      if (isLoopbackHost(urlHostname(env.DATABASE_URL))) {
        fail("DATABASE_URL", "must not point to a loopback host in production");
      }
      if (isLoopbackHost(env.SMTP_HOST)) {
        fail("SMTP_HOST", "must not be a loopback host in production");
      }
      if (isRepositoryLocalPath(env.DOCUMENT_STORAGE_ROOT)) {
        fail(
          "DOCUMENT_STORAGE_ROOT",
          "must not be a relative or repository-local (.local) path in production",
        );
      }
    } else if (!reservedMailDomain.test(env.SMTP_FROM.split("@")[1] ?? "")) {
      fail(
        "SMTP_FROM",
        "must use a reserved test domain (for example example.test) outside production",
      );
    }
  });

export type ServerEnv = Readonly<z.infer<typeof serverEnvSchema>>;

export class ServerEnvError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(
      `Invalid server configuration:\n${problems.map((p) => `  - ${p}`).join("\n")}`,
    );
    this.name = "ServerEnvError";
    this.problems = problems;
  }
}

/**
 * Validates configuration from an explicit input (normally process.env).
 * Errors name the variable and the rule only; input values are never echoed.
 */
export function parseServerEnv(
  input: Record<string, string | undefined>,
): ServerEnv {
  const result = serverEnvSchema.safeParse(input);
  if (!result.success) {
    const problems = result.error.issues.map(
      (issue) => `${issue.path.join(".") || "(root)"} ${issue.message}`,
    );
    throw new ServerEnvError([...new Set(problems)]);
  }
  return Object.freeze({ ...result.data });
}

function isPostgresUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === "postgres:" || url.protocol === "postgresql:") &&
      url.hostname.length > 0
    );
  } catch {
    return false;
  }
}

function urlHostname(value: string): string {
  try {
    return new URL(value).hostname;
  } catch {
    return "";
  }
}

export function isLoopbackHost(host: string): boolean {
  const h = host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  return (
    h === "localhost" ||
    h.endsWith(".localhost") ||
    h === "::1" ||
    h === "0.0.0.0" ||
    /^127(\.\d{1,3}){3}$/.test(h)
  );
}

function isRepositoryLocalPath(value: string): boolean {
  const normalized = value.trim().replace(/\\/g, "/");
  const isAbsolute =
    normalized.startsWith("/") || /^[a-zA-Z]:\//.test(normalized);
  return !isAbsolute || normalized.split("/").includes(".local");
}

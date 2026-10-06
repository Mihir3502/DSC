import { z } from "zod";

// Single source of truth for server and tool configuration. Imported by the
// server-only accessor (src/config/server-env.ts) and by the scripts in
// scripts/. Do not import this from client components.
//
// Three separate schemas keep database identities apart:
// - runtime (web/worker): DATABASE_URL only
// - migration tools: DATABASE_MIGRATION_URL only (never falls back)
// - local bootstrap: DATABASE_ADMIN_URL, local/test environments only

const appEnvs = ["local", "test", "staging", "production"] as const;
const providerModes = ["fake", "production"] as const;

// Fixed, reviewed local role names created by scripts/db/bootstrap-local.ts.
export const localDatabaseRoles = {
  migrator: "psa_migrator",
  app: "psa_app",
} as const;

// Reserved domains that can never deliver real mail (RFC 2606 / RFC 6761).
const reservedMailDomain =
  /(^|\.)(test|example|invalid|localhost)$|^example\.(com|net|org)$/i;

const appEnv = z.enum(appEnvs, {
  error: `must be one of: ${appEnvs.join(", ")}`,
});

const postgresUrl = () =>
  z
    .string({ error: "is required" })
    .min(1, { error: "is required" })
    .refine(isPostgresUrl, {
      error: "must be a postgres:// or postgresql:// URL with a user and host",
    });

const boundedInt = (min: number, max: number, fallback: number) => {
  const message = `must be an integer between ${min} and ${max}`;
  return z.coerce
    .number({ error: message })
    .int({ error: message })
    .min(min, { error: message })
    .max(max, { error: message })
    .default(fallback);
};

const connectionTimeout = boundedInt(500, 30_000, 5_000);

const serverEnvSchema = z
  .object({
    APP_ENV: appEnv,
    DATABASE_URL: postgresUrl(),
    DATABASE_POOL_MAX: boundedInt(1, 20, 5),
    DATABASE_CONNECTION_TIMEOUT_MS: connectionTimeout,
    DATABASE_IDLE_TIMEOUT_MS: boundedInt(1_000, 300_000, 10_000),
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

const migrationEnvSchema = z.object({
  APP_ENV: appEnv,
  DATABASE_MIGRATION_URL: postgresUrl(),
  DATABASE_CONNECTION_TIMEOUT_MS: connectionTimeout,
});

const localBootstrapEnvSchema = z
  .object({
    APP_ENV: z.enum(["local", "test"], {
      error: "must be local or test; local database bootstrap is refused",
    }),
    DATABASE_ADMIN_URL: postgresUrl(),
    DATABASE_MIGRATION_URL: postgresUrl(),
    DATABASE_URL: postgresUrl(),
    DATABASE_CONNECTION_TIMEOUT_MS: connectionTimeout,
  })
  .superRefine((env, ctx) => {
    const fail = (path: keyof typeof env, message: string) =>
      ctx.addIssue({ code: "custom", path: [path], message });
    const admin = databaseUrlParts(env.DATABASE_ADMIN_URL);
    const migrator = databaseUrlParts(env.DATABASE_MIGRATION_URL);
    const app = databaseUrlParts(env.DATABASE_URL);

    for (const [key, parts] of [
      ["DATABASE_ADMIN_URL", admin],
      ["DATABASE_MIGRATION_URL", migrator],
      ["DATABASE_URL", app],
    ] as const) {
      if (!isLoopbackHost(parts.host)) {
        fail(key, "must point to a loopback host for local bootstrap");
      }
      if (!parts.password) fail(key, "must include a password");
    }
    if (migrator.user !== localDatabaseRoles.migrator) {
      fail(
        "DATABASE_MIGRATION_URL",
        `must use the ${localDatabaseRoles.migrator} role`,
      );
    }
    if (app.user !== localDatabaseRoles.app) {
      fail("DATABASE_URL", `must use the ${localDatabaseRoles.app} role`);
    }
    if (admin.user === migrator.user || admin.user === app.user) {
      fail("DATABASE_ADMIN_URL", "must use a role distinct from migrator/app");
    }
    if (
      new Set(
        [admin, migrator, app].map((p) => `${p.host}:${p.port}/${p.database}`),
      ).size !== 1
    ) {
      fail(
        "DATABASE_URL",
        "admin, migration, and app URLs must target the same host, port, and database",
      );
    }
  });

export type ServerEnv = Readonly<z.infer<typeof serverEnvSchema>>;
export type MigrationEnv = Readonly<z.infer<typeof migrationEnvSchema>>;
export type LocalBootstrapEnv = Readonly<
  z.infer<typeof localBootstrapEnvSchema>
>;

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

type EnvInput = Record<string, string | undefined>;

function parseWith<T extends object>(
  schema: z.ZodType<T>,
  input: EnvInput,
  extraProblems: string[] = [],
): Readonly<T> {
  const result = schema.safeParse(input);
  const problems = result.success
    ? []
    : result.error.issues.map(
        (issue) => `${issue.path.join(".") || "(root)"} ${issue.message}`,
      );
  problems.push(...extraProblems);
  if (!result.success || problems.length > 0) {
    throw new ServerEnvError([...new Set(problems)]);
  }
  return Object.freeze({ ...result.data });
}

/**
 * Validates runtime configuration from an explicit input (normally
 * process.env). Errors name the variable and the rule only; input values are
 * never echoed. Runtime never requires the migration or admin URLs, but if
 * they are present they must not reuse the runtime role.
 */
export function parseServerEnv(input: EnvInput): ServerEnv {
  const runtimeUser = databaseUrlParts(input.DATABASE_URL ?? "").user;
  const extra: string[] = [];
  for (const key of ["DATABASE_MIGRATION_URL", "DATABASE_ADMIN_URL"]) {
    const value = input[key];
    if (runtimeUser && value && databaseUrlParts(value).user === runtimeUser) {
      extra.push(`DATABASE_URL must use a different database role than ${key}`);
    }
  }
  return parseWith(serverEnvSchema, input, extra);
}

/** Validates configuration for migration tools. Never reads DATABASE_URL. */
export function parseMigrationEnv(input: EnvInput): MigrationEnv {
  return parseWith(migrationEnvSchema, input);
}

/** Validates configuration for local role bootstrap (local/test only). */
export function parseLocalBootstrapEnv(input: EnvInput): LocalBootstrapEnv {
  return parseWith(localBootstrapEnvSchema, input);
}

export type DatabaseUrlParts = {
  user: string;
  password: string;
  host: string;
  port: string;
  database: string;
};

/** Splits a database URL. Callers must never log the password. */
export function databaseUrlParts(value: string): DatabaseUrlParts {
  try {
    const url = new URL(value);
    return {
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      host: url.hostname,
      port: url.port || "5432",
      database: decodeURIComponent(url.pathname.replace(/^\//, "")),
    };
  } catch {
    return { user: "", password: "", host: "", port: "", database: "" };
  }
}

function isPostgresUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === "postgres:" || url.protocol === "postgresql:") &&
      url.hostname.length > 0 &&
      url.username.length > 0
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

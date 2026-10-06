import { z } from "zod";
import { ServerEnvError } from "@/config/env-schema";

// Authentication configuration (packet M1.1 §9.2, §9.5–9.6). Parsed lazily by
// the auth factory only, so code that never touches authentication does not
// need these variables. Errors name variables and rules, never values.

const appEnvs = ["local", "test", "staging", "production"] as const;
type AppEnv = (typeof appEnvs)[number];

/** Markers that identify placeholder, example, or test secrets. */
const weakSecretMarker =
  /change[_-]?me|replace|placeholder|example|test|local|dummy|not[_-]?a[_-]?secret|^(.)\1+$/i;

/** Local/test-only transports; no production email provider exists yet. */
const emailTransports = ["smtp-local", "capture-file", "refuse"] as const;
/** Only a deterministic local denylist exists (no approved provider). */
const compromisedPasswordAdapters = ["local-denylist"] as const;
const loopbackSmtpHosts = new Set(["127.0.0.1", "localhost", "::1"]);

const boundedSeconds = (min: number, max: number, fallback: number) => {
  const message = `must be an integer between ${min} and ${max}`;
  return z.coerce
    .number({ error: message })
    .int({ error: message })
    .min(min, { error: message })
    .max(max, { error: message })
    .default(fallback);
};

const authEnvSchema = z
  .object({
    APP_ENV: z.enum(appEnvs, {
      error: `must be one of: ${appEnvs.join(", ")}`,
    }),
    BETTER_AUTH_SECRET: z
      .string({ error: "is required" })
      .min(32, { error: "must be at least 32 characters" })
      .max(512, { error: "must be at most 512 characters" }),
    BETTER_AUTH_URL: z.string({ error: "is required" }).refine(isHttpOrigin, {
      error: "must be an http(s) origin without a path",
    }),
    AUTH_TRUSTED_ORIGINS: z
      .string({ error: "is required" })
      .transform((value) =>
        value
          .split(",")
          .map((origin) => origin.trim())
          .filter(Boolean),
      ),
    AUTH_SESSION_EXPIRES_IN_SECONDS: boundedSeconds(300, 604_800, 28_800),
    AUTH_SESSION_UPDATE_AGE_SECONDS: boundedSeconds(60, 86_400, 3_600),
    AUTH_VERIFICATION_EXPIRES_IN_SECONDS: boundedSeconds(300, 86_400, 3_600),
    AUTH_RATE_LIMIT_WINDOW_SECONDS: boundedSeconds(10, 3_600, 60),
    AUTH_RATE_LIMIT_MAX: boundedSeconds(1, 1_000, 10),
    // M1.2 candidate registration and recovery (ADR-0003).
    AUTH_OTP_EXPIRES_IN_SECONDS: boundedSeconds(300, 1_800, 600),
    AUTH_RESET_EXPIRES_IN_SECONDS: boundedSeconds(300, 3_600, 1_800),
    AUTH_PUBLIC_INTENT_EXPIRES_IN_SECONDS: boundedSeconds(600, 86_400, 3_600),
    AUTH_INVITATION_EXPIRES_IN_SECONDS: boundedSeconds(
      3_600,
      1_209_600,
      604_800,
    ),
    AUTH_EMAIL_TRANSPORT: z
      .enum(emailTransports, {
        error: `must be one of: ${emailTransports.join(", ")}`,
      })
      .default("refuse"),
    AUTH_EMAIL_CAPTURE_DIR: z.string().optional(),
    SMTP_HOST: z.string().optional(),
    SMTP_PORT: z.coerce
      .number({ error: "must be a port number" })
      .int({ error: "must be a port number" })
      .min(1, { error: "must be a port number" })
      .max(65_535, { error: "must be a port number" })
      .optional(),
    SMTP_FROM: z.email({ error: "must be a valid email address" }).optional(),
    AUTH_COMPROMISED_PASSWORD_CHECK: z
      .enum(compromisedPasswordAdapters, {
        error: `must be one of: ${compromisedPasswordAdapters.join(", ")}`,
      })
      .default("local-denylist"),
  })
  .superRefine((env, ctx) => {
    const fail = (path: string, message: string) =>
      ctx.addIssue({ code: "custom", path: [path], message });
    const productionLike =
      env.APP_ENV === "staging" || env.APP_ENV === "production";

    if (
      env.APP_ENV !== "test" &&
      weakSecretMarker.test(env.BETTER_AUTH_SECRET)
    ) {
      fail("BETTER_AUTH_SECRET", "looks like a placeholder or test secret");
    }
    if (env.AUTH_TRUSTED_ORIGINS.length === 0) {
      fail("AUTH_TRUSTED_ORIGINS", "must list at least one origin");
    }
    for (const origin of env.AUTH_TRUSTED_ORIGINS) {
      if (origin.includes("*")) {
        fail("AUTH_TRUSTED_ORIGINS", "must not contain wildcards");
      } else if (!isHttpOrigin(origin)) {
        fail(
          "AUTH_TRUSTED_ORIGINS",
          "must contain only http(s) origins without paths",
        );
      } else if (productionLike && !isSecureRemote(origin)) {
        fail(
          "AUTH_TRUSTED_ORIGINS",
          "must use https non-loopback origins in staging/production",
        );
      }
    }
    if (
      productionLike &&
      isHttpOrigin(env.BETTER_AUTH_URL) &&
      !isSecureRemote(env.BETTER_AUTH_URL)
    ) {
      fail(
        "BETTER_AUTH_URL",
        "must be an https non-loopback origin in staging/production",
      );
    }
    if (
      env.AUTH_SESSION_UPDATE_AGE_SECONDS >= env.AUTH_SESSION_EXPIRES_IN_SECONDS
    ) {
      fail(
        "AUTH_SESSION_UPDATE_AGE_SECONDS",
        "must be less than AUTH_SESSION_EXPIRES_IN_SECONDS",
      );
    }
    if (env.AUTH_EMAIL_TRANSPORT === "smtp-local") {
      if (productionLike) {
        fail(
          "AUTH_EMAIL_TRANSPORT",
          "smtp-local (Mailpit) is not allowed in staging/production",
        );
      }
      if (!env.SMTP_HOST || !loopbackSmtpHosts.has(env.SMTP_HOST)) {
        fail("SMTP_HOST", "must be a loopback host for smtp-local");
      }
      if (!env.SMTP_PORT) fail("SMTP_PORT", "is required for smtp-local");
      if (!env.SMTP_FROM) fail("SMTP_FROM", "is required for smtp-local");
    }
    if (env.AUTH_EMAIL_TRANSPORT === "capture-file") {
      if (env.APP_ENV !== "test") {
        fail("AUTH_EMAIL_TRANSPORT", "capture-file is allowed only in test");
      }
      if (
        !env.AUTH_EMAIL_CAPTURE_DIR ||
        !env.AUTH_EMAIL_CAPTURE_DIR.startsWith("/")
      ) {
        fail(
          "AUTH_EMAIL_CAPTURE_DIR",
          "must be an absolute path for capture-file",
        );
      }
    }
    if (productionLike) {
      fail(
        "AUTH_COMPROMISED_PASSWORD_CHECK",
        "staging/production requires an approved privacy-preserving compromised-password provider (not yet configured)",
      );
    }
    if (productionLike) {
      // Rate limiting uses per-process memory until a distributed store is
      // chosen with the hosting decision; that would be ineffective across
      // replicas, so production-like startup is refused.
      fail(
        "APP_ENV",
        "staging/production authentication requires an approved distributed rate-limit store (not yet configured)",
      );
    }
  });

export type AuthEnv = Readonly<z.infer<typeof authEnvSchema>> & {
  /** Cookies get the Secure attribute (https origins, staging/production). */
  readonly secureCookies: boolean;
};

export function parseAuthEnv(
  input: Record<string, string | undefined>,
): AuthEnv {
  const result = authEnvSchema.safeParse(input);
  if (!result.success) {
    const problems = result.error.issues.map(
      (issue) => `${issue.path.join(".") || "(root)"} ${issue.message}`,
    );
    throw new ServerEnvError([...new Set(problems)]);
  }
  const env = result.data;
  return Object.freeze({
    ...env,
    AUTH_TRUSTED_ORIGINS: Object.freeze([
      ...env.AUTH_TRUSTED_ORIGINS,
    ]) as unknown as string[],
    secureCookies:
      env.APP_ENV === "staging" ||
      env.APP_ENV === "production" ||
      env.BETTER_AUTH_URL.startsWith("https://"),
  });
}

function isHttpOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      url.origin === value.replace(/\/$/, "") &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}

function isSecureRemote(value: string): boolean {
  const url = new URL(value);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const loopback =
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "::1" ||
    /^127\./.test(host);
  return url.protocol === "https:" && !loopback;
}

export type { AppEnv };

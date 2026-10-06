import "server-only";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { getDatabase, type Database } from "@/shared/database";
import { getLogger, type AppLogger } from "@/shared/logging";
import { canSignInInteractively } from "../domain/account-policy";
import { isAccountStatus, isAccountType } from "../domain/account-types";
import { findAccountById, recordAuthentication } from "./account-repository";
import { parseAuthEnv, type AuthEnv } from "./auth-env";
import * as authSchema from "./auth-schema";
import { AUTH_SCHEMA_NAME, staticAuthOptions } from "./auth-options";
import {
  RefusingEmailDelivery,
  type EmailDeliveryPort,
} from "./email-delivery";

// Server-only Better Auth factory (packet M1.1 §9). Better Auth owns password
// hashing, credential linkage, session tokens, and verification tokens. The
// application owns account type/status and decides — in the session-creation
// hook — whether a session may exist at all.

export type AuthDependencies = {
  env: AuthEnv;
  db: Database;
  logger: AppLogger;
  emailDelivery: EmailDeliveryPort;
};

const levelMap = {
  debug: "debug",
  info: "info",
  success: "info",
  warn: "warn",
  error: "error",
} as const;

export function createAuth({
  env,
  db,
  logger,
  emailDelivery,
}: AuthDependencies) {
  const log = logger.child({ module: "auth" });

  return betterAuth({
    ...staticAuthOptions,
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL,
    trustedOrigins: [...env.AUTH_TRUSTED_ORIGINS],
    database: drizzleAdapter(db, {
      provider: "pg",
      schemaName: AUTH_SCHEMA_NAME,
      schema: authSchema,
    }),
    emailVerification: {
      expiresIn: env.AUTH_VERIFICATION_EXPIRES_IN_SECONDS,
      autoSignInAfterVerification: false,
      sendOnSignUp: false,
      sendVerificationEmail: async ({ user, url }) => {
        await emailDelivery.sendVerificationEmail({ accountRef: user.id, url });
      },
    },
    session: {
      expiresIn: env.AUTH_SESSION_EXPIRES_IN_SECONDS,
      updateAge: env.AUTH_SESSION_UPDATE_AGE_SECONDS,
      // Every request validates the session against the database so account
      // restriction and revocation take effect immediately.
      cookieCache: { enabled: false },
    },
    advanced: {
      ...staticAuthOptions.advanced,
      useSecureCookies: env.secureCookies,
      defaultCookieAttributes: { httpOnly: true, sameSite: "lax", path: "/" },
    },
    rateLimit: {
      enabled: true,
      storage: "memory",
      window: env.AUTH_RATE_LIMIT_WINDOW_SECONDS,
      max: env.AUTH_RATE_LIMIT_MAX,
    },
    // Library messages may contain emails or internals: log a fixed event
    // code and the level only.
    logger: {
      level: "warn",
      log: (level) => {
        const method = levelMap[level as keyof typeof levelMap] ?? "warn";
        log[method]("auth.library_event", { resultCode: method });
      },
    },
    databaseHooks: {
      user: {
        create: {
          // Defense in depth: type/status are input:false, so only server
          // code can supply them; refuse anything outside the closed sets.
          before: async (candidate) => {
            const fields = candidate as Record<string, unknown>;
            if (
              !isAccountType(fields.accountType) ||
              !isAccountStatus(fields.status)
            ) {
              log.warn("auth.account_create_refused", {
                resultCode: "invalid_account_fields",
              });
              return false;
            }
            return { data: candidate };
          },
        },
      },
      session: {
        create: {
          // Authoritative gate: no session for unknown, non-active, or
          // service accounts, whatever endpoint requested it.
          before: async (newSession) => {
            const account = await findAccountById(db, newSession.userId);
            if (!account || !canSignInInteractively(account)) {
              log.warn("auth.session_refused", {
                resultCode: "account_not_eligible",
              });
              return false;
            }
            return { data: newSession };
          },
          after: async (created) => {
            await recordAuthentication(
              db,
              created.userId,
              created.createdAt ?? new Date(),
            );
            log.info("auth.session_created", {
              recordRef: created.id.replaceAll("-", ""),
            });
          },
        },
      },
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;

const globalForAuth = globalThis as typeof globalThis & { __psaAuth?: Auth };

/** The process-wide auth instance, created lazily from validated config. */
export function getAuth(): Auth {
  globalForAuth.__psaAuth ??= createAuth({
    env: parseAuthEnv(process.env),
    db: getDatabase(),
    logger: getLogger(),
    emailDelivery: new RefusingEmailDelivery(),
  });
  return globalForAuth.__psaAuth;
}

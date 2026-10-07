import "server-only";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError } from "better-auth/api";
import { emailOTP } from "better-auth/plugins/email-otp";
import type { Database } from "@/shared/database";
import type { AppLogger } from "@/shared/logging";
import { canSignInInteractively } from "../domain/account-policy";
import { isAccountStatus, isAccountType } from "../domain/account-types";
import { decideSessionIssuance } from "../domain/session-issuance-policy";
import {
  activateVerifiedCandidate,
  findAccountByEmail,
  findAccountById,
  recordAuthentication,
} from "./account-repository";
import type { AuthEnv } from "./auth-env";
import type { AuthEmailPort } from "./auth-email";
import * as authSchema from "./auth-schema";
import {
  AUTH_SCHEMA_NAME,
  staffTwoFactorPlugin,
  staticAuthOptions,
} from "./auth-options";
import type { SecurityEventPort } from "./security-events";
import { currentSessionIssuance } from "./session-issuance";
import { staffSessionPlugin } from "./staff-session-plugin";

// Server-only Better Auth factory (packets M1.1 §9, M1.2, M1.3). Better Auth
// owns password hashing, credential linkage, sessions, reset tokens, email
// OTPs, TOTP, and backup codes. The application owns account type/status,
// decides in the session-creation hook whether a session may exist at all
// and what assurance it carries, and decides which accounts may receive
// verification or reset email.

export type AuthDependencies = {
  env: AuthEnv;
  db: Database;
  logger: AppLogger;
  email: AuthEmailPort;
  events: SecurityEventPort;
};

/** Verification code length and attempt budget (ADR-0003). */
export const OTP_LENGTH = 8;
export const OTP_ALLOWED_ATTEMPTS = 3;

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
  email,
  events,
}: AuthDependencies) {
  const log = logger.child({ module: "auth" });

  return betterAuth({
    ...staticAuthOptions,
    disabledPaths: [...staticAuthOptions.disabledPaths],
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL,
    trustedOrigins: [...env.AUTH_TRUSTED_ORIGINS],
    database: drizzleAdapter(db, {
      provider: "pg",
      schemaName: AUTH_SCHEMA_NAME,
      schema: authSchema,
    }),
    emailAndPassword: {
      ...staticAuthOptions.emailAndPassword,
      resetPasswordTokenExpiresIn: env.AUTH_RESET_EXPIRES_IN_SECONDS,
      // Better Auth creates the single-use (hashed) reset record; only an
      // active, verified candidate is ever emailed a link, and the link puts
      // the token in the fragment so it never reaches a server log.
      sendResetPassword: async ({ user, token }) => {
        const account = await findAccountById(db, user.id);
        if (
          !account ||
          account.accountType !== "CANDIDATE" ||
          !canSignInInteractively(account)
        ) {
          return;
        }
        email.enqueue({
          template: "PASSWORD_RESET",
          to: user.email,
          token,
          expiresInMinutes: Math.round(env.AUTH_RESET_EXPIRES_IN_SECONDS / 60),
        });
        await events.record({
          code: "auth.recovery_email_sent",
          accountRef: account.id,
        });
      },
      // The durable auth.recovery_completed event is recorded by the
      // application command once Better Auth has finished (ADR-0012).
      onPasswordReset: async ({ user }) => {
        email.enqueue({ template: "PASSWORD_CHANGED", to: user.email });
      },
    },
    emailVerification: {
      autoSignInAfterVerification: false,
      sendOnSignUp: false,
      // Only an invited, unverified candidate can complete verification.
      beforeEmailVerification: async (user) => {
        const account = await findAccountById(db, user.id);
        if (
          !account ||
          account.accountType !== "CANDIDATE" ||
          account.status !== "INVITED"
        ) {
          throw new APIError("BAD_REQUEST");
        }
      },
      // Approved transition: INVITED → ACTIVE once the email is verified.
      // auth.verification_completed is recorded durably by the
      // application command after Better Auth returns (ADR-0012).
      afterEmailVerification: async (user) => {
        await activateVerifiedCandidate(db, user.id);
      },
    },
    session: {
      ...staticAuthOptions.session,
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
    plugins: [
      // Mandatory staff TOTP + backup codes (M1.3, ADR-0004). No OTP sender
      // is configured, so email/SMS two-factor cannot be enabled or sent.
      staffTwoFactorPlugin({
        challengeSeconds: env.AUTH_STAFF_MFA_CHALLENGE_SECONDS,
        maxFailedAttempts: env.AUTH_STAFF_MFA_MAX_FAILURES,
        lockoutSeconds: env.AUTH_STAFF_MFA_LOCKOUT_SECONDS,
      }),
      staffSessionPlugin(),
      emailOTP({
        overrideDefaultEmailVerification: true,
        disableSignUp: true,
        sendVerificationOnSignUp: false,
        otpLength: OTP_LENGTH,
        allowedAttempts: OTP_ALLOWED_ATTEMPTS,
        expiresIn: env.AUTH_OTP_EXPIRES_IN_SECONDS,
        // A new request replaces the previous code: at most one active.
        resendStrategy: "rotate",
        storeOTP: "hashed",
        changeEmail: { enabled: false },
        // OTP sign-in, OTP reset, and email change are never used: codes
        // are sent only to invited, unverified candidates.
        sendVerificationOTP: async ({ email: to, otp, type }) => {
          if (type !== "email-verification") return;
          const account = await findAccountByEmail(db, to);
          if (
            !account ||
            account.accountType !== "CANDIDATE" ||
            account.status !== "INVITED" ||
            account.emailVerified
          ) {
            return;
          }
          email.enqueue({
            template: "EMAIL_VERIFICATION_CODE",
            to,
            code: otp,
            expiresInMinutes: Math.round(env.AUTH_OTP_EXPIRES_IN_SECONDS / 60),
          });
          await events.record({
            code: "auth.verification_sent",
            accountRef: account.id,
          });
        },
      }),
    ],
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
          // Authoritative gate: no session for unknown, non-active, service,
          // or unverified candidate accounts, whatever endpoint asked. Staff
          // sessions exist only inside an approved staff command's declared
          // issuance intent, and every session is stamped with server-owned
          // assurance evidence (M1.3).
          before: async (newSession) => {
            const account = await findAccountById(db, newSession.userId);
            const stamp = decideSessionIssuance(
              account,
              currentSessionIssuance(),
              new Date(),
            );
            if (!stamp) {
              log.warn("auth.session_refused", {
                resultCode: "account_not_eligible",
              });
              return false;
            }
            return { data: { ...newSession, ...stamp } };
          },
          after: async (created) => {
            const purpose = (created as { authPurpose?: unknown }).authPurpose;
            if (purpose !== "STANDARD" && purpose !== "STAFF") return;
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

import "server-only";
import { getDatabase, type Database } from "@/shared/database";
import { getLogger, type AppLogger } from "@/shared/logging";
import { FixedWindowRateLimiter } from "./action-rate-limiter";
import { createAuth, type Auth } from "./auth";
import { parseAuthEnv, type AuthEnv } from "./auth-env";
import {
  AuthEmailDispatcher,
  FileEmailCapture,
  RefusingEmailTransport,
  type AuthEmailTransport,
} from "./auth-email";
import {
  LocalDenylistCompromisedPassword,
  type CompromisedPasswordPort,
} from "./compromised-password";
import { RegistrationIntentRepository } from "./registration-intent-repository";
import { LogSecurityEvents, type SecurityEventPort } from "./security-events";
import { LocalSmtpEmailTransport } from "./smtp-auth-email-adapter";

// Composition root for the identity-access module: one place that turns
// validated configuration into the auth instance and the ports candidate
// commands use. Tests build their own runtime with createIdentityRuntime.

export type IdentityRuntime = Readonly<{
  env: AuthEnv;
  db: Database;
  logger: AppLogger;
  auth: Auth;
  email: AuthEmailDispatcher;
  events: SecurityEventPort;
  compromised: CompromisedPasswordPort;
  intents: RegistrationIntentRepository;
  limiter: FixedWindowRateLimiter;
}>;

/** The configured local/test email transport (auth-env validated it). */
export function emailTransportFor(env: AuthEnv): AuthEmailTransport {
  switch (env.AUTH_EMAIL_TRANSPORT) {
    case "smtp-local":
      return new LocalSmtpEmailTransport({
        host: env.SMTP_HOST!,
        port: env.SMTP_PORT!,
        from: env.SMTP_FROM!,
      });
    case "capture-file":
      return new FileEmailCapture(env.AUTH_EMAIL_CAPTURE_DIR!, env.APP_ENV);
    case "refuse":
      return new RefusingEmailTransport();
  }
}

export function createIdentityRuntime(options: {
  env: AuthEnv;
  db: Database;
  logger: AppLogger;
  transport?: AuthEmailTransport;
  limiter?: FixedWindowRateLimiter;
}): IdentityRuntime {
  const { env, db, logger } = options;
  const email = new AuthEmailDispatcher(
    options.transport ?? emailTransportFor(env),
    env.BETTER_AUTH_URL,
    logger,
  );
  const events = new LogSecurityEvents(logger);
  const auth = createAuth({ env, db, logger, email, events });
  const intents = new RegistrationIntentRepository(
    {
      secret: env.BETTER_AUTH_SECRET,
      publicTtlSeconds: env.AUTH_PUBLIC_INTENT_EXPIRES_IN_SECONDS,
      invitationTtlSeconds: env.AUTH_INVITATION_EXPIRES_IN_SECONDS,
    },
    async () => (await auth.$context).internalAdapter,
  );
  return Object.freeze({
    env,
    db,
    logger,
    auth,
    email,
    events,
    compromised: new LocalDenylistCompromisedPassword(),
    intents,
    limiter: options.limiter ?? new FixedWindowRateLimiter(),
  });
}

const globalForIdentity = globalThis as typeof globalThis & {
  __psaIdentity?: IdentityRuntime;
};

/** The process-wide runtime, created lazily from validated configuration. */
export function getIdentityRuntime(): IdentityRuntime {
  globalForIdentity.__psaIdentity ??= createIdentityRuntime({
    env: parseAuthEnv(process.env),
    db: getDatabase(),
    logger: getLogger(),
  });
  return globalForIdentity.__psaIdentity;
}

/** The process-wide auth instance. */
export function getAuth(): Auth {
  return getIdentityRuntime().auth;
}

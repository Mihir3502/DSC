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
import type { AuthorizationPorts } from "../application/authorize";
import {
  MandatorySeparationOfDutiesPolicy,
  restrictiveDualControl,
} from "../domain/separation-of-duties-policy";
import { productionWorkflowPolicies } from "../policy/workflow-policies";
import {
  RefusingAssignmentHarness,
  type AssignmentHarnessGate,
} from "./assignment-harness";
import { RegistrationIntentRepository } from "./registration-intent-repository";
import {
  UnavailableCandidateOwnership,
  UnavailableScopeResolver,
} from "./scope-resolvers";
import {
  createAuditRecorder,
  getAuditKeyRing,
  type AuditKeyRing,
} from "@/modules/audit";
import type { SecurityEventPort } from "./security-events";
import {
  RefusingStaffAdministrationGate,
  type StaffAdministrationGate,
} from "./staff-administration-gate";
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
  /** Staff administration authorization (refusing until M1.4–M1.6). */
  staffAdmin: StaffAdministrationGate;
  /**
   * M1.4 authorization ports. Defaults fail closed: no scope, ownership,
   * or workflow adapter exists before M2, and dual control is on.
   */
  authorization: AuthorizationPorts;
  /** Role-assignment bootstrap gate (refusing outside tests). */
  assignmentHarness: AssignmentHarnessGate;
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
  /** Only local/test harnesses pass a non-refusing gate. */
  staffAdmin?: StaffAdministrationGate;
  /** Tests pass synthetic resolvers, a fixed clock, or workflow policies. */
  authorization?: Partial<AuthorizationPorts>;
  /** Only tests pass NonproductionAssignmentHarness. */
  assignmentHarness?: AssignmentHarnessGate;
  /** Durable audit recorder (ADR-0012); tests may wrap or fault-inject. */
  events?: SecurityEventPort;
  /** Integrity key ring; defaults to the validated process key ring. */
  auditKeys?: AuditKeyRing;
}): IdentityRuntime {
  const { env, db, logger } = options;
  const email = new AuthEmailDispatcher(
    options.transport ?? emailTransportFor(env),
    env.BETTER_AUTH_URL,
    logger,
  );
  const events =
    options.events ??
    createAuditRecorder({
      db,
      logger,
      keys: options.auditKeys ?? getAuditKeyRing(),
    });
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
    staffAdmin: options.staffAdmin ?? new RefusingStaffAdministrationGate(),
    authorization: Object.freeze({
      resolver: new UnavailableScopeResolver(),
      ownership: new UnavailableCandidateOwnership(),
      workflow: productionWorkflowPolicies,
      separation: new MandatorySeparationOfDutiesPolicy(),
      dualControl: restrictiveDualControl,
      clock: () => new Date(),
      ...options.authorization,
    }),
    assignmentHarness:
      options.assignmentHarness ?? new RefusingAssignmentHarness(),
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

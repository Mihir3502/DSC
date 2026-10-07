import "server-only";
import { withAuditedTransaction } from "@/modules/audit";
import {
  intentAllowsEmail,
  type PasswordProblem,
} from "../domain/candidate-registration-policy";
import { clientKeyFrom } from "../infrastructure/action-rate-limiter";
import {
  createCandidateWithCredential,
  findAccountByEmail,
} from "../infrastructure/account-repository";
import {
  commandLogger,
  defaultDependencies,
  equalizePasswordWork,
  newPasswordProblems,
  tryNormalizeEmail,
  type CandidateAuthDependencies,
} from "./candidate-auth-support";

// Controlled candidate-only registration (packet M1.2 §6, §10, AC-M1.2-01–
// 03). The browser supplies only an intent token, email, password, and
// confirmation. Account type (CANDIDATE), status (INVITED), and
// email_verified (false) are fixed server-side. No organization, position,
// person, candidacy, application, role, or staff record is created.

export type RegisterCandidateInput = Readonly<{
  intentToken: unknown;
  email: unknown;
  password: unknown;
  passwordConfirmation: unknown;
}>;

export type RegisterCandidateResult =
  /** Generic: identical for new, duplicate, and staff/service emails. */
  | Readonly<{ kind: "SUBMITTED" }>
  | Readonly<{
      kind: "INVALID_INPUT";
      email?: "INVALID";
      password?: readonly PasswordProblem[];
    }>
  /** Missing, expired, used, tampered, or wrong-email intent. */
  | Readonly<{ kind: "INTENT_INVALID" }>
  | Readonly<{ kind: "RATE_LIMITED" }>;

export async function registerCandidate(
  input: RegisterCandidateInput,
  headers: Headers,
  deps: CandidateAuthDependencies = defaultDependencies(),
): Promise<RegisterCandidateResult> {
  const log = commandLogger(deps);
  await deps.events.record({ code: "auth.registration_requested" });

  if (!deps.limiter.consume("register", clientKeyFrom(headers))) {
    await deps.events.record({
      code: "auth.rate_limited",
      category: "rate_limited",
    });
    return { kind: "RATE_LIMITED" };
  }

  const email = tryNormalizeEmail(input.email);
  const passwordProblems = await newPasswordProblems(
    deps,
    input.password,
    input.passwordConfirmation,
  );
  if (!email || passwordProblems.length > 0) {
    return {
      kind: "INVALID_INPUT",
      ...(email ? {} : { email: "INVALID" as const }),
      ...(passwordProblems.length > 0 ? { password: passwordProblems } : {}),
    };
  }
  const password = input.password as string;

  const intent = await deps.intents.peek(input.intentToken);
  if (!intent || !intentAllowsEmail(intent, email.login)) {
    log.info("auth.registration_rejected", { resultCode: "invalid_intent" });
    return { kind: "INTENT_INVALID" };
  }
  const intentToken = input.intentToken as string;

  const existing = await findAccountByEmail(deps.db, email.login);
  if (existing) {
    // Same work and the same public outcome as a new account. Staff and
    // service accounts are never converted or disclosed. An invited,
    // unverified candidate is simply offered a fresh code.
    await equalizePasswordWork(deps, password);
    await deps.intents.consume(intentToken);
    if (
      existing.accountType === "CANDIDATE" &&
      existing.status === "INVITED" &&
      !existing.emailVerified
    ) {
      await sendVerificationCode(deps, email.login);
    }
    log.info("auth.registration_submitted", { resultCode: "duplicate" });
    return { kind: "SUBMITTED" };
  }

  // Single use: an invitation that was consumed by a racing request (or
  // expired since the peek) cannot create an account.
  if (!(await deps.intents.consume(intentToken))) {
    return { kind: "INTENT_INVALID" };
  }

  const ctx = await deps.auth.$context;
  const passwordHash = await ctx.password.hash(password);
  // The account, its credential, and the audit event commit together.
  const accountId = await withAuditedTransaction(deps, async (tx, audit) => {
    const created = await createCandidateWithCredential(tx, {
      email: email.login,
      emailDisplay: email.display,
      passwordHash,
    });
    if (created) {
      await audit.append({
        code: "auth.registration_account_created",
        accountRef: created,
      });
    }
    return created;
  });
  if (accountId) await sendVerificationCode(deps, email.login);
  // accountId is null when a concurrent request created the same normalized
  // email first: the outcome is still the generic one.
  log.info("auth.registration_submitted", {
    resultCode: accountId ? "created" : "duplicate",
  });
  return { kind: "SUBMITTED" };
}

/**
 * Asks Better Auth's email-OTP plugin for a new code (rotating any previous
 * one). The plugin hook emails only invited, unverified candidates.
 */
export async function sendVerificationCode(
  deps: CandidateAuthDependencies,
  normalizedEmail: string,
): Promise<void> {
  if (!deps.limiter.consume("verificationSendPerEmail", normalizedEmail)) {
    await deps.events.record({
      code: "auth.rate_limited",
      category: "rate_limited",
    });
    return;
  }
  await deps.auth.api.sendVerificationOTP({
    body: { email: normalizedEmail, type: "email-verification" },
  });
}

import "server-only";
import type { Database } from "@/shared/database";
import { CORRELATION_HEADER, isValidCorrelationId } from "@/shared/logging";
import type { AppLogger } from "@/shared/logging";
import {
  evaluateSelfService,
  findSelfServicePolicy,
  SELF_SERVICE_POLICY_VERSION,
  type SelfServiceDecision,
  type SelfServiceDeny,
  type SelfServicePolicyCode,
} from "../domain/self-service-policy";
import {
  findAccountById,
  lockAccountForUpdate,
} from "../infrastructure/account-repository";
import type { Executor } from "../infrastructure/authorization-repository";
import { readSessionAssurance } from "../infrastructure/better-auth-mfa-adapter";
import type { SecurityEventPort } from "../infrastructure/security-events";
import type { Principal } from "./current-account";

// Application authorization boundary for account self-service (packet M1.5
// §9.1, ADR-0011). Every current candidate/staff security query and command
// calls this after resolving its principal, and again at the transaction
// boundary where a race matters. It re-reads the account and the session's
// assurance evidence on every call, so a restriction, session revocation,
// account-version change (MFA reset, password change, role change), or
// lapsed recent authentication takes effect on the very next call, whatever
// the route guard or an earlier request decided.
//
// Denials are typed results, never thrown. One bounded telemetry line is
// written per denial (route guards never write one, so a request denied by
// both produces a single record), and a high-risk denial also emits the
// future-audit-ready event.

export type SelfServiceDependencies = Readonly<{
  db: Database;
  events: SecurityEventPort;
  logger: AppLogger;
  env: Readonly<{ AUTH_STAFF_RECENT_AUTH_SECONDS: number }>;
  /** Injected for tests; defaults to the server clock. */
  clock?: () => Date;
}>;

/** Safe context for the future M1.6 audit port (no values, no facts). */
export type SelfServiceAuditContext = Readonly<{
  actorRef: string | null;
  policy: string;
  policyVersion: string;
  outcome: "ALLOWED" | "DENIED";
  reasonCode: string;
  correlationId?: string;
}>;

export function selfServiceAction(code: string): string {
  return `self_service.${code.toLowerCase()}`;
}

/** The validated correlation ID the proxy forwarded, if any. */
export function correlationOf(headers: Headers | null): string | undefined {
  const value = headers?.get(CORRELATION_HEADER);
  return isValidCorrelationId(value) ? value : undefined;
}

export function selfServiceAuditContext(
  decision: SelfServiceDecision,
  principal: Principal | null,
  correlationId?: string,
): SelfServiceAuditContext {
  return Object.freeze({
    actorRef: principal?.accountId ?? null,
    policy: decision.policy,
    policyVersion: decision.policyVersion,
    outcome: decision.decision === "ALLOW" ? "ALLOWED" : "DENIED",
    reasonCode: decision.reasonCode,
    ...(correlationId ? { correlationId } : {}),
  });
}

async function decide(
  executor: Executor,
  lock: boolean,
  principal: Principal | null,
  policy: SelfServicePolicyCode,
  deps: SelfServiceDependencies,
): Promise<SelfServiceDecision> {
  if (!principal || !findSelfServicePolicy(policy)) {
    return evaluateSelfService({
      policy,
      principal,
      account: null,
      evidence: null,
      now: (deps.clock ?? (() => new Date()))(),
      recentWindowSeconds: deps.env.AUTH_STAFF_RECENT_AUTH_SECONDS,
    });
  }
  const account = lock
    ? await lockAccountForUpdate(executor, principal.accountId)
    : await findAccountById(executor, principal.accountId);
  const evidence = account
    ? await readSessionAssurance(
        executor,
        principal.accountId,
        principal.sessionId,
      )
    : null;
  return evaluateSelfService({
    policy,
    principal,
    account,
    evidence,
    now: (deps.clock ?? (() => new Date()))(),
    recentWindowSeconds: deps.env.AUTH_STAFF_RECENT_AUTH_SECONDS,
  });
}

function report(
  decision: SelfServiceDecision,
  principal: Principal | null,
  deps: SelfServiceDependencies,
  correlationId: string | undefined,
): SelfServiceDecision {
  if (decision.decision === "ALLOW") return decision;
  deps.logger.info("authz.self_service_denied", {
    module: "authz",
    action: selfServiceAction(decision.policy),
    reasonCode: decision.reasonCode,
    policyVersion: decision.policyVersion,
    correlationId,
  });
  const definition = findSelfServicePolicy(decision.policy);
  // A missing recent authentication is the normal step-up path, not a
  // high-risk denial; the command records its own challenge event.
  if (
    definition?.highRisk &&
    principal &&
    decision.reasonCode !== "RECENT_AUTH_REQUIRED"
  ) {
    deps.events.record({
      code: "authz.self_service_denied",
      category: "denied",
      accountRef: principal.accountId,
      permissionCode: selfServiceAction(decision.policy),
      reasonCode: decision.reasonCode,
      policyVersion: decision.policyVersion,
      correlationId,
    });
  }
  return decision;
}

/**
 * Authorizes a self-service query/command for the principal against
 * current committed state. Unexpected failures deny POLICY_UNAVAILABLE.
 */
export async function authorizeAccountSelfService(
  principal: Principal | null,
  policy: SelfServicePolicyCode,
  deps: SelfServiceDependencies,
  options: Readonly<{ correlationId?: string }> = {},
): Promise<SelfServiceDecision> {
  let decision: SelfServiceDecision;
  try {
    decision = await decide(deps.db, false, principal, policy, deps);
  } catch {
    decision = Object.freeze({
      decision: "DENY",
      policy,
      policyVersion: SELF_SERVICE_POLICY_VERSION,
      reasonCode: "POLICY_UNAVAILABLE",
    });
  }
  return report(decision, principal, deps, options.correlationId);
}

/**
 * The same decision inside the command's own transaction. The account row
 * is locked FOR UPDATE, so a concurrent restriction or security change
 * either committed first (and denies here) or waits for this command.
 */
export async function authorizeAccountSelfServiceInTransaction(
  tx: Executor,
  principal: Principal | null,
  policy: SelfServicePolicyCode,
  deps: SelfServiceDependencies,
  options: Readonly<{ correlationId?: string }> = {},
): Promise<SelfServiceDecision> {
  const decision = await decide(tx, true, principal, policy, deps);
  return report(decision, principal, deps, options.correlationId);
}

/**
 * The caller-facing refusal for a self-service denial. Internal reasons
 * stay internal: an ineligible session reads as signed out, a wrong
 * audience or unavailable policy as "not permitted" (delivery maps it to a
 * safe not-found), and missing recent authentication as a step-up.
 */
export type SelfServiceRefusal =
  | Readonly<{ kind: "UNAUTHENTICATED" }>
  | Readonly<{ kind: "NOT_PERMITTED" }>
  | Readonly<{ kind: "REAUTHENTICATION_REQUIRED" }>;

export function refusalOf(decision: SelfServiceDeny): SelfServiceRefusal {
  switch (decision.reasonCode) {
    case "UNAUTHENTICATED":
    case "ACCOUNT_INACTIVE":
      return { kind: "UNAUTHENTICATED" };
    case "RECENT_AUTH_REQUIRED":
      return { kind: "REAUTHENTICATION_REQUIRED" };
    default:
      return { kind: "NOT_PERMITTED" };
  }
}

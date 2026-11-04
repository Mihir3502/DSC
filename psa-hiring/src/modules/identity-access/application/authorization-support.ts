import "server-only";
import {
  getIdentityRuntime,
  type IdentityRuntime,
} from "../infrastructure/runtime";
import type { FixedWindowRateLimiter } from "../infrastructure/action-rate-limiter";
import type { AuthorizationDependencies } from "./authorize";
import type { RoleAssignmentDependencies } from "./role-assignments";

export type ActionRateLimiter = Pick<FixedWindowRateLimiter, "consume">;

// Builds authorization dependencies from the identity runtime: current
// database, event port, logger, the M1.3 recent-auth window, and the
// runtime's fail-closed authorization ports.

export function authorizationDependencies(
  runtime: IdentityRuntime = getIdentityRuntime(),
): AuthorizationDependencies {
  return Object.freeze({
    ...runtime.authorization,
    db: runtime.db,
    events: runtime.events,
    logger: runtime.logger.child({ module: "authz" }),
    recentWindowSeconds: runtime.env.AUTH_STAFF_RECENT_AUTH_SECONDS,
  });
}

/** The runtime's per-process action limiter, for other modules' commands. */
export function actionRateLimiter(
  runtime: IdentityRuntime = getIdentityRuntime(),
): ActionRateLimiter {
  return runtime.limiter;
}

/** Sends the application-received email; rejects if delivery fails. */
export function applicationEmailSender(
  runtime: IdentityRuntime = getIdentityRuntime(),
) {
  return (to: string, reference: string) =>
    runtime.email.deliver({ template: "APPLICATION_RECEIVED", to, reference });
}

export function roleAssignmentDependencies(
  runtime: IdentityRuntime = getIdentityRuntime(),
): RoleAssignmentDependencies {
  return Object.freeze({
    ...authorizationDependencies(runtime),
    harness: runtime.assignmentHarness,
  });
}

import "server-only";
import {
  getIdentityRuntime,
  type IdentityRuntime,
} from "../infrastructure/runtime";
import type { AuthorizationDependencies } from "./authorize";
import type { RoleAssignmentDependencies } from "./role-assignments";

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

export function roleAssignmentDependencies(
  runtime: IdentityRuntime = getIdentityRuntime(),
): RoleAssignmentDependencies {
  return Object.freeze({
    ...authorizationDependencies(runtime),
    harness: runtime.assignmentHarness,
  });
}

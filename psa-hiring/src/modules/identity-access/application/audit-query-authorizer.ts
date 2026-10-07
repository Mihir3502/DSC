import "server-only";
import {
  noRecordGroups,
  type AuditQueryAuthorizer,
  type AuditQueryDependencies,
  type AuditQueryScope,
  type AuditRecordGroupResolver,
} from "@/modules/audit";
import type { AccountType } from "../domain/account-types";
import {
  authorizeQueryScope,
  type AuthorizationDependencies,
} from "./authorize";

// Adapter from the audit module's query-authorizer port to the central
// M1.4 query-scope decision (packet M1.6 §16.1, ADR-0012). The audit
// module never imports identity-access; this adapter is the only bridge.
//
// - The permission and data sensitivity come from the audit module's
//   server-side category mapping, never from the caller.
// - Only AUDIT_ASSIGNMENT scopes yield audit predicates. Organization,
//   branch, team, and assigned-record scopes are not audit authority, and a
//   candidate's own-account binding never is (fail closed).
// - SYSTEM_ADMINISTRATOR holds no audit.*.assigned grant (technical support
//   only), so the central decision denies it.

export function auditQueryAuthorizer(
  deps: AuthorizationDependencies,
): AuditQueryAuthorizer {
  return {
    async authorize(principal, access, correlationId) {
      const decision = await authorizeQueryScope(
        {
          principal: principal
            ? {
                accountId: principal.accountId,
                accountType: principal.accountType as AccountType,
                sessionId: principal.sessionId,
              }
            : null,
          permission: access.permission,
          operation: "READ",
          sensitivity: access.sensitivity,
          ...(correlationId ? { correlationId } : {}),
        },
        deps,
      );
      if (decision.decision === "DENY") {
        return {
          decision: "DENY",
          reasonCode: decision.reasonCode,
          recorded: false,
        };
      }
      if (decision.constraint.kind !== "SCOPES") {
        return {
          decision: "DENY",
          reasonCode: "PERMISSION_MISSING",
          recorded: false,
        };
      }
      const scopes: AuditQueryScope[] = [];
      for (const scope of decision.constraint.scopes) {
        if (scope.type !== "AUDIT_ASSIGNMENT") continue;
        scopes.push({
          organizationId: scope.organizationId,
          recordGroupIds: scope.recordGroupIds,
          from: scope.recordsFrom,
          to: scope.recordsTo,
        });
      }
      if (scopes.length === 0) {
        return {
          decision: "DENY",
          reasonCode: "SCOPE_MISMATCH",
          recorded: false,
        };
      }
      return {
        decision: "ALLOW",
        scopes,
        effectiveRoleCode: decision.effectiveRoleCodes[0] ?? null,
      };
    },
  };
}

/** Audit query dependencies over the identity runtime's authorization. */
export function auditQueryDependencies(
  deps: AuthorizationDependencies,
  recordGroups: AuditRecordGroupResolver = noRecordGroups,
): AuditQueryDependencies {
  return Object.freeze({
    db: deps.db,
    events: deps.events,
    authorizer: auditQueryAuthorizer(deps),
    recordGroups,
  });
}

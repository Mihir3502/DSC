import type { AssuranceEvidence } from "../../domain/authentication-assurance";

// Current server-owned facts the authorization service needs (packet M1.4
// §15.1). Every decision reads them fresh; nothing is cached and nothing
// comes from the session, a JWT, or the client.

export type AccountFact = Readonly<{
  id: string;
  accountType: string;
  status: string;
}>;

export type SubjectEpoch = Readonly<{
  authorizationVersion: number;
  versionChangedAt: Date;
}>;

/** The stored, controlled columns of a permission row. */
export type PermissionFact = Readonly<{
  code: string;
  resource: string;
  action: string;
  operation: string;
  maxSensitivity: string;
  permissionDomain: string;
  description: string;
  status: string;
  requiresScope: boolean;
  workflowPolicyCode: string | null;
  recentAuthPolicy: string | null;
  recentAuthPurpose: string | null;
  separationPolicyCode: string | null;
  dualControlHook: string | null;
  requiresReason: boolean;
  restrictedData: boolean;
  isExport: boolean;
  highRisk: boolean;
  catalogVersion: number;
}>;

/** One way the principal currently holds the requested permission. */
export type GrantFact = Readonly<{
  /** Null for the candidate relationship (no staff assignment). */
  assignmentId: string | null;
  roleCode: string;
  scopeType: string | null;
  scopeReferenceId: string | null;
  effectiveFrom: Date | null;
  /** Raw stored condition; validated by the service, never executed. */
  condition: unknown;
}>;

export interface AuthorizationFactsSource {
  loadAccount(accountId: string): Promise<AccountFact | null>;
  loadAssurance(
    accountId: string,
    sessionId: string,
  ): Promise<AssuranceEvidence | null>;
  loadSubjectEpoch(accountId: string): Promise<SubjectEpoch | null>;
  loadPermission(code: string): Promise<PermissionFact | null>;
  /** ACTIVE assignments effective at `at`, via ACTIVE role, grant, permission. */
  loadStaffGrants(
    accountId: string,
    permissionCode: string,
    at: Date,
  ): Promise<readonly GrantFact[]>;
  /** Does any non-effective (future, ended, revoked, superseded) assignment exist? */
  hasIneffectiveAssignment(
    accountId: string,
    permissionCode: string,
    at: Date,
  ): Promise<boolean>;
  /** ACTIVE CANDIDATE-role grants of the permission. */
  loadCandidateGrants(permissionCode: string): Promise<readonly GrantFact[]>;
}

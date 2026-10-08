import type {
  Designation,
  ParticipantRelationship,
  ScopeType,
} from "../../domain/authorization-vocabulary";
import type {
  ResourcePlacement,
  ScopeDescriptor,
} from "../../domain/scope-policy";

// Server-owned scope/resource resolution port (packet M1.4 §10.2,
// ADR-0005). Organization, branch, team, assignment-set, audit-assignment,
// person, and candidacy records belong to later modules (M2+); they
// provide the real adapters:
//
// - OrganizationScopeResolver (organization module, M2.1) is the runtime
//   default. It resolves organization/branch/team scopes and the
//   organization module's records from real rows, and answers UNAVAILABLE
//   for assignment-set and audit-assignment scopes, which have no tables
//   yet.
// - UnavailableScopeResolver answers UNAVAILABLE to everything (tests of
//   the fail-closed path).
// - SyntheticScopeResolver exists for tests only and refuses to construct
//   outside APP_ENV=test.
//
// Implementations must never trust membership supplied by the browser,
// session, URL, or request body; must reject cross-organization parentage
// and cycles; and must fail closed when their backing module is
// unavailable. Outcomes other than ACTIVE/FOUND are never shown to callers.

export type ResolverContext = Readonly<{ correlationId?: string }>;

export type ScopeResolution =
  | Readonly<{ status: "ACTIVE"; descriptor: ScopeDescriptor }>
  | Readonly<{
      status: "INACTIVE" | "MISSING" | "TYPE_MISMATCH" | "UNAVAILABLE";
    }>;

export type ResourceResolution =
  | Readonly<{ status: "FOUND"; placement: ResourcePlacement }>
  | Readonly<{ status: "MISSING" | "UNAVAILABLE" }>;

export interface ScopeResourceResolver {
  /** Resolves a scope reference into an active, typed descriptor. */
  resolveScope(
    type: ScopeType,
    referenceId: string,
    at: Date,
    context: ResolverContext,
  ): Promise<ScopeResolution>;

  /** Resolves where a business record sits and whose file it is. */
  resolveResource(
    resourceId: string,
    at: Date,
    context: ResolverContext,
  ): Promise<ResourceResolution>;

  /** Is the actor currently an interviewer/evaluator on the record? */
  hasRelationship(
    actorAccountId: string,
    resourceId: string,
    relationship: ParticipantRelationship,
    at: Date,
    context: ResolverContext,
  ): Promise<boolean>;

  /** Does the actor hold the designation within the scope? */
  hasDesignation(
    actorAccountId: string,
    designation: Designation,
    scope: ScopeDescriptor,
    at: Date,
    context: ResolverContext,
  ): Promise<boolean>;
}

/**
 * Candidate entitlement is an account-to-candidacy ownership relationship,
 * never a staff assignment (packet §7.3). M2 provides the adapter; until
 * then every candidate business-resource decision denies.
 */
export interface CandidateOwnershipResolver {
  owns(
    accountId: string,
    resourceId: string,
    at: Date,
    context: ResolverContext,
  ): Promise<"OWNER" | "NOT_OWNER" | "UNAVAILABLE">;
}

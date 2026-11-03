import "server-only";
import { currentAuthorizationExecutor } from "@/modules/identity-access/application/ports/authorization-executor";
import type {
  CandidateOwnershipResolver,
  ResourceResolution,
  ScopeResolution,
  ScopeResourceResolver,
} from "@/modules/identity-access/application/ports/scope-resource-resolver";
import type {
  Designation,
  ParticipantRelationship,
  ScopeType,
} from "@/modules/identity-access/domain/authorization-vocabulary";
import type { ScopeDescriptor } from "@/modules/identity-access/domain/scope-policy";
import {
  accountOwnsRecord,
  findCandidateRecordPlacement,
  type Executor,
} from "./candidates-repository";

// Real candidate adapters for the M1 authorization ports (packet M2.2
// §8, §16; ADR-0005 M2.2 note). Facts come only from server-owned rows.
//
// CandidateRecordOwnership answers OWNER when the candidate account is the
// person's linked owner (for a person or any of its candidacies), or when
// the resource is the account itself — the documented "own account"
// resource used by create-own commands before a person exists. Anything
// else is NOT_OWNER; a database failure is UNAVAILABLE (fail closed).
//
// CompositeScopeResourceResolver places candidacies and duplicate cases
// (organization, branch, team; the owning candidate account as subject,
// so a staff member's own candidate record denies under OWN_RECORD) and
// delegates everything else to the organization resolver.

const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export class CandidateRecordOwnership implements CandidateOwnershipResolver {
  constructor(private readonly db: () => Executor) {}

  async owns(
    accountId: string,
    resourceId: string,
  ): Promise<"OWNER" | "NOT_OWNER" | "UNAVAILABLE"> {
    if (!uuid.test(accountId) || !uuid.test(resourceId)) return "NOT_OWNER";
    if (accountId === resourceId) return "OWNER";
    try {
      const owned = await accountOwnsRecord(
        currentAuthorizationExecutor<Executor>() ?? this.db(),
        accountId,
        resourceId,
      );
      return owned ? "OWNER" : "NOT_OWNER";
    } catch {
      return "UNAVAILABLE";
    }
  }
}

export class CompositeScopeResourceResolver implements ScopeResourceResolver {
  constructor(
    private readonly db: () => Executor,
    private readonly fallback: ScopeResourceResolver,
  ) {}

  resolveScope(
    type: ScopeType,
    referenceId: string,
    at: Date,
    context: Readonly<{ correlationId?: string }>,
  ): Promise<ScopeResolution> {
    return this.fallback.resolveScope(type, referenceId, at, context);
  }

  async resolveResource(
    resourceId: string,
    at: Date,
    context: Readonly<{ correlationId?: string }>,
  ): Promise<ResourceResolution> {
    if (!uuid.test(resourceId)) return { status: "MISSING" };
    let placement;
    try {
      placement = await findCandidateRecordPlacement(
        currentAuthorizationExecutor<Executor>() ?? this.db(),
        resourceId,
      );
    } catch {
      return { status: "UNAVAILABLE" };
    }
    if (!placement)
      return this.fallback.resolveResource(resourceId, at, context);
    return {
      status: "FOUND",
      placement: Object.freeze({
        organizationId: placement.organizationId,
        branchId: placement.branchId,
        teamId: placement.teamId,
        assignmentSetIds: [],
        recordGroupIds: [],
        recordedAt: placement.recordedAt,
        subjectAccountIds: [...placement.subjectAccountIds],
      }),
    };
  }

  hasRelationship(
    actorAccountId: string,
    resourceId: string,
    relationship: ParticipantRelationship,
    at: Date,
    context: Readonly<{ correlationId?: string }>,
  ): Promise<boolean> {
    return this.fallback.hasRelationship(
      actorAccountId,
      resourceId,
      relationship,
      at,
      context,
    );
  }

  hasDesignation(
    actorAccountId: string,
    designation: Designation,
    scope: ScopeDescriptor,
    at: Date,
    context: Readonly<{ correlationId?: string }>,
  ): Promise<boolean> {
    return this.fallback.hasDesignation(
      actorAccountId,
      designation,
      scope,
      at,
      context,
    );
  }
}

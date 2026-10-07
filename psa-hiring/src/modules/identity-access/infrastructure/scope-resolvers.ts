import type {
  CandidateOwnershipResolver,
  ResolverContext,
  ResourceResolution,
  ScopeResolution,
  ScopeResourceResolver,
} from "../application/ports/scope-resource-resolver";
import {
  isUuid,
  type Designation,
  type ParticipantRelationship,
  type ScopeType,
  type SensitivityLevel,
} from "../domain/authorization-vocabulary";
import type {
  ResourcePlacement,
  ScopeDescriptor,
} from "../domain/scope-policy";

// Scope/ownership resolver adapters (packet M1.4 §10.2, ADR-0005).
//
// UnavailableScopeResolver / UnavailableCandidateOwnership are the runtime
// defaults: the backing organization, assignment-set, audit-assignment, and
// candidacy modules do not exist before M2, so every scoped or candidate
// business decision fails closed and no assignment with an unresolvable
// reference can be persisted.
//
// SyntheticScopeResolver / SyntheticCandidateOwnership are deterministic,
// in-memory adapters for tests. Their constructors throw unless APP_ENV is
// exactly "test", so they can never operate in local, staging, or
// production configuration.

export class UnavailableScopeResolver implements ScopeResourceResolver {
  async resolveScope(): Promise<ScopeResolution> {
    return { status: "UNAVAILABLE" };
  }
  async resolveResource(): Promise<ResourceResolution> {
    return { status: "UNAVAILABLE" };
  }
  async hasRelationship(): Promise<boolean> {
    return false;
  }
  async hasDesignation(): Promise<boolean> {
    return false;
  }
}

export class UnavailableCandidateOwnership implements CandidateOwnershipResolver {
  async owns(): Promise<"UNAVAILABLE"> {
    return "UNAVAILABLE";
  }
}

function requireTestEnvironment(appEnv: string | undefined, what: string) {
  if (appEnv !== "test") {
    throw new Error(`the ${what} is available only when APP_ENV is test`);
  }
}

type Node =
  | Readonly<{ type: "ORGANIZATION"; active: boolean }>
  | Readonly<{ type: "BRANCH"; organizationId: string; active: boolean }>
  | Readonly<{
      type: "TEAM";
      organizationId: string;
      branchId: string;
      active: boolean;
    }>
  | Readonly<{
      type: "ASSIGNED_RECORDS";
      organizationId: string;
      active: boolean;
    }>
  | Readonly<{
      type: "AUDIT_ASSIGNMENT";
      organizationId: string;
      auditorAccountId: string;
      categories: readonly SensitivityLevel[];
      recordGroupIds: readonly string[];
      recordsFrom: Date;
      recordsTo: Date;
      startsAt: Date;
      endsAt: Date;
      active: boolean;
    }>;

/** Deterministic synthetic hierarchy for tests (APP_ENV=test only). */
export class SyntheticScopeResolver implements ScopeResourceResolver {
  private readonly nodes = new Map<string, Node>();
  private readonly records = new Map<string, ResourcePlacement>();
  private readonly relationships = new Set<string>();
  private readonly designations = new Set<string>();
  /** Simulates the backing module being down. */
  unavailable = false;

  constructor(appEnv: string | undefined) {
    requireTestEnvironment(appEnv, "synthetic scope resolver");
  }

  private add(id: string, node: Node) {
    if (!isUuid(id)) throw new Error("synthetic scope IDs must be UUIDs");
    if (this.nodes.has(id) || this.records.has(id)) {
      throw new Error("synthetic scope ID already registered");
    }
    this.nodes.set(id, node);
    return this;
  }

  private node<T extends Node["type"]>(id: string, type: T) {
    const node = this.nodes.get(id);
    if (!node || node.type !== type) {
      throw new Error(`unknown synthetic ${type.toLowerCase()}`);
    }
    return node as Extract<Node, { type: T }>;
  }

  addOrganization(id: string) {
    return this.add(id, { type: "ORGANIZATION", active: true });
  }

  addBranch(id: string, organizationId: string) {
    this.node(organizationId, "ORGANIZATION");
    return this.add(id, { type: "BRANCH", organizationId, active: true });
  }

  /** Rejects a team whose stated organization differs from its branch's. */
  addTeam(id: string, branchId: string, organizationId?: string) {
    const branch = this.node(branchId, "BRANCH");
    if (organizationId && organizationId !== branch.organizationId) {
      throw new Error("cross-organization parentage rejected");
    }
    return this.add(id, {
      type: "TEAM",
      organizationId: branch.organizationId,
      branchId,
      active: true,
    });
  }

  addAssignmentSet(id: string, organizationId: string) {
    this.node(organizationId, "ORGANIZATION");
    return this.add(id, {
      type: "ASSIGNED_RECORDS",
      organizationId,
      active: true,
    });
  }

  addAuditAssignment(
    id: string,
    audit: Readonly<{
      organizationId: string;
      auditorAccountId: string;
      categories: readonly SensitivityLevel[];
      recordGroupIds: readonly string[];
      recordsFrom: Date;
      recordsTo: Date;
      startsAt: Date;
      endsAt: Date;
    }>,
  ) {
    this.node(audit.organizationId, "ORGANIZATION");
    return this.add(id, { type: "AUDIT_ASSIGNMENT", ...audit, active: true });
  }

  /** Registers a record; its team/branch/org chain must be consistent. */
  addRecord(
    id: string,
    record: Readonly<{
      organizationId: string;
      branchId?: string;
      teamId?: string;
      assignmentSetIds?: readonly string[];
      recordGroupIds?: readonly string[];
      recordedAt?: Date;
      subjectAccountIds?: readonly string[];
    }>,
  ) {
    if (!isUuid(id) || this.nodes.has(id) || this.records.has(id)) {
      throw new Error("invalid synthetic record ID");
    }
    this.node(record.organizationId, "ORGANIZATION");
    if (record.branchId) {
      const branch = this.node(record.branchId, "BRANCH");
      if (branch.organizationId !== record.organizationId) {
        throw new Error("cross-organization parentage rejected");
      }
    }
    if (record.teamId) {
      const team = this.node(record.teamId, "TEAM");
      if (team.branchId !== record.branchId) {
        throw new Error("cross-branch parentage rejected");
      }
    }
    for (const set of record.assignmentSetIds ?? []) {
      if (
        this.node(set, "ASSIGNED_RECORDS").organizationId !==
        record.organizationId
      ) {
        throw new Error("cross-organization assignment set rejected");
      }
    }
    this.records.set(
      id,
      Object.freeze({
        organizationId: record.organizationId,
        branchId: record.branchId ?? null,
        teamId: record.teamId ?? null,
        assignmentSetIds: Object.freeze([...(record.assignmentSetIds ?? [])]),
        recordGroupIds: Object.freeze([...(record.recordGroupIds ?? [])]),
        recordedAt: record.recordedAt ?? null,
        subjectAccountIds: Object.freeze([...(record.subjectAccountIds ?? [])]),
      }),
    );
    return this;
  }

  deactivate(id: string) {
    const node = this.nodes.get(id);
    if (!node) throw new Error("unknown synthetic scope");
    this.nodes.set(id, { ...node, active: false });
    return this;
  }

  addRelationship(
    actorAccountId: string,
    recordId: string,
    relationship: ParticipantRelationship,
  ) {
    this.relationships.add(`${actorAccountId}|${recordId}|${relationship}`);
    return this;
  }

  addDesignation(
    actorAccountId: string,
    designation: Designation,
    scopeId: string,
  ) {
    this.designations.add(`${actorAccountId}|${designation}|${scopeId}`);
    return this;
  }

  async resolveScope(
    type: ScopeType,
    referenceId: string,
    at: Date,
    context: ResolverContext,
  ): Promise<ScopeResolution> {
    void context;
    if (this.unavailable) return { status: "UNAVAILABLE" };
    const node = this.nodes.get(referenceId);
    if (!node) return { status: "MISSING" };
    if (node.type !== type) return { status: "TYPE_MISMATCH" };
    if (!node.active || !this.ancestryActive(node))
      return { status: "INACTIVE" };
    if (
      node.type === "AUDIT_ASSIGNMENT" &&
      !(
        node.startsAt.getTime() <= at.getTime() &&
        at.getTime() < node.endsAt.getTime()
      )
    ) {
      return { status: "INACTIVE" };
    }
    return { status: "ACTIVE", descriptor: this.describe(referenceId, node) };
  }

  async resolveResource(
    resourceId: string,
    at: Date,
    context: ResolverContext,
  ): Promise<ResourceResolution> {
    void at;
    void context;
    if (this.unavailable) return { status: "UNAVAILABLE" };
    const placement = this.records.get(resourceId);
    return placement ? { status: "FOUND", placement } : { status: "MISSING" };
  }

  async hasRelationship(
    actorAccountId: string,
    resourceId: string,
    relationship: ParticipantRelationship,
  ): Promise<boolean> {
    return (
      !this.unavailable &&
      this.relationships.has(`${actorAccountId}|${resourceId}|${relationship}`)
    );
  }

  async hasDesignation(
    actorAccountId: string,
    designation: Designation,
    scope: ScopeDescriptor,
  ): Promise<boolean> {
    return (
      !this.unavailable &&
      this.designations.has(`${actorAccountId}|${designation}|${scope.id}`)
    );
  }

  private ancestryActive(node: Node): boolean {
    const parents: string[] = [];
    if (node.type !== "ORGANIZATION") parents.push(node.organizationId);
    if (node.type === "TEAM") parents.push(node.branchId);
    return parents.every((id) => this.nodes.get(id)?.active === true);
  }

  private describe(id: string, node: Node): ScopeDescriptor {
    switch (node.type) {
      case "ORGANIZATION":
        return { type: "ORGANIZATION", id, organizationId: id };
      case "BRANCH":
        return { type: "BRANCH", id, organizationId: node.organizationId };
      case "TEAM":
        return {
          type: "TEAM",
          id,
          organizationId: node.organizationId,
          branchId: node.branchId,
        };
      case "ASSIGNED_RECORDS":
        return {
          type: "ASSIGNED_RECORDS",
          id,
          organizationId: node.organizationId,
        };
      case "AUDIT_ASSIGNMENT":
        return {
          type: "AUDIT_ASSIGNMENT",
          id,
          organizationId: node.organizationId,
          auditorAccountId: node.auditorAccountId,
          categories: node.categories,
          recordGroupIds: node.recordGroupIds,
          recordsFrom: node.recordsFrom,
          recordsTo: node.recordsTo,
        };
    }
  }
}

/** Deterministic candidate ownership for tests (APP_ENV=test only). */
export class SyntheticCandidateOwnership implements CandidateOwnershipResolver {
  private readonly owned = new Set<string>();

  constructor(appEnv: string | undefined) {
    requireTestEnvironment(appEnv, "synthetic candidate ownership resolver");
  }

  addOwnership(accountId: string, resourceId: string) {
    this.owned.add(`${accountId}|${resourceId}`);
    return this;
  }

  async owns(
    accountId: string,
    resourceId: string,
  ): Promise<"OWNER" | "NOT_OWNER"> {
    return this.owned.has(`${accountId}|${resourceId}`) ? "OWNER" : "NOT_OWNER";
  }
}

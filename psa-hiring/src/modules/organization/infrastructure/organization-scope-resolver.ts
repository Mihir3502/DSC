import "server-only";
import type {
  ResourceResolution,
  ScopeResolution,
  ScopeResourceResolver,
} from "@/modules/identity-access/application/ports/scope-resource-resolver";
import type { ScopeType } from "@/modules/identity-access/domain/authorization-vocabulary";
import { isUuid } from "../domain/values";
import {
  findPlacement,
  findScopeEntity,
  type Executor,
} from "./organization-repository";

// Real organization/branch/team adapter for the M1 scope-resolution port
// (packet M2.1 §9, ADR-0005 M2.1 note). Reads only server-owned rows by
// opaque ID; nothing from the browser, session, or request body.
//
// - ORGANIZATION / BRANCH / TEAM resolve ACTIVE only when the entity and
//   every ancestor are ACTIVE; DRAFT/INACTIVE/ARCHIVED (or an inactive
//   ancestor) resolve INACTIVE, a missing row MISSING, and an ID of another
//   hierarchy type TYPE_MISMATCH. Composite foreign keys guarantee the
//   returned ancestry is coherent.
// - Organization-module records (hierarchy rows, positions, description
//   versions, hiring cycles) resolve to their placement, historical rows
//   included, so reads of past configuration stay authorizable.
// - ASSIGNED_RECORDS and AUDIT_ASSIGNMENT have no backing tables yet and
//   resolve UNAVAILABLE; relationships and designations are false. No row
//   is ever fabricated for an unresolved reference.
// - Any database failure resolves UNAVAILABLE (fail closed).

export class OrganizationScopeResolver implements ScopeResourceResolver {
  constructor(private readonly db: () => Executor) {}

  async resolveScope(
    type: ScopeType,
    referenceId: string,
  ): Promise<ScopeResolution> {
    if (type !== "ORGANIZATION" && type !== "BRANCH" && type !== "TEAM") {
      return { status: "UNAVAILABLE" };
    }
    if (!isUuid(referenceId)) return { status: "MISSING" };
    let entity;
    try {
      entity = await findScopeEntity(this.db(), referenceId);
    } catch {
      return { status: "UNAVAILABLE" };
    }
    if (!entity) return { status: "MISSING" };
    if (entity.type !== type) return { status: "TYPE_MISMATCH" };
    if (!entity.active) return { status: "INACTIVE" };
    switch (entity.type) {
      case "ORGANIZATION":
        return {
          status: "ACTIVE",
          descriptor: {
            type: "ORGANIZATION",
            id: entity.id,
            organizationId: entity.id,
          },
        };
      case "BRANCH":
        return {
          status: "ACTIVE",
          descriptor: {
            type: "BRANCH",
            id: entity.id,
            organizationId: entity.organizationId,
          },
        };
      case "TEAM":
        return {
          status: "ACTIVE",
          descriptor: {
            type: "TEAM",
            id: entity.id,
            organizationId: entity.organizationId,
            branchId: entity.branchId,
          },
        };
    }
  }

  async resolveResource(resourceId: string): Promise<ResourceResolution> {
    if (!isUuid(resourceId)) return { status: "MISSING" };
    let placement;
    try {
      placement = await findPlacement(this.db(), resourceId);
    } catch {
      return { status: "UNAVAILABLE" };
    }
    if (!placement) return { status: "MISSING" };
    return {
      status: "FOUND",
      placement: Object.freeze({
        organizationId: placement.organizationId,
        branchId: placement.branchId,
        teamId: placement.teamId,
        assignmentSetIds: [],
        recordGroupIds: [],
        recordedAt: placement.recordedAt,
        subjectAccountIds: [],
      }),
    };
  }

  async hasRelationship(): Promise<boolean> {
    return false;
  }

  async hasDesignation(): Promise<boolean> {
    return false;
  }
}
